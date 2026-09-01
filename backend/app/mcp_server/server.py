"""MCP server exposing the plan as a set of editing tools.

Runs as its own process (stdio transport) and is spawned by the backend for each
chat turn; it can equally be pointed at from Claude Desktop, Cursor or any other
MCP client — see the README. State is shared with the API through the SQLite
plan store, keyed by the session id passed in `PLAN_SESSION_ID`.

Every tool is a thin wrapper: resolve arguments, call `app.ops`, persist a
snapshot, return a human-readable sentence. All the rules live in `ops.py`, so
the API and the agent can never diverge on what a valid plan is.
"""

from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Optional

from mcp.server.fastmcp import FastMCP

from .. import ops
from ..models import STATUS_LABELS, Plan
from ..scheduler import schedule_plan
from ..seed import seed_plan
from ..store import DEFAULT_DB_PATH, PlanStore

SESSION_ID = os.environ.get("PLAN_SESSION_ID", "default")
STORE = PlanStore(Path(os.environ.get("PLAN_DB_PATH", str(DEFAULT_DB_PATH))))

mcp = FastMCP("project-plan")


def _plan() -> Plan:
    return STORE.ensure_session(SESSION_ID, seed_plan())


def _apply(edit: Callable[[Plan], tuple[Plan, str]], label: str) -> str:
    """Run an edit against the current plan and persist it, or report why not."""
    try:
        new_plan, message = edit(_plan())
    except ops.OpError as exc:
        return f"ОШИБКА: {exc}"
    except Exception as exc:  # defensive: the agent must always get a usable reply
        return f"ОШИБКА: {type(exc).__name__}: {exc}"
    STORE.save_plan(SESSION_ID, new_plan, label)
    return message


def _parse_date(value: str) -> date:
    text = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ops.OpError(f"Дату «{value}» не удалось разобрать, нужен формат ГГГГ-ММ-ДД")


@mcp.tool()
def get_plan() -> str:
    """Вернуть весь план: задачи, исполнители, длительности, зависимости и рассчитанные даты.

    Вызывай, если нужно уточнить состояние плана перед правками или после них.
    """
    plan = _plan()
    schedule = schedule_plan(plan)
    names = {t.id: t.name for t in plan.tasks}
    lines = [
        f"Старт проекта: {schedule.project_start.isoformat()}; "
        f"окончание: {schedule.project_end.isoformat() if schedule.project_end else '—'}; "
        f"задач: {len(schedule.tasks)}",
        "Номер (#N) — позиция в списке, на него тоже можно ссылаться в аргументах.",
    ]
    for index, t in enumerate(schedule.tasks, start=1):
        preds = ", ".join(names.get(p, p) for p in t.predecessors) or "—"
        flags = [f"статус: {STATUS_LABELS[t.status]}"]
        if t.is_critical:
            flags.append("критический путь")
        if t.is_pinned:
            flags.append("дата закреплена")
        lines.append(
            f"- #{index} | {t.id} | {t.name} | исполнитель: {t.assignee or '—'} | {t.duration_days} дн. | "
            f"{t.start.isoformat()}..{t.end.isoformat()} | запас {t.slack_days} дн. | "
            f"предшественники: {preds}" + (f" | {'; '.join(flags)}" if flags else "")
        )
    for warning in schedule.warnings:
        lines.append(f"! {warning}")
    return "\n".join(lines)


@mcp.tool()
def list_assignees() -> str:
    """Вернуть список исполнителей с их загрузкой (число задач и суммарные дни)."""
    plan = _plan()
    stats: dict[str, tuple[int, int]] = {}
    for t in plan.tasks:
        who = t.assignee or "не назначен"
        count, days = stats.get(who, (0, 0))
        stats[who] = (count + 1, days + t.duration_days)
    return "\n".join(
        f"- {who}: задач {count}, суммарно {days} дн."
        for who, (count, days) in sorted(stats.items(), key=lambda kv: -kv[1][1])
    )


@mcp.tool()
def add_task(
    name: str,
    duration_days: int = 1,
    description: str = "",
    assignee: str = "",
    predecessors: Optional[list[str]] = None,
    after: Optional[str] = None,
) -> str:
    """Добавить задачу в план.

    predecessors — список задач (id или названия), которые должны завершиться раньше.
    after — id/название задачи, после которой вставить новую в списке (порядок строк).
    """
    return _apply(
        lambda p: ops.add_task(
            p,
            name=name,
            duration_days=duration_days,
            description=description,
            assignee=assignee,
            predecessors=predecessors or [],
            after=after,
        ),
        f"добавлена задача «{name}»",
    )


@mcp.tool()
def update_task(
    task: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    assignee: Optional[str] = None,
    duration_days: Optional[int] = None,
    progress: Optional[int] = None,
    status: Optional[str] = None,
) -> str:
    """Изменить поля задачи: название, описание, исполнителя, длительность, прогресс, статус.

    task — id, номер (#5) или название задачи. Передавай только те поля, которые меняешь.
    status — planned, in_progress, done или blocked (принимаются и подписи «не начата»,
    «в работе», «готова», «заблокирована»). Статус и прогресс держатся согласованными.
    """
    return _apply(
        lambda p: ops.update_task(
            p,
            task,
            name=name,
            description=description,
            assignee=assignee,
            duration_days=duration_days,
            progress=progress,
            status=status,
        ),
        f"изменена задача «{task}»",
    )


@mcp.tool()
def delete_task(task: str, reconnect: bool = True) -> str:
    """Удалить задачу.

    reconnect=True (по умолчанию) — последователи получают предшественников
    удаляемой задачи, цепочка не рвётся.
    """
    return _apply(lambda p: ops.delete_task(p, task, reconnect=reconnect), f"удалена задача «{task}»")


@mcp.tool()
def set_predecessors(task: str, predecessors: list[str]) -> str:
    """Полностью заменить список предшественников задачи. Пустой список — снять зависимости."""
    return _apply(
        lambda p: ops.set_predecessors(p, task, predecessors), f"зависимости «{task}»"
    )


@mcp.tool()
def set_successors(task: str, successors: list[str]) -> str:
    """Задать список задач, которые зависят от этой (обратная сторона set_predecessors).

    Пустой список — снять все зависимости от этой задачи.
    """
    return _apply(lambda p: ops.set_successors(p, task, successors), f"последователи «{task}»")


@mcp.tool()
def shift_task(task: str, days: int) -> str:
    """Сдвинуть задачу на N календарных дней: положительное значение — позже, отрицательное — раньше.

    Реализуется фиксацией даты старта; зависимости всё равно приоритетнее фиксации.
    """
    return _apply(lambda p: ops.shift_task(p, task, days), f"сдвиг «{task}» на {days} дн.")


@mcp.tool()
def move_task_to(task: str, start: str) -> str:
    """Закрепить старт задачи на конкретной дате (формат ГГГГ-ММ-ДД)."""
    return _apply(
        lambda p: ops.move_task_to(p, task, _parse_date(start)), f"«{task}» → {start}"
    )


@mcp.tool()
def unpin_task(task: str) -> str:
    """Снять фиксацию даты: задача снова начинается как только позволяют зависимости."""
    return _apply(lambda p: ops.unpin_task(p, task), f"снята фиксация «{task}»")


@mcp.tool()
def reassign_tasks(
    to_assignee: str,
    from_assignee: Optional[str] = None,
    tasks: Optional[list[str]] = None,
) -> str:
    """Переназначить исполнителя — массово.

    Либо from_assignee (все задачи этого человека), либо tasks (список id/названий).
    Можно передать оба: списки объединяются.
    """
    return _apply(
        lambda p: ops.reassign_tasks(
            p, to_assignee=to_assignee, from_assignee=from_assignee, tasks=tasks
        ),
        f"переназначение на {to_assignee}",
    )


@mcp.tool()
def reorder_task(task: str, before: Optional[str] = None, after: Optional[str] = None) -> str:
    """Переставить задачу в списке: before — поставить перед указанной задачей, after — после.

    Меняет только порядок строк, даты и зависимости не затрагиваются.
    """
    return _apply(
        lambda p: ops.reorder_task(p, task, before=before, after=after),
        f"порядок «{task}»",
    )


@mcp.tool()
def set_project_start(start: str) -> str:
    """Сдвинуть дату старта проекта (формат ГГГГ-ММ-ДД) — план пересчитается целиком."""
    return _apply(
        lambda p: ops.set_project_start(p, _parse_date(start)), f"старт проекта {start}"
    )


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
