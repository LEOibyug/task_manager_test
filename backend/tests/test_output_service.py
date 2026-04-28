from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.database import Database
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.job_service import JobService
from app.services.output_service import OutputService
from app.services.ssh_service import InMemorySSHGateway


class OutputServiceTestCase(unittest.TestCase):
    def test_falls_back_to_existing_parent_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            database = Database(Path(temp_dir) / "app.db")
            database.initialize()
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database.upsert_job(
                JobRecord(
                    job_id="25400",
                    account="worker1",
                    experiment="exp060",
                    script_path="/srv/worker1/repo/experiments/exp060/run.sbatch",
                    output_path_hint="output/exp060/model_config/exp060_uncertainty_fused_geometryaware_nohybrid_1gpu",
                )
            )
            gateway = InMemorySSHGateway(
                files={
                    "worker1": {
                        "/srv/worker1/repo/output/exp060/placeholder.txt": "",
                    }
                }
            )
            job_service = JobService(config_service, gateway, database)
            service = OutputService(gateway, job_service)

            tree = service.get_tree("25400")

            self.assertEqual(tree.root.path, "/srv/worker1/repo/output/exp060")

    def test_falls_back_to_output_experiment_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            database = Database(Path(temp_dir) / "app.db")
            database.initialize()
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database.upsert_job(
                JobRecord(
                    job_id="1",
                    account="worker1",
                    experiment="exp001",
                    script_path="/srv/worker1/repo/experiments/exp001/run.sbatch",
                    output_path_hint="output/exp001/model_config/tagA",
                )
            )
            gateway = InMemorySSHGateway(
                files={
                    "worker1": {
                        "/srv/worker1/repo/output/exp001/metrics.json": "{}",
                    }
                }
            )
            job_service = JobService(config_service, gateway, database)
            service = OutputService(gateway, job_service)
            tree = service.get_tree("1")
            self.assertEqual(tree.root.path, "/srv/worker1/repo/output/exp001")
            self.assertEqual(tree.root.children[0].name, "metrics.json")

    def test_ignores_output_sbatch_log_directory_and_uses_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            database = Database(Path(temp_dir) / "app.db")
            database.initialize()
            config_service = ConfigService(config_path)
            config_service.save(
                AppConfig(
                    main_username="main",
                    sub_usernames=["worker1"],
                    repo_paths={"main": "/srv/main/repo", "worker1": "/srv/worker1/repo"},
                )
            )
            database.upsert_job(
                JobRecord(
                    job_id="67890",
                    account="worker1",
                    experiment="exp001",
                    script_path="/srv/worker1/repo/experiments/exp001/run.sbatch",
                    output_path_hint="output/exp001",
                    log_path="/srv/worker1/repo/output/sbatch/slurm-67890.out",
                    log_path_template="output/sbatch/slurm-%j.out",
                )
            )
            gateway = InMemorySSHGateway(
                files={
                    "worker1": {
                        "/srv/worker1/repo/output/sbatch/slurm-67890.out": "log",
                        "/srv/worker1/repo/output/exp001/metrics.json": "{}",
                    }
                }
            )
            job_service = JobService(config_service, gateway, database)
            service = OutputService(gateway, job_service)
            tree = service.get_tree("67890")
            self.assertEqual(tree.root.path, "/srv/worker1/repo/output/exp001")
            self.assertEqual(tree.root.children[0].name, "metrics.json")


if __name__ == "__main__":
    unittest.main()
