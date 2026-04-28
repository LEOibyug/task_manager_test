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
from app.services.ssh_service import CommandResult, InMemorySSHGateway, SSHError


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

    def test_preview_log_reads_only_tail_chunk(self) -> None:
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
                    log_path="/srv/worker1/repo/logs/train.out",
                )
            )
            content = "line1\nline2\ntrain: 34%|███▍| 15336/45164 [2:31:43<6:01:06, 1.38it/s]\n"
            gateway = InMemorySSHGateway(files={"worker1": {"/srv/worker1/repo/logs/train.out": content}})
            job_service = JobService(config_service, gateway, database)
            settings = RuntimeSettings(preview_log_chunk_bytes=24)
            service = LogService(gateway, job_service, settings)

            result = service.read_log("25389", view="preview")

            self.assertEqual(result.view, "preview")
            self.assertTrue(result.truncated)
            self.assertEqual(result.size, len(content.encode("utf-8")))
            self.assertIn("1.38it/s", result.content)

    def test_read_eval_lines_uses_remote_grep_on_job_account(self) -> None:
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
                    log_path="/srv/worker1/repo/logs/train.out",
                )
            )
            grep_command = "grep -a -n -- latest_eval= /srv/worker1/repo/logs/train.out | tail -n 12"
            gateway = InMemorySSHGateway(
                commands={
                    ("worker1", f"::{grep_command}"): CommandResult(
                        command=grep_command,
                        stdout=(
                            "120:latest_eval=ads/EVTOL=79.4650, ads/Helicopter=75.5664\n"
                            "240:latest_eval=ads/EVTOL=80.0000, ads/Helicopter=76.0000\n"
                        ),
                        stderr="",
                        exit_code=0,
                    )
                }
            )
            job_service = JobService(config_service, gateway, database)
            service = LogService(gateway, job_service, RuntimeSettings())

            result = service.read_eval_lines("25389")

            self.assertEqual(len(result.entries), 2)
            self.assertEqual(result.entries[0].line_number, 120)
            self.assertIn("ads/EVTOL=80.0000", result.entries[1].content)


if __name__ == "__main__":
    unittest.main()
