"""HTTP API.

Three groups of endpoints:
  * plan state — read, seed, import, export, undo;
  * direct edits — what the UI does when you drag a bar or save the task modal;
  * chat — one SSE stream per turn, forwarding the agent's events.

Direct edits and agent edits go through the same `app.ops` functions, so the
Gantt chart cannot end up in a state the agent would have refused to create.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from datetime import date
from typing import Any, Optional

from fastapi import Body, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from . import ops
from .agent.loop import run_turn, transcript
from .config import settings
from .excel_io import ExcelImportError, meta_from_xlsx, plan_from_xlsx, plan_to_xlsx
from .models import STATUS_LABELS, Plan, PlanError
from .scheduler import schedule_plan
from .seed import seed_plan
from .store import PlanStore

app = FastAPI(title="Gantt Plan Agent API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Session-Id", "Content-Disposition"],
)

store = PlanStore(settings.db_path)


# --- helpers ---------------------------------------------------------------


def resolve_session(session_id: Optional[str], header_value: Optional[str]) -> str:
    return (session_id or header_value or "default").strip() or "default"


def plan_payload(session_id: str, plan: Plan, changed: Optional[list[str]] = None) -> dict[str, Any]:
    try:
        schedule = schedule_plan(plan)
    except PlanError as exc:
        raise HTTPException(status_code=409, detail={"message": exc.message, "details": exc.details})
    return {
        "session_id": session_id,
        "statuses": [
            {"value": status.value, "label": label} for status, label in STATUS_LABELS.items()
        ],
        "plan": json.loads(plan.model_dump_json()),
        "schedule": json.loads(schedule.model_dump_json()),
        "history": store.history(session_id),
        "changed": changed or [],
    }


def current_plan(session_id: str) -> Plan:
    return store.ensure_session(session_id, seed_plan())


def apply_edit(session_id: str, result: tuple[Plan, str], label: str) -> dict[str, Any]:
    plan_before = current_plan(session_id)
    plan_after, message = result
    store.save_plan(session_id, plan_after, label)
    payload = plan_payload(session_id, plan_after, changed=_diff_ids(plan_before, plan_after))
    payload["message"] = message
    return payload


def _diff_ids(before: Plan, after: Plan) -> list[str]:
    old = {t.id: t.model_dump_json() for t in before.tasks}
    return [t.id for t in after.tasks if old.get(t.id) != t.model_dump_json()]


# --- request bodies --------------------------------------------------------


class TaskCreate(BaseModel):
    name: str
    description: str = ""
    assignee: str = ""
    duration_days: int = Field(1, ge=1)
    status: Optional[str] = None
    predecessors: list[str] = Field(default_factory=list)
    after: Optional[str] = None


class TaskUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    duration_days: Optional[int] = None
    progress: Optional[int] = None
    status: Optional[str] = None
    predecessors: Optional[list[str]] = None
    successors: Optional[list[str]] = None
    start: Optional[date] = Field(None, description="Pin the task to this start date")
    unpin: bool = False


class TaskReorder(BaseModel):
    before: Optional[str] = None
    after: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    model: Optional[str] = Field(None, description="Модель из списка /api/models")


# --- plan state ------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "llm_configured": settings.llm_configured,
        "model": settings.llm_model if settings.llm_configured else None,
        "base_url": settings.llm_base_url,
    }


@app.get("/api/models")
def list_models() -> dict[str, Any]:
    """Модели, доступные в выпадающем списке чата.

    Список задаётся переменной LLM_MODELS, поэтому набор меняется без правок кода.
    """
    return {
        "default": settings.llm_model,
        "models": [
            {
                "id": model,
                "label": model.split("/")[-1],
                "vendor": model.split("/")[0] if "/" in model else "",
            }
            for model in settings.available_models
        ],
    }


@app.get("/api/session")
def new_session() -> dict[str, str]:
    """Hand out a fresh session id; the front end keeps it in localStorage."""
    return {"session_id": uuid.uuid4().hex[:12]}


@app.get("/api/plan")
def get_plan(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    return plan_payload(sid, current_plan(sid))


@app.post("/api/plan/reset")
def reset_plan(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Back to the seeded demo plan, history and chat included."""
    sid = resolve_session(session_id, x_session_id)
    plan = seed_plan()
    store.reset(sid, plan, "демо-план")
    store.clear_chat(sid)
    return plan_payload(sid, plan)


@app.post("/api/plan/undo")
def undo(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    current_plan(sid)
    plan, message = store.undo(sid)
    if plan is None:
        raise HTTPException(status_code=409, detail={"message": message})
    payload = plan_payload(sid, plan)
    payload["message"] = message
    return payload


@app.post("/api/plan/redo")
def redo(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    current_plan(sid)
    plan, message = store.redo(sid)
    if plan is None:
        raise HTTPException(status_code=409, detail={"message": message})
    payload = plan_payload(sid, plan)
    payload["message"] = message
    return payload


@app.post("/api/plan/import")
async def import_plan(
    file: UploadFile = File(...),
    project_start: Optional[date] = Query(None),
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Replace the plan with the contents of an uploaded .xlsx."""
    sid = resolve_session(session_id, x_session_id)
    blob = await file.read()
    if not blob:
        raise HTTPException(status_code=400, detail={"message": "Файл пустой"})

    file_title, file_start = meta_from_xlsx(blob)
    start = project_start or file_start or date.today()
    title = file_title or Path(file.filename or "План проекта").stem
    try:
        plan = plan_from_xlsx(blob, project_start=start, title=title)
    except ExcelImportError as exc:
        raise HTTPException(
            status_code=400, detail={"message": exc.message, "details": exc.details}
        )
    if not plan.tasks:
        raise HTTPException(status_code=400, detail={"message": "В файле не нашлось ни одной задачи"})
    try:
        schedule_plan(plan)
    except PlanError as exc:
        raise HTTPException(
            status_code=400, detail={"message": exc.message, "details": exc.details}
        )

    store.reset(sid, plan, f"импорт {file.filename or 'файла'}")
    store.clear_chat(sid)
    payload = plan_payload(sid, plan)
    payload["message"] = f"Загружено задач: {len(plan.tasks)}"
    return payload


@app.get("/api/plan/template")
def download_template() -> Response:
    """Шаблон плана — тот же демо-план, что показывается при первом открытии.

    Отдаётся из сида, а не из файла на диске: копия в samples/ нужна, чтобы
    шаблон было видно в репозитории, и тест следит, что она не разошлась.
    """
    blob = plan_to_xlsx(seed_plan())
    return Response(
        content=blob,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="plan-template.xlsx"'},
    )


@app.get("/api/plan/export")
def export_plan(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> Response:
    sid = resolve_session(session_id, x_session_id)
    blob = plan_to_xlsx(current_plan(sid))
    filename = f"plan-{date.today().isoformat()}.xlsx"
    return Response(
        content=blob,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- direct edits from the UI ---------------------------------------------


@app.post("/api/plan/tasks")
def create_task(
    body: TaskCreate,
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    try:
        result = ops.add_task(
            current_plan(sid),
            name=body.name,
            duration_days=body.duration_days,
            description=body.description,
            assignee=body.assignee,
            predecessors=body.predecessors,
            after=body.after,
        )
    except ops.OpError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})
    return apply_edit(sid, result, f"добавлена задача «{body.name}»")


@app.patch("/api/plan/tasks/{task_id}")
def patch_task(
    task_id: str,
    body: TaskUpdate,
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Save the task modal, or drop a dragged bar on a new date."""
    sid = resolve_session(session_id, x_session_id)
    plan = current_plan(sid)
    labels: list[str] = []
    try:
        if any(
            v is not None
            for v in (
                body.name,
                body.description,
                body.assignee,
                body.duration_days,
                body.progress,
                body.status,
            )
        ):
            plan, message = ops.update_task(
                plan,
                task_id,
                name=body.name,
                description=body.description,
                assignee=body.assignee,
                duration_days=body.duration_days,
                progress=body.progress,
                status=body.status,
            )
            labels.append(message)
        if body.predecessors is not None:
            plan, message = ops.set_predecessors(plan, task_id, body.predecessors)
            labels.append(message)
        if body.successors is not None:
            plan, message = ops.set_successors(plan, task_id, body.successors)
            labels.append(message)
        if body.unpin:
            plan, message = ops.unpin_task(plan, task_id)
            labels.append(message)
        elif body.start is not None:
            plan, message = ops.move_task_to(plan, task_id, body.start)
            labels.append(message)
    except ops.OpError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})

    if not labels:
        return plan_payload(sid, plan)
    return apply_edit(sid, (plan, "; ".join(labels)), f"правка «{task_id}»")


@app.post("/api/plan/tasks/{task_id}/reorder")
def reorder_task(
    task_id: str,
    body: TaskReorder,
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Перетаскивание строки списка: поставить задачу до или после другой."""
    sid = resolve_session(session_id, x_session_id)
    try:
        result = ops.reorder_task(current_plan(sid), task_id, before=body.before, after=body.after)
    except ops.OpError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})
    return apply_edit(sid, result, f"порядок «{task_id}»")


@app.delete("/api/plan/tasks/{task_id}")
def remove_task(
    task_id: str,
    reconnect: bool = Query(True),
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    try:
        result = ops.delete_task(current_plan(sid), task_id, reconnect=reconnect)
    except ops.OpError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})
    return apply_edit(sid, result, f"удалена задача «{task_id}»")


@app.post("/api/plan/project-start")
def change_project_start(
    start: date = Body(..., embed=True),
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    sid = resolve_session(session_id, x_session_id)
    try:
        result = ops.set_project_start(current_plan(sid), start)
    except ops.OpError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})
    return apply_edit(sid, result, f"старт проекта {start.isoformat()}")


# --- chat ------------------------------------------------------------------


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    request: Request,
    x_session_id: Optional[str] = Header(None),
) -> StreamingResponse:
    """Server-sent events for one agent turn.

    Event payloads: `message`, `tool_call`, `tool_result`, `plan`, `error`, `done`.
    """
    sid = resolve_session(body.session_id, x_session_id)
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail={"message": "Пустое сообщение"})
    try:
        model = settings.resolve_model(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc)})

    async def event_stream():
        try:
            async for event in run_turn(store, sid, message, model=model):
                if await request.is_disconnected():
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            payload = {"type": "error", "text": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/history")
def chat_history(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, Any]:
    """Переписка для восстановления чата после перезагрузки страницы."""
    sid = resolve_session(session_id, x_session_id)
    return {"session_id": sid, "entries": transcript(store, sid)}


@app.post("/api/chat/clear")
def clear_chat(
    session_id: Optional[str] = Query(None),
    x_session_id: Optional[str] = Header(None),
) -> dict[str, bool]:
    store.clear_chat(resolve_session(session_id, x_session_id))
    return {"ok": True}
