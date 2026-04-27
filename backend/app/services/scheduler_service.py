from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

from fastapi import WebSocket

from app.schemas import StatusEvent
from app.services.config_service import ConfigService
from app.services.job_service import JobService


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
    def __init__(self, config_service: ConfigService, job_service: JobService, broadcaster: StatusBroadcaster) -> None:
        self.config_service = config_service
        self.job_service = job_service
        self.broadcaster = broadcaster
        self.task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    def build_jobs_refreshed_event(self, jobs) -> StatusEvent:
        return StatusEvent(
            type="jobs_refreshed",
            payload={"jobs": [job.model_dump(mode="json") for job in jobs]},
        )

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

    async def trigger_refresh(self) -> None:
        jobs = self.job_service.refresh_jobs()
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
