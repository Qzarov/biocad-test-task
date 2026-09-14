"""MCP client: the bridge between the LLM and the plan-editing tools.

The backend does not call `app.ops` directly when the agent is working. It spawns
the MCP server as a child process over stdio, lists its tools, converts their
JSON schemas into the tool format the LLM API expects, and forwards tool calls.
That keeps the contract honest: the model can only do to the plan what the MCP
server exposes.

One process per chat turn, torn down afterwards. Simple and leak-free; pooling is
listed as a known trade-off in the roadmap.
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

BACKEND_ROOT = Path(__file__).resolve().parents[2]


@asynccontextmanager
async def plan_tools_session(
    session_id: str, db_path: str | Path
) -> AsyncIterator[ClientSession]:
    """Start the plan MCP server for `session_id` and yield an initialised session."""
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "app.mcp_server"],
        cwd=str(BACKEND_ROOT),
        env={
            **os.environ,
            "PLAN_SESSION_ID": session_id,
            "PLAN_DB_PATH": str(db_path),
            "PYTHONPATH": str(BACKEND_ROOT),
            "PYTHONUNBUFFERED": "1",
        },
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def list_tool_specs(session: ClientSession) -> list[dict[str, Any]]:
    """MCP tool definitions → OpenAI-compatible `tools` array."""
    listed = await session.list_tools()
    specs: list[dict[str, Any]] = []
    for tool in listed.tools:
        schema = tool.inputSchema or {"type": "object", "properties": {}}
        specs.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": (tool.description or "").strip(),
                    "parameters": _sanitise_schema(schema),
                },
            }
        )
    return specs


def _sanitise_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Flatten the bits of JSON Schema that some providers reject.

    FastMCP emits `anyOf: [{type: X}, {type: null}]` for optional arguments;
    several OpenRouter-hosted models handle that poorly, so we collapse those
    unions to the non-null branch and drop `$defs` indirection we do not use.
    """
    cleaned = {k: v for k, v in schema.items() if k not in {"$defs", "additionalProperties"}}
    props = cleaned.get("properties")
    if isinstance(props, dict):
        cleaned["properties"] = {name: _sanitise_property(spec) for name, spec in props.items()}
    return cleaned


def _sanitise_property(spec: Any) -> Any:
    if not isinstance(spec, dict):
        return spec
    out = dict(spec)
    variants = out.pop("anyOf", None)
    if variants:
        concrete = next(
            (v for v in variants if isinstance(v, dict) and v.get("type") not in (None, "null")),
            None,
        )
        if concrete:
            out = {**concrete, **{k: v for k, v in out.items() if k in {"description", "default", "title"}}}
    if out.get("type") == "array" and isinstance(out.get("items"), dict):
        out["items"] = _sanitise_property(out["items"])
    out.pop("title", None)
    return out


async def call_tool(session: ClientSession, name: str, arguments: dict[str, Any]) -> str:
    """Invoke an MCP tool and flatten its content blocks into text."""
    result = await session.call_tool(name, arguments or {})
    chunks: list[str] = []
    for block in result.content:
        text = getattr(block, "text", None)
        chunks.append(text if text is not None else str(block))
    text = "\n".join(c for c in chunks if c).strip()
    if result.isError:
        return f"ОШИБКА: {text or 'инструмент завершился с ошибкой'}"
    return text or "готово"
