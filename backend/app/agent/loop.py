"""The agent turn: user message → tool calls over MCP → updated plan.

Yields events as it goes, which the API forwards to the browser over SSE, so the
chat shows each tool call as it happens instead of freezing until the whole turn
finishes. The final `plan` event carries the recomputed schedule plus the ids of
tasks that changed, which is what makes the Gantt chart react "instantly".
"""

from __future__ import annotations

import asyncio
import json
from datetime import date
from typing import Any, AsyncIterator, Optional

from ..config import settings
from ..models import Plan
from ..scheduler import schedule_plan
from ..seed import seed_plan
from ..store import PlanStore
from .llm import LLM, LLMError, OpenAICompatibleLLM
from .mcp_client import call_tool, list_tool_specs, plan_tools_session

SYSTEM_PROMPT = """Ты — ассистент-планировщик проекта. Пользователь работает с диаграммой Ганта, ты правишь план через инструменты.

Правила:
- Любое изменение плана делай ТОЛЬКО инструментами. Не описывай правки словами вместо вызова инструмента.
- Один запрос пользователя может требовать нескольких вызовов — делай их все, по одному за шаг, пока задача не выполнена.
- Массовые операции: если просят «перенеси всё, что после X», «переназначь задачи Петровой на Иванова» — вызывай инструменты столько раз, сколько нужно, и не спрашивай подтверждения.
- Если инструмент вернул строку, начинающуюся с «ОШИБКА», не повторяй тот же вызов вслепую: прочитай причину, при необходимости вызови get_plan и исправь аргументы.
- Даты — формат ГГГГ-ММ-ДД. Длительности — целые календарные дни.
- Зависимости всегда приоритетнее фиксации даты: задача не может начаться раньше, чем закончатся её предшественники.
- В конце коротко (1–3 предложения) отчитайся, что именно изменилось. Без Markdown-таблиц и без списка всего плана.
- Отвечай на языке пользователя.
- Если запрос неоднозначен настолько, что можно испортить план (например, непонятно, какую из двух похожих задач двигать), задай один уточняющий вопрос вместо правки."""


class ChatMemory:
    """Per-session conversation history, in process memory.

    Single-instance by design: this is a demo, and the plan itself (the thing
    worth keeping) lives in SQLite. Moving history into the store is listed in
    the roadmap.
    """

    def __init__(self, limit: int = 40) -> None:
        self._limit = limit
        self._sessions: dict[str, list[dict[str, Any]]] = {}

    def get(self, session_id: str) -> list[dict[str, Any]]:
        return list(self._sessions.get(session_id, []))

    def set(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        trimmed = messages[-self._limit :]
        # never start the stored history with an orphaned tool result
        while trimmed and trimmed[0].get("role") == "tool":
            trimmed = trimmed[1:]
        self._sessions[session_id] = trimmed

    def clear(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)


memory = ChatMemory(limit=settings.history_limit)


def render_plan_for_prompt(plan: Plan) -> str:
    """Compact plan rendering injected into the system prompt.

    Saves the agent a `get_plan` round trip on every turn — it already knows the
    ids, names, assignees and dates before it starts.
    """
    schedule = schedule_plan(plan)
    names = {t.id: t.name for t in plan.tasks}
    lines = [
        f"Сегодня: {date.today().isoformat()}",
        f"Старт проекта: {schedule.project_start.isoformat()}, "
        f"окончание: {schedule.project_end.isoformat() if schedule.project_end else '—'}, "
        f"задач: {len(schedule.tasks)}",
        "Текущий план (id | задача | исполнитель | дни | старт..финиш | предшественники):",
    ]
    for t in schedule.tasks:
        preds = ", ".join(names.get(p, p) for p in t.predecessors) or "—"
        marks = " [крит.путь]" if t.is_critical else ""
        marks += " [дата закреплена]" if t.is_pinned else ""
        lines.append(
            f"{t.id} | {t.name} | {t.assignee or '—'} | {t.duration_days} | "
            f"{t.start.isoformat()}..{t.end.isoformat()} | {preds}{marks}"
        )
    return "\n".join(lines)


def _changed_task_ids(before: Plan, after: Plan) -> list[str]:
    old = {t.id: t.model_dump_json() for t in before.tasks}
    new = {t.id: t.model_dump_json() for t in after.tasks}
    changed = [tid for tid, payload in new.items() if old.get(tid) != payload]
    if before.project_start != after.project_start:
        changed = list(new)
    return changed


def plan_event(before: Plan, after: Plan) -> dict[str, Any]:
    schedule = schedule_plan(after)
    return {
        "type": "plan",
        "schedule": json.loads(schedule.model_dump_json()),
        "plan": json.loads(after.model_dump_json()),
        "changed": _changed_task_ids(before, after),
    }


async def run_turn(
    store: PlanStore,
    session_id: str,
    user_message: str,
    llm: Optional[LLM] = None,
) -> AsyncIterator[dict[str, Any]]:
    """Drive one chat turn, yielding SSE-ready events."""
    llm = llm or OpenAICompatibleLLM()
    plan_before = store.ensure_session(session_id, seed_plan())

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": f"{SYSTEM_PROMPT}\n\n{render_plan_for_prompt(plan_before)}"},
        *memory.get(session_id),
        {"role": "user", "content": user_message},
    ]
    history: list[dict[str, Any]] = [{"role": "user", "content": user_message}]
    tool_calls_made = 0

    try:
        async with plan_tools_session(session_id, store.db_path) as mcp:
            tools = await list_tool_specs(mcp)

            for step in range(settings.max_tool_steps):
                assistant = await llm.complete(messages, tools)
                messages.append(_normalise_assistant(assistant))
                history.append(_normalise_assistant(assistant))

                text = (assistant.get("content") or "").strip()
                calls = assistant.get("tool_calls") or []

                if text:
                    yield {"type": "message", "text": text, "final": not calls}
                if not calls:
                    if not text:
                        yield {
                            "type": "message",
                            "text": "Готово.",
                            "final": True,
                        }
                    break

                for call in calls:
                    name = call.get("function", {}).get("name", "")
                    raw_args = call.get("function", {}).get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
                    except json.JSONDecodeError:
                        args = {}
                    yield {"type": "tool_call", "name": name, "arguments": args}

                    result = await call_tool(mcp, name, args)
                    tool_calls_made += 1
                    ok = not result.startswith("ОШИБКА")
                    yield {"type": "tool_result", "name": name, "text": result, "ok": ok}

                    tool_message = {
                        "role": "tool",
                        "tool_call_id": call.get("id") or name,
                        "content": result,
                    }
                    messages.append(tool_message)
                    history.append(tool_message)
            else:
                yield {
                    "type": "message",
                    "text": (
                        f"Остановился после {settings.max_tool_steps} шагов, чтобы не зациклиться. "
                        "Проверьте план и уточните, что доделать."
                    ),
                    "final": True,
                }
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001 - the browser must always learn why
        # The MCP stdio client runs inside an anyio task group, so anything raised
        # in the turn reaches us wrapped in an ExceptionGroup. Unwrap it, or the
        # user would see "unhandled errors in a TaskGroup" instead of the reason.
        llm_error = _find_exception(exc, LLMError)
        if llm_error is not None:
            yield {"type": "error", "text": str(llm_error)}
        else:
            yield {"type": "error", "text": f"Сбой агента: {_describe(exc)}"}

    memory.set(session_id, memory.get(session_id) + history)

    plan_after = store.get_plan(session_id) or plan_before
    if tool_calls_made:
        yield plan_event(plan_before, plan_after)
    yield {"type": "done", "tool_calls": tool_calls_made}


def _find_exception(exc: BaseException, wanted: type) -> Optional[BaseException]:
    """Depth-first search for `wanted` inside (possibly nested) exception groups."""
    if isinstance(exc, wanted):
        return exc
    if isinstance(exc, BaseExceptionGroup):
        for sub in exc.exceptions:
            found = _find_exception(sub, wanted)
            if found is not None:
                return found
    return None


def _describe(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        return "; ".join(_describe(sub) for sub in exc.exceptions)
    return f"{type(exc).__name__}: {exc}"


def _normalise_assistant(message: dict[str, Any]) -> dict[str, Any]:
    """Keep only the fields the API accepts back, and never send content=None."""
    out: dict[str, Any] = {"role": "assistant", "content": message.get("content") or ""}
    if message.get("tool_calls"):
        out["tool_calls"] = [
            {
                "id": call.get("id") or call.get("function", {}).get("name", "call"),
                "type": "function",
                "function": {
                    "name": call.get("function", {}).get("name", ""),
                    "arguments": call.get("function", {}).get("arguments") or "{}",
                },
            }
            for call in message["tool_calls"]
        ]
    return out
