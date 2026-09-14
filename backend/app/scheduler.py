"""Critical Path Method scheduler.

Turns a `Plan` (durations + dependencies) into a `Schedule` (concrete dates,
slack, critical path). Days are *calendar* days -- a deliberate simplification,
see docs/ROADMAP_TO_PRODUCTION.md.

Conventions:
  * a task of duration N starting on day D occupies D .. D+N-1 inclusive;
  * a successor starts the day after its latest predecessor finishes.
"""

from __future__ import annotations

from datetime import date, timedelta

from .models import Plan, PlanError, Schedule, ScheduledTask, Task

_DAY = timedelta(days=1)


def _validate(plan: Plan) -> None:
    ids: set[str] = set()
    duplicates: list[str] = []
    for t in plan.tasks:
        if t.id in ids:
            duplicates.append(t.id)
        ids.add(t.id)
    if duplicates:
        raise PlanError(
            "Duplicate task ids", [f"id '{d}' appears more than once" for d in duplicates]
        )

    unknown = [
        f"task '{t.id}' depends on unknown task '{p}'"
        for t in plan.tasks
        for p in t.predecessors
        if p not in ids
    ]
    if unknown:
        raise PlanError("Unknown predecessors", unknown)


def _topological_order(tasks: list[Task]) -> list[Task]:
    """Kahn's algorithm; raises PlanError naming every task stuck in a cycle."""
    by_id = {t.id: t for t in tasks}
    remaining = {t.id: set(t.predecessors) for t in tasks}
    order: list[Task] = []

    while remaining:
        ready = sorted(tid for tid, preds in remaining.items() if not preds)
        if not ready:
            raise PlanError(
                "Dependency cycle detected — the plan cannot be scheduled",
                sorted(remaining),
            )
        for tid in ready:
            order.append(by_id[tid])
            del remaining[tid]
        for preds in remaining.values():
            preds.difference_update(ready)

    return order


def schedule_plan(plan: Plan) -> Schedule:
    """Forward pass for dates, backward pass for slack and the critical path."""
    _validate(plan)
    ordered = _topological_order(plan.tasks)
    warnings: list[str] = []

    start: dict[str, date] = {}
    end: dict[str, date] = {}

    for task in ordered:
        earliest = plan.project_start
        for pred in task.predecessors:
            earliest = max(earliest, end[pred] + _DAY)
        if task.start_no_earlier_than:
            if task.start_no_earlier_than < earliest:
                warnings.append(
                    f"Task '{task.id}' is pinned to {task.start_no_earlier_than.isoformat()} "
                    f"but its predecessors push it to {earliest.isoformat()}; "
                    "the dependency wins."
                )
            else:
                earliest = task.start_no_earlier_than
        start[task.id] = earliest
        end[task.id] = earliest + timedelta(days=task.duration_days - 1)

    if not ordered:
        return Schedule(project_start=plan.project_start, tasks=[], warnings=warnings)

    project_end = max(end.values())

    # Backward pass: latest finish that keeps the project end date.
    successors: dict[str, list[str]] = {t.id: [] for t in plan.tasks}
    for t in plan.tasks:
        for pred in t.predecessors:
            successors[pred].append(t.id)

    latest_finish: dict[str, date] = {}
    for task in reversed(ordered):
        succs = successors[task.id]
        latest_finish[task.id] = (
            project_end
            if not succs
            else min(latest_finish[s] - timedelta(days=by_duration(plan, s)) for s in succs)
        )

    scheduled = [
        ScheduledTask(
            id=t.id,
            name=t.name,
            description=t.description,
            assignee=t.assignee,
            duration_days=t.duration_days,
            predecessors=list(t.predecessors),
            progress=t.progress,
            status=t.status,
            start=start[t.id],
            end=end[t.id],
            slack_days=(latest_finish[t.id] - end[t.id]).days,
            is_critical=(latest_finish[t.id] - end[t.id]).days == 0,
            is_pinned=t.start_no_earlier_than is not None,
        )
        for t in plan.tasks
    ]

    return Schedule(
        project_start=plan.project_start,
        project_end=project_end,
        tasks=scheduled,
        warnings=warnings,
    )


def by_duration(plan: Plan, task_id: str) -> int:
    """Duration of `task_id`, used to walk a successor's latest start backwards."""
    task = plan.task_by_id(task_id)
    if task is None:  # pragma: no cover - _validate already guarantees this
        raise PlanError("Unknown task", [task_id])
    return task.duration_days
