from __future__ import annotations

import json
from pathlib import Path

from app.schemas import AppConfig


class ConfigService:
    def __init__(self, config_file: Path) -> None:
        self.config_file = config_file
        self.config_file.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> AppConfig:
        if not self.config_file.exists():
            config = AppConfig()
            self.save(config)
            return config
        raw = json.loads(self.config_file.read_text(encoding="utf-8"))
        return AppConfig.model_validate(raw)

    def save(self, config: AppConfig) -> AppConfig:
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self.config_file.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        return config

