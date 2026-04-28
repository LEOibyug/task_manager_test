from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field


class RuntimeSettings(BaseModel):
    app_name: str = "Exp-Queue-Manager"
    api_prefix: str = "/api"
    host: str = "127.0.0.1"
    port: int = 8000
    config_dir: Path = Field(default_factory=lambda: Path.home() / ".exp-queue-manager")
    config_file: Path = Field(default_factory=lambda: Path.home() / ".exp-queue-manager" / "config.json")
    data_dir: Path = Field(default_factory=lambda: Path(__file__).resolve().parents[2] / "data")
    database_path: Path = Field(default_factory=lambda: Path(__file__).resolve().parents[2] / "data" / "app.db")
    frontend_dist: Path = Field(default_factory=lambda: Path(__file__).resolve().parents[3] / "frontend" / "dist")
    max_log_chunk_bytes: int = 65536
    preview_log_chunk_bytes: int = 16384


@lru_cache
def get_settings() -> RuntimeSettings:
    settings = RuntimeSettings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        settings.config_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        fallback_dir = settings.data_dir / "runtime-config"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        settings.config_dir = fallback_dir
        settings.config_file = fallback_dir / "config.json"
    return settings
