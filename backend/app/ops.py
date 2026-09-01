"""Plan operations — the single implementation of every edit the system allows.

Both the REST API and the MCP tools call into this module, so a rule written
here (no cycles, no duplicate names, dependencies beat pins) holds no matter who
asks. Every function is pure: it takes a plan, returns `(new_plan, message)` and
never mutates its input. The message is written for a human — it is what the
chat shows as the agent's tool result.

References to tasks arriving from the LLM may be ids, exact names or a
substring, so `resolve_task` accepts all three and refuses to guess when a
reference is ambiguous.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from .models import Plan, PlanError, Task
from .scheduler import schedule_plan


class OpError(Exception):
    """A rejected edit. The message goes straight back to the agent and the user."""


def _copy(plan: Plan) -> Plan:
    return plan.model_copy(deep=True)


def _validate(plan: Plan) -> Plan:
    """Reject the edit if the resulting plan cannot be scheduled."""
    try:
        schedule_plan(plan)
    except PlanError as exc:
        if "cycle" in exc.message.lower():
            raise OpError(
                "Правка отклонена: получается цикл в зависимостях "
                f"({', '.join(exc.details)})"
            ) from exc
        raise OpError(f"Правка отклонена: {exc.message}. {'; '.join(exc.details)}") from exc
    return plan


def resolve_task(plan: Plan, ref: str) -> Task:
    """Найти задачу по id, номеру строки (#5), точному названию или подстроке.

    Номер — это позиция в списке, ровно та, что видна в интерфейсе; при
    переупорядочивании он меняется, поэтому годится как ссылка «здесь и сейчас»,
    а не как долговременный идентификатор.
    """
    needle = (ref or "").strip()
    if not needle:
        raise OpError("Не указана задача")

    exact_id = plan.task_by_id(needle)
    if exact_id:
        return exact_id

    number = re.fullmatch(r"#?\s*(\d{1,4})", needle)
    if number:
        position = int(number.group(1))
        if 1 <= position <= len(plan.tasks):
            return plan.tasks[position - 1]
        raise OpError(
            f"В плане {len(plan.tasks)} задач, номера {position} нет"
        )

    lowered = needle.lower()
    by_name = [t for t in plan.tasks if t.name.strip().lower() == lowered]
    if len(by_name) == 1:
        return by_name[0]
    if len(by_name) > 1:
        raise OpError(
            f"Несколько задач с именем «{needle}»: {', '.join(t.id for t in by_name)}. "
            "Укажите id."
        )

    partial = [t for t in plan.tasks if lowered in t.name.lower() or lowered in t.id.lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        raise OpError(
            f"Запрос «{needle}» подходит нескольким задачам: "
            f"{', '.join(t.id for t in partial)}. Уточните."
        )

    known = ", ".join(f"{t.id} ({t.name})" for t in plan.tasks[:12])
    raise OpError(f"Задача «{needle}» не найдена. Известные задачи: {known}")


def _resolve_many(plan: Plan, refs: list[str]) -> list[str]:
    ids: list[str] = []
    for ref in refs or []:
        task = resolve_task(plan, ref)
        if task.id not in ids:
            ids.append(task.id)
    return ids


def _computed_start(plan: Plan, task_id: str) -> date:
    return {t.id: t for t in schedule_plan(plan).tasks}[task_id].start


def add_task(
    plan: Plan,
    name: str,
    duration_days: int = 1,
    description: str = "",
    assignee: str = "",
    predecessors: Optional[list[str]] = None,
    after: Optional[str] = None,
    start_no_earlier_than: Optional[date] = None,
) -> tuple[Plan, str]:
    """Add a task. `after` inserts it in the list right after another task."""
    from .excel_io import slugify

    name = (name or "").strip()
    if not name:
        raise OpError("У новой задачи должно быть название")
    if duration_days is None or int(duration_days) < 1:
        raise OpError("Длительность должна быть не меньше 1 дня")
    if any(t.name.strip().lower() == name.lower() for t in plan.tasks):
        raise OpError(f"Задача «{name}» уже есть в плане")

    new_plan = _copy(plan)
    task = Task(
        id=slugify(name, {t.id for t in new_plan.tasks}),
        name=name,
        description=description or "",
        assignee=assignee or "",
        duration_days=int(duration_days),
        predecessors=_resolve_many(new_plan, predecessors or []),
        start_no_earlier_than=start_no_earlier_than,
    )
    position = len(new_plan.tasks)
    if after:
        position = new_plan.index_of(resolve_task(new_plan, after).id) + 1
    new_plan.tasks.insert(position, task)

    _validate(new_plan)
    preds = ", ".join(new_plan.task_by_id(p).name for p in task.predecessors) or "нет"
    return new_plan, (
        f"Добавлена задача «{task.name}» (id {task.id}): {task.duration_days} дн., "
        f"исполнитель {task.assignee or 'не назначен'}, предшественники: {preds}"
    )


def update_task(
    plan: Plan,
    task: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    assignee: Optional[str] = None,
    duration_days: Optional[int] = None,
    progress: Optional[int] = None,
) -> tuple[Plan, str]:
    """Change scalar fields of a task. Only the arguments given are touched."""
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    changes: list[str] = []

    if name is not None and name.strip() and name.strip() != target.name:
        if any(t.name.strip().lower() == name.strip().lower() and t.id != target.id for t in new_plan.tasks):
            raise OpError(f"Задача «{name}» уже есть в плане")
        changes.append(f"название → «{name.strip()}»")
        target.name = name.strip()
    if description is not None and description != target.description:
        changes.append("описание обновлено")
        target.description = description
    if assignee is not None and assignee != target.assignee:
        changes.append(f"исполнитель → {assignee or 'не назначен'}")
        target.assignee = assignee
    if duration_days is not None:
        if int(duration_days) < 1:
            raise OpError("Длительность должна быть не меньше 1 дня")
        if int(duration_days) != target.duration_days:
            changes.append(f"длительность {target.duration_days} → {int(duration_days)} дн.")
            target.duration_days = int(duration_days)
    if progress is not None:
        if not 0 <= int(progress) <= 100:
            raise OpError("Прогресс задаётся в процентах, 0..100")
        if int(progress) != target.progress:
            changes.append(f"прогресс → {int(progress)}%")
            target.progress = int(progress)

    if not changes:
        return plan, f"Задача «{target.name}» уже в таком состоянии, изменений нет"

    _validate(new_plan)
    return new_plan, f"«{target.name}»: {', '.join(changes)}"


def delete_task(plan: Plan, task: str, reconnect: bool = True) -> tuple[Plan, str]:
    """Remove a task. By default its successors inherit its predecessors."""
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    inherited = list(target.predecessors)

    for other in new_plan.tasks:
        if target.id in other.predecessors:
            other.predecessors = [p for p in other.predecessors if p != target.id]
            if reconnect:
                other.predecessors += [p for p in inherited if p not in other.predecessors]

    new_plan.tasks = [t for t in new_plan.tasks if t.id != target.id]
    _validate(new_plan)
    tail = "зависимости переподключены" if reconnect else "зависимости не переподключались"
    return new_plan, f"Удалена задача «{target.name}», {tail}"


def set_predecessors(plan: Plan, task: str, predecessors: list[str]) -> tuple[Plan, str]:
    """Replace the dependency list of a task (empty list detaches it)."""
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    resolved = _resolve_many(new_plan, predecessors)
    if target.id in resolved:
        raise OpError("Задача не может зависеть от себя")
    target.predecessors = resolved
    _validate(new_plan)
    names = ", ".join(new_plan.task_by_id(p).name for p in resolved) or "нет"
    return new_plan, f"Предшественники «{target.name}»: {names}"


def shift_task(plan: Plan, task: str, days: int) -> tuple[Plan, str]:
    """Move a task `days` calendar days later (negative = earlier) via a pin."""
    if not days:
        raise OpError("Сдвиг на 0 дней ничего не меняет")
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    current = _computed_start(new_plan, target.id)
    wanted = current + timedelta(days=int(days))
    target.start_no_earlier_than = wanted
    _validate(new_plan)

    actual = _computed_start(new_plan, target.id)
    if actual != wanted:
        return new_plan, (
            f"«{target.name}»: запрошен старт {wanted.isoformat()}, но предшественники "
            f"держат задачу на {actual.isoformat()} — раньше начать нельзя"
        )
    direction = "позже" if days > 0 else "раньше"
    return new_plan, (
        f"«{target.name}» сдвинута на {abs(int(days))} дн. {direction}: "
        f"старт {actual.isoformat()}"
    )


def move_task_to(plan: Plan, task: str, start: date) -> tuple[Plan, str]:
    """Pin a task to an exact start date."""
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    target.start_no_earlier_than = start
    _validate(new_plan)
    actual = _computed_start(new_plan, target.id)
    if actual != start:
        return new_plan, (
            f"«{target.name}»: {start.isoformat()} раньше, чем позволяют предшественники; "
            f"фактический старт {actual.isoformat()}"
        )
    return new_plan, f"«{target.name}» закреплена на {start.isoformat()}"


def unpin_task(plan: Plan, task: str) -> tuple[Plan, str]:
    """Drop a manual pin so the task floats back to its earliest possible start."""
    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    if target.start_no_earlier_than is None:
        return plan, f"«{target.name}» не была закреплена"
    target.start_no_earlier_than = None
    _validate(new_plan)
    return new_plan, (
        f"С «{target.name}» снята фиксация даты, старт {_computed_start(new_plan, target.id).isoformat()}"
    )


def reassign_tasks(
    plan: Plan,
    to_assignee: str,
    from_assignee: Optional[str] = None,
    tasks: Optional[list[str]] = None,
) -> tuple[Plan, str]:
    """Bulk reassignment: either every task of `from_assignee`, or a task list."""
    if not from_assignee and not tasks:
        raise OpError("Укажите, что переназначать: from_assignee или список tasks")

    new_plan = _copy(plan)
    targets: list[Task] = []
    if from_assignee:
        needle = from_assignee.strip().lower()
        targets += [t for t in new_plan.tasks if t.assignee.strip().lower() == needle]
        if not targets:
            known = sorted({t.assignee for t in new_plan.tasks if t.assignee})
            raise OpError(
                f"Исполнитель «{from_assignee}» не найден. В плане: {', '.join(known) or '—'}"
            )
    for ref in tasks or []:
        task = resolve_task(new_plan, ref)
        if task not in targets:
            targets.append(task)

    for task in targets:
        task.assignee = to_assignee
    _validate(new_plan)
    names = ", ".join(f"«{t.name}»" for t in targets)
    return new_plan, f"Переназначено задач: {len(targets)} → {to_assignee or 'не назначен'} ({names})"


def reorder_task(
    plan: Plan,
    task: str,
    before: Optional[str] = None,
    after: Optional[str] = None,
) -> tuple[Plan, str]:
    """Переставить задачу в списке относительно другой задачи.

    Порядок строк — это только представление (порядок строк Excel), на расчёт
    дат он не влияет: даты задают длительности и зависимости. Опора на «до/после
    задачи», а не на числовой индекс, потому что в интерфейсе может стоять
    фильтр, и номер видимой строки не совпадает с номером в плане.
    """
    if bool(before) == bool(after):
        raise OpError("Укажите ровно одно: before или after")

    new_plan = _copy(plan)
    target = resolve_task(new_plan, task)
    anchor = resolve_task(new_plan, before or after or "")
    if anchor.id == target.id:
        return plan, f"«{target.name}» уже на этом месте"

    new_plan.tasks = [t for t in new_plan.tasks if t.id != target.id]
    anchor_index = new_plan.index_of(anchor.id)
    position = anchor_index if before else anchor_index + 1
    new_plan.tasks.insert(position, target)

    _validate(new_plan)
    where = "перед" if before else "после"
    return new_plan, f"«{target.name}» перемещена {where} «{anchor.name}»"


def set_project_start(plan: Plan, start: date) -> tuple[Plan, str]:
    """Move the whole project start date."""
    new_plan = _copy(plan)
    new_plan.project_start = start
    _validate(new_plan)
    return new_plan, f"Старт проекта: {start.isoformat()}"
