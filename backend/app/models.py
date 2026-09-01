"""Domain model of a project plan.

The Excel format we ingest gives us `task, description, assignee, duration,
predecessors` -- no dates. Dates are therefore never stored, they are always
*derived* by the scheduler (see `scheduler.py`) from the project start date and
the dependency graph. The only date a user (or the agent) may set explicitly is
`start_no_earlier_than`, a pin used for "move task X two weeks later".
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class TaskStatus(str, Enum):
    """Состояние работы. На расчёт дат не влияет — планировщик считает по
    длительностям и зависимостям, а статус говорит, что происходит с задачей
    сейчас."""

    PLANNED = "planned"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"


STATUS_LABELS: dict[TaskStatus, str] = {
    TaskStatus.PLANNED: "не начата",
    TaskStatus.IN_PROGRESS: "в работе",
    TaskStatus.DONE: "готова",
    TaskStatus.BLOCKED: "заблокирована",
}


class Task(BaseModel):
    """A single unit of work. Pure input data -- carries no computed dates."""

    id: str = Field(..., description="Stable short id, unique within the plan")
    name: str = Field(..., description="Task name")
    description: str = ""
    assignee: str = ""
    duration_days: int = Field(1, ge=1, description="Duration in calendar days")
    predecessors: list[str] = Field(
        default_factory=list, description="Ids of tasks that must finish first"
    )
    start_no_earlier_than: Optional[date] = Field(
        None, description="Manual pin: task may not start before this date"
    )
    progress: int = Field(0, ge=0, le=100, description="Completion percent")
    status: TaskStatus = Field(TaskStatus.PLANNED, description="Состояние работы")

    @field_validator("predecessors")
    @classmethod
    def _dedupe(cls, v: list[str]) -> list[str]:
        seen: list[str] = []
        for item in v:
            item = item.strip()
            if item and item not in seen:
                seen.append(item)
        return seen


class Plan(BaseModel):
    """The whole plan: a title, a start date and the task list."""

    title: str = "План проекта"
    project_start: date
    tasks: list[Task] = Field(default_factory=list)

    def task_by_id(self, task_id: str) -> Optional[Task]:
        return next((t for t in self.tasks if t.id == task_id), None)

    def index_of(self, task_id: str) -> int:
        for i, t in enumerate(self.tasks):
            if t.id == task_id:
                return i
        raise KeyError(task_id)


class ScheduledTask(BaseModel):
    """A task enriched with everything the Gantt chart needs to draw it."""

    id: str
    name: str
    description: str
    assignee: str
    duration_days: int
    predecessors: list[str]
    progress: int
    status: TaskStatus
    start: date
    end: date
    is_critical: bool
    slack_days: int
    is_pinned: bool


class Schedule(BaseModel):
    """Result of running the scheduler over a plan."""

    project_start: date
    project_end: Optional[date] = None
    tasks: list[ScheduledTask] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PlanError(Exception):
    """Raised when a plan cannot be scheduled (cycle, unknown predecessor...)."""

    def __init__(self, message: str, details: Optional[list[str]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or []
