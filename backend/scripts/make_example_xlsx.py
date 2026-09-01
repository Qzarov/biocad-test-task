"""Generate samples/example_plan.xlsx — the file reviewers upload to try the app.

Deliberately a different project from the seeded demo plan, so importing it
visibly replaces the chart. Run from the backend directory:

    ./.venv/bin/python scripts/make_example_xlsx.py
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.excel_io import plan_to_xlsx  # noqa: E402
from app.models import Plan, Task  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "samples" / "example_plan.xlsx"

# (id, name, assignee, duration, predecessors, description)
# (id, статус, прогресс) — в примере показаны все состояния разом
STATUSES = {
    "layout": ("done", 100),
    "permits": ("in_progress", 45),
    "equipment-order": ("blocked", 0),
}

ROWS = [
    ("layout", "Проектирование участка", "Морозов И.", 14, [], "Планировка чистого помещения класса C, зонирование потоков."),
    ("permits", "Согласование с надзором", "Белова Н.", 21, ["layout"], "Пакет документов по чистым помещениям и вентиляции."),
    ("equipment-order", "Заказ оборудования", "Морозов И.", 10, ["layout"], "Линия розлива предзаполненных шприцев, изолятор, инспекция."),
    ("delivery", "Поставка и монтаж", "Морозов И.", 35, ["equipment-order", "permits"], "Приёмка, монтаж, подключение утилит."),
    ("iq-oq", "Квалификация IQ/OQ", "Титов С.", 18, ["delivery"], "Монтажная и функциональная квалификация с протоколами."),
    ("cleaning-validation", "Валидация мойки", "Титов С.", 12, ["iq-oq"], "Оценка остатков и микробиологии после CIP/SIP."),
    ("media-fill", "Media fill", "Титов С.", 9, ["iq-oq"], "Три успешных прогона имитации розлива."),
    ("sop", "Разработка СОП", "Белова Н.", 12, ["iq-oq"], "Операционные процедуры, журналы, формы записей."),
    ("training", "Обучение операторов", "Белова Н.", 8, ["sop"], "Теория, практика на линии, оценка допуска."),
    ("pq", "Квалификация PQ", "Титов С.", 15, ["media-fill", "cleaning-validation", "training"], "Три серии на целевом продукте."),
    ("gmp-audit", "Внутренний GMP-аудит", "Белова Н.", 6, ["pq"], "Проверка готовности участка к инспекции."),
    ("release", "Ввод участка в эксплуатацию", "Морозов И.", 5, ["gmp-audit"], "Приказ о вводе, передача в производство."),
]


def main() -> None:
    plan = Plan(
        title="Запуск участка розлива предзаполненных шприцев",
        project_start=date(2026, 10, 1),
        tasks=[
            Task(
                id=task_id,
                name=name,
                description=description,
                assignee=assignee,
                duration_days=duration,
                predecessors=list(preds),
                status=STATUSES.get(task_id, ("planned", 0))[0],
                progress=STATUSES.get(task_id, ("planned", 0))[1],
            )
            for task_id, name, assignee, duration, preds, description in ROWS
        ],
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(plan_to_xlsx(plan))
    print(f"wrote {OUT} ({len(plan.tasks)} tasks)")


if __name__ == "__main__":
    main()
