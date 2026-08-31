"""Integration test: spawn the real MCP server over stdio and drive it.

This is the test that proves MCP is wired end to end — a separate process, a
real handshake, real tool schemas, and edits that land in the shared store.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.agent.mcp_client import call_tool, list_tool_specs, plan_tools_session
from app.models import Plan, Task
from app.store import PlanStore

SESSION = "test-session"


@pytest.fixture
def store(tmp_path):
    db = tmp_path / "plans.sqlite3"
    store = PlanStore(db)
    store.reset(
        SESSION,
        Plan(
            project_start=date(2026, 3, 2),
            tasks=[
                Task(id="analiz", name="Анализ", assignee="Иванов", duration_days=3),
                Task(
                    id="dizayn",
                    name="Дизайн",
                    assignee="Петрова",
                    duration_days=2,
                    predecessors=["analiz"],
                ),
            ],
        ),
    )
    return store


async def test_tool_specs_are_exposed_in_openai_format(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        specs = await list_tool_specs(session)

    names = {s["function"]["name"] for s in specs}
    assert {"get_plan", "add_task", "shift_task", "reassign_tasks", "set_predecessors"} <= names
    for spec in specs:
        assert spec["function"]["description"]
        assert spec["function"]["parameters"]["type"] == "object"

    add = next(s for s in specs if s["function"]["name"] == "add_task")
    preds = add["function"]["parameters"]["properties"]["predecessors"]
    assert preds["type"] == "array"  # anyOf/null unions collapsed for the LLM


async def test_get_plan_reports_computed_dates(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        text = await call_tool(session, "get_plan", {})
    assert "2026-03-02" in text
    assert "Анализ" in text and "Дизайн" in text


async def test_add_task_persists_to_the_shared_store(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        message = await call_tool(
            session,
            "add_task",
            {"name": "Тесты", "duration_days": 4, "assignee": "Сидоров", "predecessors": ["Дизайн"]},
        )
    assert "Тесты" in message
    plan = store.get_plan(SESSION)
    added = plan.tasks[-1]
    assert added.name == "Тесты" and added.predecessors == ["dizayn"]


async def test_bulk_reassign_through_mcp(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        message = await call_tool(
            session, "reassign_tasks", {"to_assignee": "Кузнецов", "from_assignee": "Петрова"}
        )
    assert "Кузнецов" in message
    assert [t.assignee for t in store.get_plan(SESSION).tasks] == ["Иванов", "Кузнецов"]


async def test_invalid_edit_comes_back_as_a_readable_error(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        cycle = await call_tool(session, "set_predecessors", {"task": "analiz", "predecessors": ["Дизайн"]})
        missing = await call_tool(session, "shift_task", {"task": "Бюджет", "days": 3})

    assert cycle.startswith("ОШИБКА") and "цикл" in cycle.lower()
    assert missing.startswith("ОШИБКА") and "Бюджет" in missing
    # a rejected edit must not touch the plan
    assert store.get_plan(SESSION).tasks[0].predecessors == []


async def test_undo_returns_to_the_previous_snapshot(store):
    async with plan_tools_session(SESSION, store.db_path) as session:
        await call_tool(session, "shift_task", {"task": "Дизайн", "days": 5})
    assert store.get_plan(SESSION).task_by_id("dizayn").start_no_earlier_than is not None

    plan, label = store.undo(SESSION)
    assert plan is not None and "Откат" in label
    assert store.get_plan(SESSION).task_by_id("dizayn").start_no_earlier_than is None
