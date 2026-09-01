from datetime import date

import pytest

from app import ops
from app.models import Plan, Task


def base_plan():
    return Plan(
        project_start=date(2026, 3, 2),
        tasks=[
            Task(id="analiz", name="Анализ", assignee="Иванов", duration_days=3),
            Task(id="dizayn", name="Дизайн", assignee="Петрова", duration_days=2, predecessors=["analiz"]),
            Task(id="verstka", name="Вёрстка", assignee="Петрова", duration_days=4, predecessors=["dizayn"]),
        ],
    )


def test_resolve_task_by_id_name_and_substring():
    plan = base_plan()
    assert ops.resolve_task(plan, "analiz").id == "analiz"
    assert ops.resolve_task(plan, "Анализ").id == "analiz"
    assert ops.resolve_task(plan, "дизай").id == "dizayn"


def test_resolve_task_reports_unknown_reference():
    with pytest.raises(ops.OpError) as err:
        ops.resolve_task(base_plan(), "Бюджет")
    assert "Бюджет" in str(err.value)


def test_resolve_task_prefers_exact_name_over_substring():
    plan = base_plan()
    plan.tasks.append(Task(id="dizayn-2", name="Дизайн упаковки", duration_days=1))
    assert ops.resolve_task(plan, "Дизайн ").id == "dizayn"
    with pytest.raises(ops.OpError) as err:
        ops.resolve_task(plan, "диз")  # ambiguous substring
    assert "dizayn" in str(err.value) and "dizayn-2" in str(err.value)


def test_add_task_resolves_predecessors_by_name():
    plan, msg = ops.add_task(
        base_plan(),
        name="Тестирование",
        assignee="Сидоров",
        duration_days=3,
        predecessors=["Вёрстка"],
    )
    added = plan.tasks[-1]
    assert added.predecessors == ["verstka"]
    assert added.assignee == "Сидоров"
    assert "Тестирование" in msg


def test_add_task_rejects_duplicate_name():
    with pytest.raises(ops.OpError):
        ops.add_task(base_plan(), name="Анализ", duration_days=1)


def test_update_task_changes_only_given_fields():
    plan, _ = ops.update_task(base_plan(), "dizayn", duration_days=5)
    task = plan.task_by_id("dizayn")
    assert task.duration_days == 5
    assert task.assignee == "Петрова"
    assert task.name == "Дизайн"


def test_update_task_rejects_zero_duration():
    with pytest.raises(ops.OpError):
        ops.update_task(base_plan(), "dizayn", duration_days=0)


def test_delete_task_reconnects_successors_by_default():
    plan, _ = ops.delete_task(base_plan(), "dizayn")
    assert plan.task_by_id("dizayn") is None
    assert plan.task_by_id("verstka").predecessors == ["analiz"]


def test_delete_task_without_reconnect_drops_the_link():
    plan, _ = ops.delete_task(base_plan(), "dizayn", reconnect=False)
    assert plan.task_by_id("verstka").predecessors == []


def test_set_predecessors_rejects_cycles():
    with pytest.raises(ops.OpError) as err:
        ops.set_predecessors(base_plan(), "analiz", ["Вёрстка"])
    assert "цикл" in str(err.value).lower()


def test_set_predecessors_can_clear_dependencies():
    plan, _ = ops.set_predecessors(base_plan(), "verstka", [])
    assert plan.task_by_id("verstka").predecessors == []


def test_shift_task_pins_it_later():
    plan, _ = ops.shift_task(base_plan(), "dizayn", days=7)
    # Дизайн normally starts Mar 5 (after 3-day Анализ from Mar 2)
    assert plan.task_by_id("dizayn").start_no_earlier_than == date(2026, 3, 12)


def test_shift_task_backwards_is_clamped_by_dependencies():
    plan, msg = ops.shift_task(base_plan(), "verstka", days=-30)
    from app.scheduler import schedule_plan

    verstka = {t.id: t for t in schedule_plan(plan).tasks}["verstka"]
    assert verstka.start == date(2026, 3, 7)  # cannot start before Дизайн ends
    assert msg


def test_move_task_to_pins_an_exact_date():
    plan, _ = ops.move_task_to(base_plan(), "verstka", date(2026, 4, 1))
    assert plan.task_by_id("verstka").start_no_earlier_than == date(2026, 4, 1)


def test_unpin_task_removes_the_pin():
    plan, _ = ops.move_task_to(base_plan(), "verstka", date(2026, 4, 1))
    plan, _ = ops.unpin_task(plan, "verstka")
    assert plan.task_by_id("verstka").start_no_earlier_than is None


def test_reassign_by_current_assignee_is_bulk():
    plan, msg = ops.reassign_tasks(base_plan(), to_assignee="Кузнецов", from_assignee="Петрова")
    assert [t.assignee for t in plan.tasks] == ["Иванов", "Кузнецов", "Кузнецов"]
    assert "2" in msg


def test_reassign_specific_tasks():
    plan, _ = ops.reassign_tasks(base_plan(), to_assignee="Кузнецов", tasks=["Анализ", "verstka"])
    assert [t.assignee for t in plan.tasks] == ["Кузнецов", "Петрова", "Кузнецов"]


def test_reassign_without_target_selection_fails():
    with pytest.raises(ops.OpError):
        ops.reassign_tasks(base_plan(), to_assignee="Кузнецов")


def test_set_project_start_moves_everything():
    plan, _ = ops.set_project_start(base_plan(), date(2026, 4, 6))
    assert plan.project_start == date(2026, 4, 6)


def test_ops_never_mutate_the_input_plan():
    plan = base_plan()
    before = plan.model_dump_json()
    ops.update_task(plan, "analiz", duration_days=99)
    ops.delete_task(plan, "dizayn")
    ops.add_task(plan, name="Новая", duration_days=1)
    assert plan.model_dump_json() == before


def test_reorder_task_before_and_after():
    plan, msg = ops.reorder_task(base_plan(), "verstka", before="analiz")
    assert [t.id for t in plan.tasks] == ["verstka", "analiz", "dizayn"]
    assert "перед" in msg

    plan, msg = ops.reorder_task(base_plan(), "analiz", after="verstka")
    assert [t.id for t in plan.tasks] == ["dizayn", "verstka", "analiz"]
    assert "после" in msg


def test_reorder_task_keeps_dependencies_and_dates():
    from app.scheduler import schedule_plan

    before = {t.id: (t.start, t.end) for t in schedule_plan(base_plan()).tasks}
    plan, _ = ops.reorder_task(base_plan(), "verstka", before="analiz")
    after = {t.id: (t.start, t.end) for t in schedule_plan(plan).tasks}
    assert before == after, "порядок строк не должен менять расчёт дат"
    assert plan.task_by_id("verstka").predecessors == ["dizayn"]


def test_reorder_task_requires_exactly_one_anchor():
    with pytest.raises(ops.OpError):
        ops.reorder_task(base_plan(), "analiz")
    with pytest.raises(ops.OpError):
        ops.reorder_task(base_plan(), "analiz", before="dizayn", after="verstka")


def test_reorder_task_onto_itself_is_a_no_op():
    plan, msg = ops.reorder_task(base_plan(), "analiz", before="analiz")
    assert [t.id for t in plan.tasks] == ["analiz", "dizayn", "verstka"]
    assert "уже" in msg


def test_resolve_task_by_row_number():
    plan = base_plan()
    assert ops.resolve_task(plan, "#2").id == "dizayn"
    assert ops.resolve_task(plan, "3").id == "verstka"
    assert ops.resolve_task(plan, "# 1").id == "analiz"


def test_resolve_task_reports_number_out_of_range():
    with pytest.raises(ops.OpError) as err:
        ops.resolve_task(base_plan(), "#9")
    assert "9" in str(err.value)


def test_task_id_wins_over_number_lookalike():
    plan = base_plan()
    plan.tasks.append(Task(id="2026", name="Бюджет 2026", duration_days=1))
    assert ops.resolve_task(plan, "2026").id == "2026"


def test_resolve_task_ignores_surrounding_quotes():
    assert ops.resolve_task(base_plan(), "«Анализ»").id == "analiz"
    assert ops.resolve_task(base_plan(), '"Дизайн"').id == "dizayn"


def test_stale_number_loses_to_the_name_in_one_reference():
    """Ссылка «#1 «Вёрстка»» противоречива: номер устарел после переупорядочивания."""
    assert ops.resolve_task(base_plan(), "#1 «Вёрстка»").id == "verstka"
    assert ops.resolve_task(base_plan(), "3 «Анализ»").id == "analiz"
