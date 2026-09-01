"""Persistence for plans, with an undo stack.

SQLite rather than an in-process dict for one specific reason: the MCP server
runs as a separate process (that is what makes it a real MCP server and not a
function call in disguise), and both processes must see the same plan. A file on
disk is the simplest thing that gives us that, plus history and undo for free —
and undo matters a lot when a chat message can rewrite twenty tasks at once.

Every save appends a snapshot; `head_seq` points at the current one. Undo moves
the pointer back, a following save truncates the abandoned future (classic undo
stack semantics).
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .models import Plan

DEFAULT_DB_PATH = Path(os.environ.get("PLAN_DB_PATH", "data/plans.sqlite3"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    head_seq    INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    plan_json   TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session
    ON chat_messages (session_id, id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class PlanStore:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(_SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        return conn

    # --- session lifecycle -------------------------------------------------

    def ensure_session(self, session_id: str, default_plan: Plan) -> Plan:
        """Return the session's plan, seeding it with `default_plan` if new."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT head_seq FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row:
                snap = conn.execute(
                    "SELECT plan_json FROM snapshots WHERE session_id = ? AND seq = ?",
                    (session_id, row["head_seq"]),
                ).fetchone()
                if snap:
                    return Plan.model_validate_json(snap["plan_json"])

            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, head_seq, created_at) VALUES (?, 1, ?)",
                (session_id, _now()),
            )
            conn.execute("DELETE FROM snapshots WHERE session_id = ?", (session_id,))
            conn.execute(
                "INSERT INTO snapshots (session_id, seq, plan_json, label, created_at) "
                "VALUES (?, 1, ?, ?, ?)",
                (session_id, default_plan.model_dump_json(), "исходный план", _now()),
            )
        return default_plan

    def get_plan(self, session_id: str) -> Optional[Plan]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT s.plan_json AS plan_json FROM sessions x "
                "JOIN snapshots s ON s.session_id = x.id AND s.seq = x.head_seq "
                "WHERE x.id = ?",
                (session_id,),
            ).fetchone()
        return Plan.model_validate_json(row["plan_json"]) if row else None

    def save_plan(self, session_id: str, plan: Plan, label: str) -> int:
        """Append a snapshot and make it current. Returns the new seq."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT head_seq FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            head = row["head_seq"] if row else 0
            conn.execute("DELETE FROM snapshots WHERE session_id = ? AND seq > ?", (session_id, head))
            new_seq = head + 1
            conn.execute(
                "INSERT INTO snapshots (session_id, seq, plan_json, label, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (session_id, new_seq, plan.model_dump_json(), label, _now()),
            )
            if row:
                conn.execute(
                    "UPDATE sessions SET head_seq = ? WHERE id = ?", (new_seq, session_id)
                )
            else:
                conn.execute(
                    "INSERT INTO sessions (id, head_seq, created_at) VALUES (?, ?, ?)",
                    (session_id, new_seq, _now()),
                )
        return new_seq

    def undo(self, session_id: str) -> tuple[Optional[Plan], str]:
        """Step one snapshot back. Returns (plan, label of the restored state)."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT head_seq FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not row or row["head_seq"] <= 1:
                return None, "Откатывать нечего — это исходное состояние плана"
            target = row["head_seq"] - 1
            snap = conn.execute(
                "SELECT plan_json, label FROM snapshots WHERE session_id = ? AND seq = ?",
                (session_id, target),
            ).fetchone()
            if not snap:
                return None, "История повреждена: снимок не найден"
            conn.execute("UPDATE sessions SET head_seq = ? WHERE id = ?", (target, session_id))
        return Plan.model_validate_json(snap["plan_json"]), f"Откат к состоянию «{snap['label']}»"

    def history(self, session_id: str) -> list[dict]:
        with self._conn() as conn:
            head_row = conn.execute(
                "SELECT head_seq FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not head_row:
                return []
            rows = conn.execute(
                "SELECT seq, label, created_at FROM snapshots WHERE session_id = ? ORDER BY seq",
                (session_id,),
            ).fetchall()
        return [
            {
                "seq": r["seq"],
                "label": r["label"],
                "created_at": r["created_at"],
                "is_current": r["seq"] == head_row["head_seq"],
            }
            for r in rows
        ]

    # --- chat history -----------------------------------------------------
    #
    # Переписка лежит рядом с планом, а не в памяти процесса: иначе обновление
    # страницы (или рестарт бэкенда) теряло бы контекст разговора. Храним ровно
    # те сообщения, которые уходят в LLM, — из них же собирается транскрипт для
    # интерфейса, так что двух источников правды нет.

    def append_chat(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        if not messages:
            return
        now = _now()
        with self._conn() as conn:
            conn.executemany(
                "INSERT INTO chat_messages (session_id, payload, created_at) VALUES (?, ?, ?)",
                [(session_id, json.dumps(message, ensure_ascii=False), now) for message in messages],
            )

    def chat_messages(self, session_id: str, limit: Optional[int] = None) -> list[dict[str, Any]]:
        """Сообщения по возрастанию времени. `limit` берёт последние N."""
        with self._conn() as conn:
            if limit is None:
                rows = conn.execute(
                    "SELECT payload FROM chat_messages WHERE session_id = ? ORDER BY id",
                    (session_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM chat_messages WHERE session_id = ? "
                    "ORDER BY id DESC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
                rows = list(reversed(rows))
        messages = [json.loads(row["payload"]) for row in rows]
        # история не должна начинаться с результата инструмента: без своего
        # вызова он ломает запрос к модели
        while messages and messages[0].get("role") == "tool":
            messages = messages[1:]
        return messages

    def clear_chat(self, session_id: str) -> None:
        with self._conn() as conn:
            conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))

    def reset(self, session_id: str, plan: Plan, label: str = "план загружен") -> None:
        """Drop the history and start over from `plan` (used by Excel import)."""
        with self._conn() as conn:
            conn.execute("DELETE FROM snapshots WHERE session_id = ?", (session_id,))
            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, head_seq, created_at) VALUES (?, 1, ?)",
                (session_id, _now()),
            )
            conn.execute(
                "INSERT INTO snapshots (session_id, seq, plan_json, label, created_at) "
                "VALUES (?, 1, ?, ?, ?)",
                (session_id, plan.model_dump_json(), label, _now()),
            )
