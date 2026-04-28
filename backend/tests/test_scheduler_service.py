from __future__ import annotations

import asyncio
import tempfile
import unittest
from contextlib import suppress
from pathlib import Path

from app.core.database import Database
from app.core.settings import RuntimeSettings
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.job_service import JobService
from app.services.log_service import LogService
from app.services.scheduler_service import JobLogTracker, SchedulerService
from app.services.ssh_service import CommandResult, InMemorySSHGateway


class FakeBroadcaster:
    def __init__(self) -> None:
        self.connections = {object()}
        self.events = []

    async def broadcast(self, event) -> None:
        self.events.append(event)


class SchedulerServiceTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_publish_job_log_update_broadcasts_once_per_change(self) -> None:
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
                    status="RUNNING",
                )
            )
            grep_command = "grep -a -n -- latest_eval= /srv/worker1/repo/logs/train.out | tail -n 12"
            gateway = InMemorySSHGateway(
                files={
                    "worker1": {
                        "/srv/worker1/repo/logs/train.out": (
                            "train: 34%|███▍| 15336/45164 [2:31:43<6:01:06, 1.38it/s]\n"
                        )
                    }
                },
                commands={
                    ("worker1", f"::{grep_command}"): CommandResult(
                        command=grep_command,
                        stdout="120:latest_eval=ads/EVTOL=79.4650, ads/Helicopter=75.5664\n",
                        stderr="",
                        exit_code=0,
                    )
                },
            )
            job_service = JobService(config_service, gateway, database)
            log_service = LogService(gateway, job_service, RuntimeSettings())
            broadcaster = FakeBroadcaster()
            scheduler = SchedulerService(config_service, job_service, broadcaster, log_service=log_service)
            placeholder_task = asyncio.create_task(asyncio.sleep(3600))
            scheduler._job_log_trackers["25389"] = JobLogTracker(task=placeholder_task)
            try:
                changed = await scheduler._publish_job_log_update("25389", include_eval=True)
                unchanged = await scheduler._publish_job_log_update("25389", include_eval=True)
            finally:
                placeholder_task.cancel()
                with suppress(asyncio.CancelledError):
                    await placeholder_task

            self.assertTrue(changed)
            self.assertFalse(unchanged)
            self.assertEqual(len(broadcaster.events), 1)
            payload = broadcaster.events[0].payload
            self.assertEqual(payload["job_id"], "25389")
            self.assertEqual(payload["log"]["view"], "preview")
            self.assertEqual(payload["eval_log"]["entries"][0]["line_number"], 120)


if __name__ == "__main__":
    unittest.main()
