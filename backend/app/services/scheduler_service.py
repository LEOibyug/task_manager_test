from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic

from fastapi import WebSocket

from app.schemas import EvalLogResponse, LogResponse, StatusEvent
from app.services.config_service import ConfigService
from app.services.job_service import JobService
from app.services.log_service import LogService
from app.services.ssh_service import SSHError


TRACKABLE_JOB_STATUSES = {"RUNNING", "PENDING"}
LOG_PREVIEW_INTERVAL_SECONDS = 1.5
EVAL_REFRESH_INTERVAL_SECONDS = 8.0


@dataclass
class JobLogTracker:
    task: asyncio.Task[None]
    last_log_fingerprint: tuple[str, int, int, str] | None = None
    last_eval_fingerprint: tuple[tuple[int | None, str], ...] | None = None
    next_eval_at: float = 0.0


class StatusBroadcaster:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, event: StatusEvent) -> None:
        dead_connections: list[WebSocket] = []
        for socket in self.connections:
            try:
                await socket.send_json(event.model_dump(mode="json"))
            except RuntimeError:
                dead_connections.append(socket)
        for socket in dead_connections:
            self.disconnect(socket)

    def build_command_event(self, payload: dict[str, object]) -> StatusEvent:
        return StatusEvent(type="command_log", payload=payload)


class SchedulerService:
    def __init__(
        self,
        config_service: ConfigService,
        job_service: JobService,
        broadcaster: StatusBroadcaster,
        log_service: LogService | None = None,
    ) -> None:
        self.config_service = config_service
        self.job_service = job_service
        self.broadcaster = broadcaster
        self.log_service = log_service
        self.task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._job_log_trackers: dict[str, JobLogTracker] = {}

    def build_jobs_refreshed_event(self, jobs) -> StatusEvent:
        return StatusEvent(
            type="jobs_refreshed",
            payload={"jobs": [job.model_dump(mode="json") for job in jobs]},
        )

    def build_job_log_cache_event(
        self,
        job_id: str,
        *,
        log: LogResponse | None = None,
        eval_log: EvalLogResponse | None = None,
    ) -> StatusEvent:
        payload: dict[str, object] = {"job_id": job_id}
        if log is not None:
            payload["log"] = log.model_dump(mode="json")
        if eval_log is not None:
            payload["eval_log"] = eval_log.model_dump(mode="json")
        return StatusEvent(type="job_log_cache_update", payload=payload)

    async def start(self) -> None:
        if self.task is None:
            self._stop.clear()
            self.task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop.set()
        if self.task is not None:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        await self._stop_all_log_trackers()

    async def trigger_refresh(self) -> None:
        jobs = self.job_service.refresh_jobs()
        await self.sync_log_tracking(jobs.jobs)
        await self.broadcaster.broadcast(self.build_jobs_refreshed_event(jobs.jobs))

    async def _run_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.trigger_refresh()
            except Exception as exc:  # pragma: no cover - best effort background reporting
                await self.broadcaster.broadcast(
                    StatusEvent(
                        type="error",
                        payload={"message": str(exc)},
                        timestamp=datetime.now(UTC),
                    )
                )
            interval = max(2, self.config_service.load().refresh_interval)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except TimeoutError:
                continue

    async def sync_log_tracking(self, jobs) -> None:
        if self.log_service is None:
            return
        if not self.broadcaster.connections:
            await self._stop_all_log_trackers()
            return

        trackable_job_ids = {
            job.job_id
            for job in jobs
            if getattr(job, "status", None) in TRACKABLE_JOB_STATUSES
        }

        stale_job_ids = [job_id for job_id in self._job_log_trackers if job_id not in trackable_job_ids]
        for job_id in stale_job_ids:
            await self._stop_log_tracker(job_id)

        for job_id in sorted(trackable_job_ids):
            if job_id not in self._job_log_trackers:
                self._job_log_trackers[job_id] = JobLogTracker(
                    task=asyncio.create_task(self._run_job_log_tracker(job_id))
                )

    async def _run_job_log_tracker(self, job_id: str) -> None:
        while not self._stop.is_set():
            tracker = self._job_log_trackers.get(job_id)
            if tracker is None:
                return
            include_eval = monotonic() >= tracker.next_eval_at
            if include_eval:
                tracker.next_eval_at = monotonic() + EVAL_REFRESH_INTERVAL_SECONDS
            try:
                await self._publish_job_log_update(job_id, include_eval=include_eval)
            except asyncio.CancelledError:
                raise
            except SSHError:
                pass
            except Exception as exc:  # pragma: no cover - best effort background reporting
                await self.broadcaster.broadcast(
                    StatusEvent(
                        type="error",
                        payload={"message": f"日志追踪失败（{job_id}）：{exc}"},
                        timestamp=datetime.now(UTC),
                    )
                )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=LOG_PREVIEW_INTERVAL_SECONDS)
            except TimeoutError:
                continue

    async def _publish_job_log_update(self, job_id: str, *, include_eval: bool) -> bool:
        if self.log_service is None:
            return False
        tracker = self._job_log_trackers.get(job_id)
        if tracker is None:
            return False

        log_task = asyncio.to_thread(
            self.log_service.read_log,
            job_id,
            0,
            True,
            None,
            "preview",
        )
        eval_task = (
            asyncio.to_thread(self.log_service.read_eval_lines, job_id, "latest_eval=", 12)
            if include_eval
            else None
        )

        log_result, eval_result = await asyncio.gather(
            log_task,
            eval_task if eval_task is not None else asyncio.sleep(0, result=None),
        )

        next_log_fingerprint = (
            log_result.log_path,
            log_result.size,
            log_result.next_offset,
            log_result.content,
        )
        next_eval_fingerprint = (
            tuple((entry.line_number, entry.content) for entry in eval_result.entries)
            if eval_result is not None
            else None
        )

        changed_log = next_log_fingerprint != tracker.last_log_fingerprint
        changed_eval = include_eval and next_eval_fingerprint != tracker.last_eval_fingerprint
        if not changed_log and not changed_eval:
            return False

        tracker.last_log_fingerprint = next_log_fingerprint
        if next_eval_fingerprint is not None:
            tracker.last_eval_fingerprint = next_eval_fingerprint

        await self.broadcaster.broadcast(
            self.build_job_log_cache_event(
                job_id,
                log=log_result if changed_log else None,
                eval_log=eval_result if changed_eval else None,
            )
        )
        return True

    async def _stop_log_tracker(self, job_id: str) -> None:
        tracker = self._job_log_trackers.pop(job_id, None)
        if tracker is None:
            return
        tracker.task.cancel()
        with suppress(asyncio.CancelledError):
            await tracker.task

    async def _stop_all_log_trackers(self) -> None:
        for job_id in list(self._job_log_trackers):
            await self._stop_log_tracker(job_id)
