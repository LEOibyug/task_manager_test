from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.database import Database
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.ssh_service import CommandResult, InMemorySSHGateway
from app.services.sync_service import SyncService


class SyncServiceTestCase(unittest.TestCase):
    def test_sync_runs_from_subuser_to_mainuser(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            db_path = Path(temp_dir) / "app.db"
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    server_ip="10.0.0.1",
                    server_port=2200,
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database = Database(db_path)
            database.initialize()
            job = JobRecord(
                job_id="123",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/run.sbatch",
                status="COMPLETED",
                log_path="/srv/worker1/repo/logs/run.out",
                output_path_hint="output/exp001/model_config/runA",
            )
            database.upsert_job(job)
            commands = {
                ("worker1", "::ssh main@workstation 'mkdir -p /srv/main/repo/output'"): CommandResult(
                    command="mkdir output",
                    stdout="",
                    stderr="",
                    exit_code=0,
                ),
                ("worker1", "::ssh main@workstation 'mkdir -p /srv/main/repo/logs'"): CommandResult(
                    command="mkdir logs",
                    stdout="",
                    stderr="",
                    exit_code=0,
                ),
                ("worker1", "::scp -r /srv/worker1/repo/output/exp001 main@workstation:/srv/main/repo/output"): CommandResult(
                    command="scp output",
                    stdout="",
                    stderr="",
                    exit_code=0,
                ),
                ("worker1", "::scp -r /srv/worker1/repo/logs/run.out main@workstation:/srv/main/repo/logs/run.out"): CommandResult(
                    command="scp log",
                    stdout="",
                    stderr="",
                    exit_code=0,
                ),
            }
            gateway = InMemorySSHGateway(commands=commands)
            service = SyncService(config_service=config_service, ssh_gateway=gateway, database=database)

            synced = service.sync_job(job)

            self.assertTrue(synced.synced)
            self.assertTrue(database.get_job("123").synced)


if __name__ == "__main__":
    unittest.main()
