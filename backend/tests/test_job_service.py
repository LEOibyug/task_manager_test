from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.core.database import Database
from app.schemas import AppConfig, JobRecord, SubmitJobRequest
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
        log_path, job_name = service.parse_sbatch_metadata("#!/bin/bash\n", "/tmp/run.sbatch", "exp001")
        self.assertEqual(log_path, "slurm-%j.out")
        self.assertIsNone(job_name)

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
            ("worker1", "/srv/worker1/repo::sbatch experiments/exp001/train.sbatch -w gpu1"): CommandResult(
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
                preferred_gpu_node="gpu1",
            )
        )
        self.assertEqual(job.job_id, "12345")
        self.assertEqual(job.status, "PENDING")
        self.assertEqual(job.output_path_hint, "output/exp001")
        self.assertEqual(job.log_path_template, "logs/train.out")
        self.assertEqual(job.preferred_gpu_node, "gpu1")
        self.assertIsNotNone(self.database.get_job("12345"))

    def test_submit_job_to_main_account_skips_git_pull(self) -> None:
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
        files = {
            "main": {
                "/srv/main/repo/experiments/exp001/train.sbatch": "#SBATCH -o logs/train.out\n#SBATCH -J runMain\n",
            }
        }
        commands = {
            ("main", "::squeue -u \"main\" -h -o \"%T\""): CommandResult(
                command="squeue",
                stdout="PENDING\n",
                stderr="",
                exit_code=0,
            ),
            ("main", "/srv/main/repo::sbatch experiments/exp001/train.sbatch"): CommandResult(
                command="sbatch",
                stdout="Submitted batch job 54321\n",
                stderr="",
                exit_code=0,
            ),
        }
        gateway = InMemorySSHGateway(files=files, commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        job = service.submit_job(
            SubmitJobRequest(
                experiment_name="exp001",
                script_path="/srv/main/repo/experiments/exp001/train.sbatch",
                account="main",
                preferred_gpu_node=None,
            )
        )
        self.assertEqual(job.job_id, "54321")
        self.assertEqual(job.account, "main")

    def test_submit_job_resolves_log_path_with_job_id(self) -> None:
        files = {
            "worker1": {
                "/srv/worker1/repo/experiments/exp001/train.sbatch": "#SBATCH -o output/sbatch/slurm-%j.out\n",
            }
        }
        commands = {
            ("worker1", "::squeue -u \"worker1\" -h -o \"%T\""): CommandResult(
                command="squeue",
                stdout="PENDING\n",
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
            ("worker1", "/srv/worker1/repo::sbatch experiments/exp001/train.sbatch -w gpu1"): CommandResult(
                command="sbatch",
                stdout="Submitted batch job 67890\n",
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
                preferred_gpu_node="gpu1",
            )
        )
        self.assertEqual(job.log_path, "/srv/worker1/repo/output/sbatch/slurm-67890.out")
        self.assertEqual(job.output_path_hint, "output/exp001")

    def test_submit_job_without_gpu_whitelist_uses_plain_sbatch(self) -> None:
        files = {
            "worker1": {
                "/srv/worker1/repo/experiments/exp001/train.sbatch": "#SBATCH -o logs/train.out\n",
            }
        }
        commands = {
            ("worker1", "::squeue -u \"worker1\" -h -o \"%T\""): CommandResult(
                command="squeue",
                stdout="PENDING\n",
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
            ("worker1", "/srv/worker1/repo::sbatch experiments/exp001/train.sbatch"): CommandResult(
                command="sbatch",
                stdout="Submitted batch job 67891\n",
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
                preferred_gpu_node=None,
            )
        )
        self.assertEqual(job.job_id, "67891")

    def test_list_jobs_marks_subuser_job_synced_by_main_files(self) -> None:
        gateway = InMemorySSHGateway(
            files={
                "main": {
                    "/srv/main/repo/output/sbatch/train.out": "done\n",
                    "/srv/main/repo/output/exp001/result.txt": "ok\n",
                }
            }
        )
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="20001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="COMPLETED",
                log_path="/srv/worker1/repo/logs/train.out",
                output_path_hint="output/exp001",
            )
        )
        jobs = service.list_jobs().jobs
        self.assertEqual(len(jobs), 1)
        self.assertTrue(jobs[0].synced)

    def test_cancel_job_only_records_cancel_request(self) -> None:
        commands = {
            ("worker1", "::scancel 30001"): CommandResult(
                command="scancel",
                stdout="",
                stderr="",
                exit_code=0,
            )
        }
        gateway = InMemorySSHGateway(commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="30001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="RUNNING",
            )
        )
        job = service.cancel_job("30001")
        self.assertEqual(job.status, "RUNNING")
        self.assertEqual(job.last_error, "已提交取消请求，等待 Slurm 状态刷新")

    def test_refresh_jobs_queries_each_recorded_job_account(self) -> None:
        commands = {
            ("main", "::squeue -u \"main\" -h -o \"%i|%T|%M|%S|%R\""): CommandResult(
                command="squeue",
                stdout="50001|RUNNING|00:03|2026-04-28T10:00:00|gpu1\n",
                stderr="",
                exit_code=0,
            ),
            ("main", "::sacct -j \"50001\" --format=JobID,State,Elapsed -n -P"): CommandResult(
                command="sacct",
                stdout="50001|RUNNING|00:03\n",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "::squeue -u \"worker1\" -h -o \"%i|%T|%M|%S|%R\""): CommandResult(
                command="squeue",
                stdout="",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "::sacct -u \"worker1\" --format=JobID,State,Elapsed -n -P"): CommandResult(
                command="sacct",
                stdout="",
                stderr="",
                exit_code=0,
            ),
        }
        gateway = InMemorySSHGateway(commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="50001",
                account="main",
                experiment="exp001",
                script_path="/srv/main/repo/experiments/exp001/train.sbatch",
                status="PENDING",
            )
        )
        jobs = service.refresh_jobs().jobs
        self.assertTrue(any(job.job_id == "50001" and job.account == "main" for job in jobs))

    def test_refresh_jobs_does_not_overwrite_known_experiment_with_unknown_placeholder(self) -> None:
        gateway = InMemorySSHGateway()
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="50002",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                preferred_gpu_node="gpu1",
                status="PENDING",
                log_path="/srv/worker1/repo/logs/train.out",
                output_path_hint="output/exp001",
            )
        )

        def fake_refresh_account_jobs(username, existing_jobs, logger=None):
            self.assertEqual(username, "worker1")
            return [
                JobRecord(
                    job_id="50002",
                    account="worker1",
                    experiment="unknown",
                    script_path="",
                    status="RUNNING",
                    runtime="00:05",
                )
            ]

        service._refresh_account_jobs = fake_refresh_account_jobs  # type: ignore[method-assign]

        jobs = service.refresh_jobs().jobs

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].job_id, "50002")
        self.assertEqual(jobs[0].experiment, "exp001")
        self.assertEqual(jobs[0].script_path, "/srv/worker1/repo/experiments/exp001/train.sbatch")
        self.assertEqual(jobs[0].preferred_gpu_node, "gpu1")
        self.assertEqual(jobs[0].log_path, "/srv/worker1/repo/logs/train.out")
        self.assertEqual(jobs[0].output_path_hint, "output/exp001")
        self.assertEqual(jobs[0].status, "RUNNING")
        self.assertEqual(jobs[0].runtime, "00:05")

    def test_clear_jobs_removes_all_records(self) -> None:
        gateway = InMemorySSHGateway()
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="40001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="COMPLETED",
            )
        )
        self.database.upsert_job(
            JobRecord(
                job_id="40002",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="RUNNING",
            )
        )
        service.clear_jobs()
        jobs = service.list_jobs().jobs
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].job_id, "40002")

    def test_delete_failed_job_removes_only_failed_record(self) -> None:
        gateway = InMemorySSHGateway()
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="41001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="FAILED",
            )
        )

        service.delete_failed_job("41001")

        self.assertIsNone(self.database.get_job("41001"))

    def test_delete_failed_job_rejects_active_record(self) -> None:
        gateway = InMemorySSHGateway()
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="41002",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="RUNNING",
            )
        )

        with self.assertRaisesRegex(Exception, "Only failed jobs"):
            service.delete_failed_job("41002")

        self.assertIsNotNone(self.database.get_job("41002"))

    def test_retry_timeout_job_creates_continuation_job(self) -> None:
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
            ("worker1", "/srv/worker1/repo::sbatch experiments/exp001/train.sbatch -w gpu1"): CommandResult(
                command="sbatch",
                stdout="Submitted batch job 60002\n",
                stderr="",
                exit_code=0,
            ),
        }
        gateway = InMemorySSHGateway(files=files, commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="60001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                preferred_gpu_node="gpu1",
                status="TIMEOUT",
                last_error="TIMEOUT",
            )
        )

        new_job = service.retry_job("60001")

        self.assertEqual(new_job.job_id, "60002")
        self.assertEqual(new_job.resumed_from_job_id, "60001")
        self.assertEqual(new_job.continuation_root_job_id, "60001")
        self.assertEqual(new_job.preferred_gpu_node, "gpu1")
        original_job = self.database.get_job("60001")
        self.assertEqual(original_job.continuation_root_job_id, "60001")

    def test_refresh_jobs_marks_timeout_as_timeout_status(self) -> None:
        commands = {
            ("worker1", "::squeue -u \"worker1\" -h -o \"%i|%T|%M|%S|%R\""): CommandResult(
                command="squeue",
                stdout="",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "::sacct -j \"61001\" --format=JobID,State,Elapsed -n -P"): CommandResult(
                command="sacct",
                stdout="61001|TIMEOUT|48:00:00\n",
                stderr="",
                exit_code=0,
            ),
            ("worker1", "::seff 61001"): CommandResult(
                command="seff",
                stdout="Job ID: 61001\n",
                stderr="",
                exit_code=0,
            ),
        }
        gateway = InMemorySSHGateway(commands=commands)
        service = JobService(self.config_service, gateway, self.database)
        self.database.upsert_job(
            JobRecord(
                job_id="61001",
                account="worker1",
                experiment="exp001",
                script_path="/srv/worker1/repo/experiments/exp001/train.sbatch",
                status="RUNNING",
            )
        )

        jobs = service.refresh_jobs().jobs

        self.assertEqual(jobs[0].status, "TIMEOUT")
        self.assertEqual(jobs[0].last_error, "TIMEOUT")


if __name__ == "__main__":
    unittest.main()
