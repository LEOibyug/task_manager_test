from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.schemas import AppConfig
from app.services.config_service import ConfigService


class ConfigServiceTestCase(unittest.TestCase):
    def test_load_creates_default_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            service = ConfigService(config_path)
            config = service.load()
            self.assertTrue(config_path.exists())
            self.assertEqual(config.server_port, 22)

    def test_save_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            service = ConfigService(config_path)
            service.save(
                AppConfig(
                    server_ip="10.0.0.1",
                    server_port=2200,
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/repos/main", "worker1": "/repos/worker1"},
                    refresh_interval=15,
                )
            )
            loaded = service.load()
            self.assertEqual(loaded.server_ip, "10.0.0.1")
            self.assertEqual(loaded.repo_paths["worker1"], "/repos/worker1")


if __name__ == "__main__":
    unittest.main()

