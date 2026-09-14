from datetime import date

import pytest

from app.models import Plan, PlanError, Task
from app.scheduler import schedule_plan


def T(id, duration=1, preds=None, **kw):
    return Task(id=id, name=id.title(), duration_days=duration, predecessors=preds or [], **kw)


def test_chain_dates_follow_dependencies():
    plan = Plan(
        project_start=date(2026, 3, 2),
        tasks=[T("a", 3), T("b", 2, ["a"]), T("c", 1, ["b"])],
    )
    s = schedule_plan(plan)
    by_id = {t.id: t for t in s.tasks}

    # 3-day task starting Mar 2 occupies Mar 2..4 inclusive
    assert (by_id["a"].start, by_id["a"].end) == (date(2026, 3, 2), date(2026, 3, 4))
    # successor starts the next day
    assert (by_id["b"].start, by_id["b"].end) == (date(2026, 3, 5), date(2026, 3, 6))
    assert (by_id["c"].start, by_id["c"].end) == (date(2026, 3, 7), date(2026, 3, 7))
    assert s.project_end == date(2026, 3, 7)


def test_parallel_branches_join_on_latest_predecessor():
    plan = Plan(
        project_start=date(2026, 1, 1),
        tasks=[T("a", 2), T("b", 5), T("join", 1, ["a", "b"])],
    )
    by_id = {t.id: t for t in schedule_plan(plan).tasks}
    assert by_id["join"].start == date(2026, 1, 6)  # after b (Jan 1..5)


def test_critical_path_and_slack():
    plan = Plan(
        project_start=date(2026, 1, 1),
        tasks=[T("a", 2), T("short", 1, ["a"]), T("long", 4, ["a"]), T("end", 1, ["short", "long"])],
    )
    by_id = {t.id: t for t in schedule_plan(plan).tasks}
    assert by_id["a"].is_critical and by_id["long"].is_critical and by_id["end"].is_critical
    assert not by_id["short"].is_critical
    assert by_id["short"].slack_days == 3
    assert by_id["long"].slack_days == 0


def test_pin_pushes_task_later_and_drags_successors():
    plan = Plan(
        project_start=date(2026, 1, 1),
        tasks=[
            T("a", 1),
            T("b", 2, ["a"], start_no_earlier_than=date(2026, 1, 10)),
            T("c", 1, ["b"]),
        ],
    )
    by_id = {t.id: t for t in schedule_plan(plan).tasks}
    assert by_id["b"].start == date(2026, 1, 10)
    assert by_id["b"].is_pinned
    assert by_id["c"].start == date(2026, 1, 12)


def test_pin_earlier_than_dependencies_is_clamped_with_warning():
    plan = Plan(
        project_start=date(2026, 1, 1),
        tasks=[T("a", 5), T("b", 1, ["a"], start_no_earlier_than=date(2026, 1, 2))],
    )
    s = schedule_plan(plan)
    by_id = {t.id: t for t in s.tasks}
    assert by_id["b"].start == date(2026, 1, 6)  # dependency wins
    assert any("b" in w for w in s.warnings)


def test_cycle_is_reported_with_the_tasks_involved():
    plan = Plan(
        project_start=date(2026, 1, 1),
        tasks=[T("a", 1, ["c"]), T("b", 1, ["a"]), T("c", 1, ["b"])],
    )
    with pytest.raises(PlanError) as err:
        schedule_plan(plan)
    assert "cycle" in str(err.value).lower()
    assert {"a", "b", "c"} <= set(err.value.details)


def test_unknown_predecessor_is_reported():
    plan = Plan(project_start=date(2026, 1, 1), tasks=[T("a", 1, ["ghost"])])
    with pytest.raises(PlanError) as err:
        schedule_plan(plan)
    assert "ghost" in err.value.details[0]


def test_self_dependency_is_reported_as_cycle():
    plan = Plan(project_start=date(2026, 1, 1), tasks=[T("a", 1, ["a"])])
    with pytest.raises(PlanError):
        schedule_plan(plan)


def test_empty_plan_schedules_to_nothing():
    s = schedule_plan(Plan(project_start=date(2026, 1, 1), tasks=[]))
    assert s.tasks == []
    assert s.project_end is None
