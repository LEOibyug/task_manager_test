from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.database import Database
from app.core.settings import RuntimeSettings
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.job_service import JobService
from app.services.log_service import LogService
from app.services.ssh_service import InMemorySSHGateway, SSHError


class LogServiceTestCase(unittest.TestCase):
    def test_read_log_normalizes_percent_j_template_from_existing_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            db_path = Path(temp_dir) / "app.db"
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database = Database(db_path)
            database.initialize()
            database.upsert_job(
                JobRecord(
                    job_id="25389",
                    account="worker1",
                    experiment="exp001",
                    script_path="/srv/worker1/repo/experiments/exp001/run.sbatch",
                    log_path="/srv/worker1/repo/output/sbatch/exp001.%j.out",
                    log_path_template="output/sbatch/exp001.%j.out",
                )
            )
            gateway = InMemorySSHGateway(
                files={"worker1": {"/srv/worker1/repo/output/sbatch/exp001.25389.out": "hello\nworld\n"}}
            )
            job_service = JobService(config_service, gateway, database)
            service = LogService(gateway, job_service, RuntimeSettings())

            result = service.read_log("25389", tail=True)

            self.assertEqual(result.log_path, "/srv/worker1/repo/output/sbatch/exp001.25389.out")
            self.assertIn("hello", result.content)

    def test_missing_remote_log_raises_ssh_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            db_path = Path(temp_dir) / "app.db"
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database = Database(db_path)
            database.initialize()
            database.upsert_job(
                JobRecord(
                    job_id="25389",
                    account="worker1",
                    experiment="exp001",
                    script_path="/srv/worker1/repo/experiments/exp001/run.sbatch",
                    log_path="/srv/worker1/repo/logs/missing.out",
                )
            )
            gateway = InMemorySSHGateway(files={"worker1": {}})
            job_service = JobService(config_service, gateway, database)
            service = LogService(gateway, job_service, RuntimeSettings())

            with self.assertRaises(SSHError):
                service.read_log("25389", tail=True)


if __name__ == "__main__":
    unittest.main()
