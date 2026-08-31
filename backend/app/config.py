"""Runtime configuration, all of it from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


@dataclass
class Settings:
    # LLM: any OpenAI-compatible endpoint; OpenRouter by default.
    llm_base_url: str = os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")
    llm_api_key: str = os.environ.get("OPENROUTER_API_KEY", os.environ.get("LLM_API_KEY", ""))
    llm_model: str = os.environ.get("LLM_MODEL", "anthropic/claude-sonnet-5")
    llm_timeout_seconds: float = float(os.environ.get("LLM_TIMEOUT_SECONDS", "120"))
    max_tool_steps: int = int(os.environ.get("MAX_TOOL_STEPS", "10"))
    history_limit: int = int(os.environ.get("HISTORY_LIMIT", "40"))

    # Sent by OpenRouter's convention so usage shows up attributed in its dashboard.
    app_url: str = os.environ.get("APP_URL", "http://localhost:5173")
    app_title: str = os.environ.get("APP_TITLE", "Gantt Plan Agent")

    db_path: Path = Path(os.environ.get("PLAN_DB_PATH", "data/plans.sqlite3"))
    cors_origins: list[str] = field(
        default_factory=lambda: _split(
            os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        )
    )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_api_key)


settings = Settings()
