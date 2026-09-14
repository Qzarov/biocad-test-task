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
    # Модели, которые разрешено выбирать в интерфейсе. Все из списка ниже
    # проверены на поддержку tool-calling — без него агент бесполезен.
    llm_models: list[str] = field(
        default_factory=lambda: _split(
            os.environ.get(
                "LLM_MODELS",
                "anthropic/claude-sonnet-5,anthropic/claude-opus-5,"
                "openai/gpt-5.6-terra,google/gemini-3.7-flash,"
                "deepseek/deepseek-chat-v3.1,qwen/qwen3-max",
            )
        )
    )
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

    @property
    def available_models(self) -> list[str]:
        """Список для интерфейса: модель по умолчанию всегда первая и всегда есть."""
        models = [self.llm_model] + [m for m in self.llm_models if m != self.llm_model]
        return models

    def resolve_model(self, requested: str | None) -> str:
        """Проверить выбранную модель по белому списку.

        Без проверки поле model из браузера стало бы способом гонять любые
        (в том числе дорогие) модели за счёт нашего ключа.
        """
        if not requested:
            return self.llm_model
        if requested not in self.available_models:
            raise ValueError(
                f"Модель «{requested}» не разрешена. Доступны: {', '.join(self.available_models)}"
            )
        return requested


settings = Settings()
