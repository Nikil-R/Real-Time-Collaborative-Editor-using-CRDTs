"""Server configuration, read from environment variables (see .env.example)."""

from __future__ import annotations

import uuid

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres in Docker/production. The default is a local SQLite file so the
    # server also starts on a machine without Postgres (development only).
    database_url: str = "sqlite+aiosqlite:///./collab-dev.db"
    # Leave empty to run a single process without Redis fan-out.
    redis_url: str | None = None

    max_message_bytes: int = 262_144
    max_ops_per_batch: int = 500
    rate_limit_ops_per_sec: int = 200
    # Comma separated list of allowed browser origins. "*" allows any.
    allowed_origins: str = "http://localhost:3000"
    log_level: str = "info"
    idle_timeout_sec: int = 300
    send_queue_size: int = 1000
    catchup_page_size: int = 5000
    hello_timeout_sec: float = 10.0
    max_clients_per_document: int = 200
    # Create tables on start-up. Production runs `alembic upgrade head` instead.
    auto_create_tables: bool = False

    server_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])

    @property
    def async_database_url(self) -> str:
        """Accept plain `postgresql://` URLs and pick the async driver."""
        url = self.database_url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url.removeprefix("postgresql://")
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url.removeprefix("postgres://")
        return url

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]
