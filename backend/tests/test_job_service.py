from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.database import Database
from app.schemas import AppConfig, SubmitJobRequest
from app.services.config_service import ConfigService
from app.services.job_service import JobService
from app.services.ssh_service import CommandResult, InMemorySSHGateway


class JobServiceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        config_path = Path(self.temp_dir.name) / "config.json"
        db_path = Path(self.temp_dir.name) / "app.db"
        self.config_service = ConfigService(config_path)
        self.config_service.save(
            AppConfig(
                server_ip="10.0.0.1",
                main_username="main",
                sub_usernames=["worker1"],
                repo_paths={
                    "main": "/srv/main/repo",
                    "worker1": "/srv/worker1/repo",
                },
            )
        )
        self.database = Database(db_path)
        self.database.initialize()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_parse_sbatch_metadata_with_defaults(self) -> None:
        gateway = InMemorySSHGateway()
        service = JobService(self.config_service, gateway, self.database)
        log_path, job_name, output_hint = service.parse_sbatch_metadata("#!/bin/bash\n", "/tmp/run.sbatch", "exp001")
        self.assertEqual(log_path, "slurm-%j.out")
        self.assertIsNone(job_name)
        self.assertEqual(output_hint, "output/exp001")

    def test_submit_job_records_pending_job(self) -> None:
        files = {
            "worker1": {
                "/srv/worker1/repo/experiments/exp001/train.sbatch": "#SBATCH -o logs/train.out\n#SBATCH -J runA\n",
            }
        }
        commands = {
            ("worker1", "::squeue -u \"worker1\" -h -o \"%T\""): CommandResult(
                command="squeue",
                stdout="RUNNING\n",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "/srv/worker1/repo::git rev-parse --abbrev-ref HEAD"): CommandResult(
                command="git rev-parse",
                stdout="main\n",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "/srv/worker1/repo::git pull origin main"): CommandResult(
                command="git pull",
                stdout="Already up to date.\n",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "/srv/worker1/repo::sbatch experiments/exp001/train.sbatch -w gpu1,gpu2,gpu3"): CommandResult(
                command="sbatch",
                stdout="Submitted batch job 12345\n",
                stderr="",
                exit_code=0,
            ),
        }
        gateway = InMemorySSHGateway(files=files, commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        job = service.submit_job(
            SubmitJobRequest(
                experiment_name="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                account="worker1",
            )
        )
        self.assertEqual(job.job_id, "12345")
        self.assertEqual(job.status, "PENDING")
        self.assertEqual(job.output_path_hint, "output/exp001/model_config/runA")
        self.assertIsNotNone(self.database.get_job("12345"))


if __name__ == "__main__":
    unittest.main()

