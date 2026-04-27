from __future__ import annotations

from app.core.settings import RuntimeSettings
from app.schemas import LogResponse
from app.services.job_service import JobService
from app.services.ssh_service import SSHError, SSHGatewayProtocol


class LogService:
    def __init__(self, ssh_gateway: SSHGatewayProtocol, job_service: JobService, settings: RuntimeSettings) -> None:
        self.ssh_gateway = ssh_gateway
        self.job_service = job_service
        self.settings = settings

    def read_log(self, job_id: str, offset: int = 0, tail: bool = False, search: str | None = None) -> LogResponse:
        job = self.job_service.database.get_job(job_id)
        if job is None or not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")
        job = self.job_service.normalize_job_record(job)
        if not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")
        content = self.ssh_gateway.read_file(job.account, job.log_path)
        if search:
            filtered = [line for line in content.splitlines() if search.lower() in line.lower()]
            content = "\n".join(filtered)
        size = len(content.encode("utf-8"))
        if tail:
            start = max(0, size - self.settings.max_log_chunk_bytes)
        else:
            start = min(offset, size)
        encoded = content.encode("utf-8")
        chunk = encoded[start : start + self.settings.max_log_chunk_bytes]
        decoded = chunk.decode("utf-8", errors="replace")
        return LogResponse(
            job_id=job_id,
            log_path=job.log_path,
            content=decoded,
            next_offset=start + len(chunk),
            size=size,
            truncated=(start + len(chunk)) < size,
        )
