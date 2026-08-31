"""Seeded demo plan — what the page shows before anyone uploads a file.

A biotech-flavoured project (the domain of the company this task comes from):
taking a biosimilar from cell-line development to launch. It is deliberately
non-trivial: parallel branches, a long critical path through manufacturing and
the regulatory dossier, and several people carrying more than one task, so the
chat agent has something real to reorganise.
"""

from __future__ import annotations

from datetime import date, timedelta

from .models import Plan, Task

PROJECT_START = date(2026, 9, 1)

# (id, name, assignee, duration, predecessors, description)
_ROWS: list[tuple[str, str, str, int, list[str], str]] = [
    (
        "cell-line",
        "Разработка клеточной линии",
        "Смирнова А.",
        30,
        [],
        "Отбор клона-продуцента, банк клеток, проверка стабильности экспрессии.",
    ),
    (
        "upstream",
        "Отработка upstream-процесса",
        "Ковалёв Д.",
        25,
        ["cell-line"],
        "Подбор среды и режима культивирования в биореакторе 200 л.",
    ),
    (
        "downstream",
        "Отработка downstream-процесса",
        "Ковалёв Д.",
        20,
        ["upstream"],
        "Схема хроматографической очистки, вирусная инактивация, УФ-диафильтрация.",
    ),
    (
        "analytics",
        "Разработка аналитических методик",
        "Егорова М.",
        18,
        ["cell-line"],
        "Методики по чистоте, агрегатам, гликопрофилю и биоактивности.",
    ),
    (
        "method-validation",
        "Валидация аналитических методик",
        "Егорова М.",
        14,
        ["analytics", "downstream"],
        "Специфичность, точность, прецизионность, робастность по ICH Q2.",
    ),
    (
        "comparability",
        "Исследование сравнимости с референсом",
        "Егорова М.",
        21,
        ["method-validation"],
        "Физико-химическая и функциональная сравнимость с оригинальным препаратом.",
    ),
    (
        "tech-transfer",
        "Трансфер процесса на производство",
        "Ковалёв Д.",
        15,
        ["downstream"],
        "Перенос на площадку GMP, обучение операторов, инженерные серии.",
    ),
    (
        "engineering-batches",
        "Инженерные серии",
        "Литвинов П.",
        12,
        ["tech-transfer"],
        "Две серии для проверки воспроизводимости оборудования и параметров.",
    ),
    (
        "process-validation",
        "Валидация производственного процесса",
        "Литвинов П.",
        24,
        ["engineering-batches", "method-validation"],
        "Три последовательные серии PPQ, отчёт по валидации.",
    ),
    (
        "stability",
        "Исследование стабильности",
        "Егорова М.",
        30,
        ["process-validation"],
        "Ускоренные и долгосрочные точки, обоснование срока годности.",
    ),
    (
        "preclinical",
        "Доклинические исследования",
        "Абрамов К.",
        28,
        ["comparability"],
        "Токсикология и ФК на релевантной модели, отчёты GLP.",
    ),
    (
        "ct-protocol",
        "Протокол клинического исследования",
        "Наумова О.",
        12,
        ["preclinical"],
        "Дизайн исследования эквивалентности, статистический план.",
    ),
    (
        "ethics",
        "Одобрение этического комитета",
        "Наумова О.",
        20,
        ["ct-protocol"],
        "Подача в локальные ЭК центров-участников, ответы на замечания.",
    ),
    (
        "ct-phase1",
        "Клиническое исследование, фаза I",
        "Наумова О.",
        45,
        ["ethics", "process-validation"],
        "Фармакокинетика на здоровых добровольцах, две группы.",
    ),
    (
        "dossier",
        "Подготовка регистрационного досье",
        "Гареев Р.",
        22,
        ["stability", "ct-phase1"],
        "Модули 2–3 CTD, сборка данных по качеству и клинике.",
    ),
    (
        "submission",
        "Подача и экспертиза в регуляторе",
        "Гареев Р.",
        40,
        ["dossier"],
        "Регистрационная заявка, ответы на запросы экспертизы.",
    ),
    (
        "launch-prep",
        "Подготовка к выводу на рынок",
        "Тихонова В.",
        18,
        ["submission"],
        "Упаковка, серийный выпуск, логистика, обучение медпредставителей.",
    ),
]


def seed_plan(project_start: date | None = None) -> Plan:
    """Build the demo plan. Fresh every call — never share a mutable instance."""
    return Plan(
        title="Выведение биоаналога на рынок",
        project_start=project_start or PROJECT_START,
        tasks=[
            Task(
                id=task_id,
                name=name,
                description=description,
                assignee=assignee,
                duration_days=duration,
                predecessors=list(preds),
            )
            for task_id, name, assignee, duration, preds, description in _ROWS
        ],
    )


def seed_plan_starting_today() -> Plan:
    """Demo plan anchored to the current month, so the chart never looks stale."""
    today = date.today()
    return seed_plan(date(today.year, today.month, 1) + timedelta(days=0))
