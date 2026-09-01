"""API-level tests, including a full chat turn driven by a fake LLM.

The chat test is the important one: it exercises SSE → agent loop → MCP
subprocess → ops → store with everything real except the model itself.
"""

from __future__ import annotations

import io
import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app import main
from app.agent import loop as agent_loop

client = TestClient(main.app)


@pytest.fixture
def sid() -> str:
    return f"api-{uuid.uuid4().hex[:8]}"


def sse_events(response) -> list[dict[str, Any]]:
    events = []
    for line in response.text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: ") :]))
    return events


def xlsx(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(["задача", "описание", "исполнитель", "длительность", "предшественники"])
    for row in rows:
        ws.append(list(row))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_health_reports_llm_configuration():
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert "llm_configured" in body


def test_plan_is_seeded_on_first_request(sid):
    body = client.get("/api/plan", params={"session_id": sid}).json()
    assert len(body["plan"]["tasks"]) > 10
    assert body["schedule"]["project_end"]
    assert any(t["is_critical"] for t in body["schedule"]["tasks"])


def test_import_replaces_the_plan_and_resolves_names(sid):
    files = {"file": ("plan.xlsx", xlsx([("A", "", "Ann", 2, ""), ("B", "", "Bob", 3, "A")]), "application/vnd.ms-excel")}
    body = client.post("/api/plan/import", params={"session_id": sid, "project_start": "2026-02-02"}, files=files).json()
    assert [t["name"] for t in body["plan"]["tasks"]] == ["A", "B"]
    assert body["schedule"]["tasks"][1]["start"] == "2026-02-04"


def test_import_rejects_a_broken_file_with_row_details(sid):
    files = {"file": ("plan.xlsx", xlsx([("A", "", "", 1, "Ghost")]), "application/vnd.ms-excel")}
    response = client.post("/api/plan/import", params={"session_id": sid}, files=files)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Ghost" in detail["details"][0]


def test_export_returns_an_xlsx_attachment(sid):
    client.get("/api/plan", params={"session_id": sid})
    response = client.get("/api/plan/export", params={"session_id": sid})
    assert response.status_code == 200
    assert response.content[:2] == b"PK"  # xlsx is a zip
    assert "attachment" in response.headers["content-disposition"]


def test_task_crud_and_undo(sid):
    client.get("/api/plan", params={"session_id": sid})

    created = client.post(
        "/api/plan/tasks",
        params={"session_id": sid},
        json={"name": "Аудит качества", "duration_days": 5, "assignee": "Иванов", "predecessors": ["dossier"]},
    )
    assert created.status_code == 200, created.text
    new_id = created.json()["plan"]["tasks"][-1]["id"]

    patched = client.patch(
        f"/api/plan/tasks/{new_id}",
        params={"session_id": sid},
        json={"duration_days": 8, "assignee": "Петрова"},
    )
    assert patched.status_code == 200
    task = next(t for t in patched.json()["plan"]["tasks"] if t["id"] == new_id)
    assert task["duration_days"] == 8 and task["assignee"] == "Петрова"
    assert new_id in patched.json()["changed"]

    undone = client.post("/api/plan/undo", params={"session_id": sid}).json()
    task = next(t for t in undone["plan"]["tasks"] if t["id"] == new_id)
    assert task["duration_days"] == 5  # back before the patch

    deleted = client.delete(f"/api/plan/tasks/{new_id}", params={"session_id": sid})
    assert deleted.status_code == 200
    assert all(t["id"] != new_id for t in deleted.json()["plan"]["tasks"])


def test_drag_pins_a_task_and_unpin_releases_it(sid):
    client.get("/api/plan", params={"session_id": sid})
    pinned = client.patch(
        "/api/plan/tasks/analytics", params={"session_id": sid}, json={"start": "2026-12-01"}
    ).json()
    task = next(t for t in pinned["plan"]["tasks"] if t["id"] == "analytics")
    assert task["start_no_earlier_than"] == "2026-12-01"

    released = client.patch(
        "/api/plan/tasks/analytics", params={"session_id": sid}, json={"unpin": True}
    ).json()
    task = next(t for t in released["plan"]["tasks"] if t["id"] == "analytics")
    assert task["start_no_earlier_than"] is None


def test_patch_rejects_a_cycle(sid):
    client.get("/api/plan", params={"session_id": sid})
    response = client.patch(
        "/api/plan/tasks/cell-line", params={"session_id": sid}, json={"predecessors": ["upstream"]}
    )
    assert response.status_code == 400
    assert "цикл" in response.json()["detail"]["message"].lower()


def test_reset_restores_the_demo_plan(sid):
    client.delete("/api/plan/tasks/launch-prep", params={"session_id": sid})
    body = client.post("/api/plan/reset", params={"session_id": sid}).json()
    assert any(t["id"] == "launch-prep" for t in body["plan"]["tasks"])
    assert len(body["history"]) == 1


class FakeLLM:
    """Two-step model: first a tool call, then a summary."""

    def __init__(self) -> None:
        self.calls: list[list[dict[str, Any]]] = []

    async def complete(self, messages, tools):
        self.calls.append(messages)
        assert any(t["function"]["name"] == "reassign_tasks" for t in tools)
        if len(self.calls) == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "reassign_tasks",
                            "arguments": json.dumps(
                                {"to_assignee": "Иванов И.", "from_assignee": "Егорова М."}
                            ),
                        },
                    }
                ],
            }
        return {"role": "assistant", "content": "Переназначил задачи Егоровой на Иванова."}


def test_chat_turn_streams_tool_calls_and_the_updated_plan(sid, monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", lambda *a, **kw: fake)
    main.store.clear_chat(sid)
    client.get("/api/plan", params={"session_id": sid})

    with client.stream(
        "POST",
        "/api/chat",
        json={"message": "переназначь все задачи Егоровой на Иванова И.", "session_id": sid},
    ) as response:
        assert response.status_code == 200
        response.read()
        events = sse_events(response)

    kinds = [e["type"] for e in events]
    assert kinds.count("tool_call") == 1
    assert "tool_result" in kinds and "plan" in kinds and kinds[-1] == "done"

    tool_result = next(e for e in events if e["type"] == "tool_result")
    assert tool_result["ok"] is True

    plan_event = next(e for e in events if e["type"] == "plan")
    assignees = {t["assignee"] for t in plan_event["plan"]["tasks"]}
    assert "Иванов И." in assignees and "Егорова М." not in assignees
    assert plan_event["changed"], "the chart needs to know which bars moved"

    # the edit is persisted, not just streamed
    stored = client.get("/api/plan", params={"session_id": sid}).json()
    assert "Иванов И." in {t["assignee"] for t in stored["plan"]["tasks"]}
    # and the system prompt carried the plan so the model needn't ask for it
    assert "Текущий план" in fake.calls[0][0]["content"]


def test_chat_reports_a_failing_tool_without_breaking_the_stream(sid, monkeypatch):
    class BadToolLLM:
        def __init__(self) -> None:
            self.step = 0

        async def complete(self, messages, tools):
            self.step += 1
            if self.step == 1:
                return {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {
                                "name": "shift_task",
                                "arguments": json.dumps({"task": "Несуществующая", "days": 3}),
                            },
                        }
                    ],
                }
            return {"role": "assistant", "content": "Такой задачи в плане нет."}

    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", lambda *a, **kw: BadToolLLM())
    main.store.clear_chat(sid)
    client.get("/api/plan", params={"session_id": sid})

    with client.stream(
        "POST", "/api/chat", json={"message": "сдвинь несуществующую", "session_id": sid}
    ) as response:
        response.read()
        events = sse_events(response)

    tool_result = next(e for e in events if e["type"] == "tool_result")
    assert tool_result["ok"] is False and "ОШИБКА" in tool_result["text"]
    assert events[-1]["type"] == "done"


def test_chat_surfaces_a_missing_api_key_as_an_error_event(sid, monkeypatch):
    from app.agent.llm import LLMError

    class DeadLLM:
        async def complete(self, messages, tools):
            raise LLMError("LLM не настроен: задайте OPENROUTER_API_KEY")

    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", lambda *a, **kw: DeadLLM())
    main.store.clear_chat(sid)

    with client.stream(
        "POST", "/api/chat", json={"message": "привет", "session_id": sid}
    ) as response:
        response.read()
        events = sse_events(response)

    error = next(e for e in events if e["type"] == "error")
    assert "OPENROUTER_API_KEY" in error["text"]


def test_import_takes_the_plan_title_from_the_file(sid):
    files = {"file": ("Портфель 2027.xlsx", xlsx([("A", "", "Ann", 2, "")]), "application/vnd.ms-excel")}
    body = client.post("/api/plan/import", params={"session_id": sid}, files=files).json()
    assert body["plan"]["title"] == "Портфель 2027"


def test_exported_file_round_trips_its_title_and_start(sid):
    client.post("/api/plan/reset", params={"session_id": sid})
    blob = client.get("/api/plan/export", params={"session_id": sid}).content
    files = {"file": ("re-imported.xlsx", blob, "application/vnd.ms-excel")}
    body = client.post("/api/plan/import", params={"session_id": sid}, files=files).json()
    assert body["plan"]["title"] == "Выведение биоаналога на рынок"
    assert body["plan"]["project_start"] == "2026-09-01"
    assert len(body["plan"]["tasks"]) == 17


def test_models_endpoint_lists_the_default_first():
    body = client.get("/api/models").json()
    assert body["models"][0]["id"] == body["default"]
    ids = [m["id"] for m in body["models"]]
    assert len(ids) == len(set(ids)), "модель не должна повторяться в списке"
    assert all(m["label"] and "/" not in m["label"] for m in body["models"])


def test_chat_rejects_a_model_outside_the_whitelist(sid):
    response = client.post(
        "/api/chat",
        json={"message": "привет", "session_id": sid, "model": "evil/expensive-model"},
    )
    assert response.status_code == 400
    assert "не разрешена" in response.json()["detail"]["message"]


def test_chat_passes_the_selected_model_to_the_llm(sid, monkeypatch):
    from app.config import settings

    picked = settings.available_models[-1]
    captured: dict[str, object] = {}

    class RecordingLLM:
        def __init__(self, *args, **kwargs):
            captured.update(kwargs)

        async def complete(self, messages, tools):
            return {"role": "assistant", "content": "готово"}

    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", RecordingLLM)
    main.store.clear_chat(sid)

    with client.stream(
        "POST", "/api/chat", json={"message": "привет", "session_id": sid, "model": picked}
    ) as response:
        response.read()
        events = sse_events(response)

    assert captured.get("model") == picked
    assert events[-1]["type"] == "done" and events[-1]["model"] == picked


def test_reorder_endpoint_moves_the_row(sid):
    client.post("/api/plan/reset", params={"session_id": sid})
    body = client.post(
        "/api/plan/tasks/launch-prep/reorder",
        params={"session_id": sid},
        json={"before": "cell-line"},
    )
    assert body.status_code == 200, body.text
    assert [t["id"] for t in body.json()["plan"]["tasks"]][:2] == ["launch-prep", "cell-line"]
    # даты не поехали от смены порядка строк
    assert body.json()["schedule"]["project_end"] == "2027-06-22"


def test_reorder_endpoint_rejects_unknown_anchor(sid):
    client.get("/api/plan", params={"session_id": sid})
    response = client.post(
        "/api/plan/tasks/dossier/reorder", params={"session_id": sid}, json={"after": "нет-такой"}
    )
    assert response.status_code == 400


def test_chat_history_survives_and_groups_tool_calls(sid, monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", lambda *a, **kw: fake)
    client.get("/api/plan", params={"session_id": sid})
    assert client.get("/api/chat/history", params={"session_id": sid}).json()["entries"] == []

    with client.stream(
        "POST",
        "/api/chat",
        json={"message": "переназначь задачи Егоровой М. на Иванова И.", "session_id": sid},
    ) as response:
        response.read()

    entries = client.get("/api/chat/history", params={"session_id": sid}).json()["entries"]
    # один ход агента — одна карточка, как в живом стриме
    assert [e["role"] for e in entries] == ["user", "agent"]
    assert entries[0]["text"].startswith("переназначь")
    # вызов инструмента подклеен к ходу агента вместе с результатом
    call = entries[1]["tools"][0]
    assert call["name"] == "reassign_tasks"
    assert call["args"]["to_assignee"] == "Иванов И."
    assert call["ok"] is True and "Переназначено" in call["result"]
    assert entries[1]["text"].startswith("Переназначил")


def test_chat_history_is_cleared_on_demand(sid, monkeypatch):
    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", lambda *a, **kw: FakeLLM())
    client.get("/api/plan", params={"session_id": sid})
    with client.stream("POST", "/api/chat", json={"message": "привет", "session_id": sid}) as r:
        r.read()
    assert client.get("/api/chat/history", params={"session_id": sid}).json()["entries"]

    client.post("/api/chat/clear", params={"session_id": sid})
    assert client.get("/api/chat/history", params={"session_id": sid}).json()["entries"] == []


def test_agent_understands_a_task_number(sid, monkeypatch):
    """Пользователь пишет «#3», модель передаёт номер в инструмент как есть."""
    class NumberLLM:
        def __init__(self, *a, **kw):
            self.step = 0

        async def complete(self, messages, tools):
            self.step += 1
            if self.step == 1:
                assert "#3" in messages[0]["content"], "номера должны быть в промпте"
                return {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {
                                "name": "shift_task",
                                "arguments": json.dumps({"task": "#3", "days": 2}),
                            },
                        }
                    ],
                }
            return {"role": "assistant", "content": "сдвинул третью задачу"}

    monkeypatch.setattr(agent_loop, "OpenAICompatibleLLM", NumberLLM)
    client.post("/api/plan/reset", params={"session_id": sid})

    with client.stream(
        "POST", "/api/chat", json={"message": "сдвинь #3 на 2 дня", "session_id": sid}
    ) as response:
        response.read()
        events = sse_events(response)

    result = next(e for e in events if e["type"] == "tool_result")
    assert result["ok"] is True
    # третья задача демо-плана — «Отработка downstream-процесса»
    assert "downstream" in result["text"]


def test_patch_task_sets_status_and_successors(sid):
    client.post("/api/plan/reset", params={"session_id": sid})

    body = client.patch(
        "/api/plan/tasks/upstream",
        params={"session_id": sid},
        json={"status": "в работе", "assignee": "Егорова М.", "successors": ["stability"]},
    )
    assert body.status_code == 200, body.text
    plan = {t["id"]: t for t in body.json()["plan"]["tasks"]}
    assert plan["upstream"]["status"] == "in_progress"
    assert plan["upstream"]["assignee"] == "Егорова М."
    # связь хранится у зависимой задачи
    assert "upstream" in plan["stability"]["predecessors"]

    # статус «готова» подтягивает прогресс
    done = client.patch(
        "/api/plan/tasks/upstream", params={"session_id": sid}, json={"status": "done"}
    ).json()
    task = next(t for t in done["plan"]["tasks"] if t["id"] == "upstream")
    assert (task["status"], task["progress"]) == ("done", 100)


def test_patch_task_rejects_a_bad_status(sid):
    client.get("/api/plan", params={"session_id": sid})
    response = client.patch(
        "/api/plan/tasks/upstream", params={"session_id": sid}, json={"status": "почти"}
    )
    assert response.status_code == 400
    assert "статус" in response.json()["detail"]["message"].lower()


def test_plan_payload_lists_statuses_for_the_ui(sid):
    body = client.get("/api/plan", params={"session_id": sid}).json()
    values = [s["value"] for s in body["statuses"]]
    assert values == ["planned", "in_progress", "done", "blocked"]
    assert all(s["label"] for s in body["statuses"])


def test_template_endpoint_returns_the_demo_plan():
    response = client.get("/api/plan/template")
    assert response.status_code == 200
    assert "plan-template.xlsx" in response.headers["content-disposition"]

    from app.excel_io import plan_from_xlsx
    from app.seed import seed_plan

    seeded = seed_plan()
    parsed = plan_from_xlsx(response.content, project_start=seeded.project_start)
    assert [t.name for t in parsed.tasks] == [t.name for t in seeded.tasks]


def test_committed_template_file_matches_the_seed():
    """Копия в samples/ не должна разойтись с сидом.

    Если тест упал — перегенерируйте её: backend/scripts/make_example_xlsx.py
    """
    from pathlib import Path

    from app.excel_io import plan_from_xlsx
    from app.seed import seed_plan

    path = Path(__file__).resolve().parents[2] / "samples" / "plan_template.xlsx"
    assert path.exists(), "нет samples/plan_template.xlsx"

    seeded = seed_plan()
    committed = plan_from_xlsx(path.read_bytes(), project_start=seeded.project_start)
    assert [(t.id, t.name, t.duration_days, t.status) for t in committed.tasks] == [
        (t.id, t.name, t.duration_days, t.status) for t in seeded.tasks
    ]
    assert [t.predecessors for t in committed.tasks] == [t.predecessors for t in seeded.tasks]
