from __future__ import annotations

import re
import shlex
from typing import Literal

from app.core.settings import RuntimeSettings
from app.schemas import EvalLogEntry, EvalLogResponse, LogResponse
from app.services.job_service import JobService
from app.services.ssh_service import SSHError, SSHGatewayProtocol


class LogService:
    def __init__(self, ssh_gateway: SSHGatewayProtocol, job_service: JobService, settings: RuntimeSettings) -> None:
        self.ssh_gateway = ssh_gateway
        self.job_service = job_service
        self.settings = settings

    def read_log(
        self,
        job_id: str,
        offset: int = 0,
        tail: bool = False,
        search: str | None = None,
        view: Literal["preview", "full"] = "full",
    ) -> LogResponse:
        job = self.job_service.database.get_job(job_id)
        if job is None or not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")
        job = self.job_service.normalize_job_record(job)
        if not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")
        if search:
            content = self.ssh_gateway.read_file(job.account, job.log_path)
            filtered = [line for line in content.splitlines() if search.lower() in line.lower()]
            content = "\n".join(filtered)
            encoded = content.encode("utf-8")
            size = len(encoded)
            start = max(0, size - self.settings.max_log_chunk_bytes) if tail else min(offset, size)
            chunk = encoded[start : start + self.settings.max_log_chunk_bytes]
            decoded = chunk.decode("utf-8", errors="replace")
            return LogResponse(
                job_id=job_id,
                log_path=job.log_path,
                content=decoded,
                next_offset=start + len(chunk),
                size=size,
                truncated=start > 0 or (start + len(chunk)) < size,
                view="full",
            )

        if view == "preview":
            chunk, size, start = self.ssh_gateway.read_bytes_tail(
                job.account,
                job.log_path,
                self.settings.preview_log_chunk_bytes,
            )
        else:
            if tail:
                chunk, size, start = self.ssh_gateway.read_bytes_tail(
                    job.account,
                    job.log_path,
                    self.settings.max_log_chunk_bytes,
                )
            else:
                chunk, size = self.ssh_gateway.read_bytes_range(
                    job.account,
                    job.log_path,
                    start=offset,
                    max_bytes=self.settings.max_log_chunk_bytes,
                )
                start = min(offset, size)
        decoded = chunk.decode("utf-8", errors="replace")
        return LogResponse(
            job_id=job_id,
            log_path=job.log_path,
            content=decoded,
            next_offset=start + len(chunk),
            size=size,
            truncated=start > 0 or (start + len(chunk)) < size,
            view=view,
        )

    def read_eval_lines(self, job_id: str, pattern: str = "latest_eval=", limit: int = 12) -> EvalLogResponse:
        job = self.job_service.database.get_job(job_id)
        if job is None or not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")
        job = self.job_service.normalize_job_record(job)
        if not job.log_path:
            raise SSHError(f"Log path not available for job {job_id}")

        safe_pattern = pattern.strip() or "latest_eval="
        safe_limit = min(max(limit, 1), 50)
        command = "grep -a -n -- {pattern} {path} | tail -n {limit}".format(
            pattern=shlex.quote(safe_pattern),
            path=shlex.quote(job.log_path),
            limit=safe_limit,
        )
        result = self.ssh_gateway.run(job.account, command)
        deduped_entries: dict[str, EvalLogEntry] = {}
        if result.stdout:
            for raw_line in result.stdout.splitlines():
                if not raw_line.strip():
                    continue
                if ":" in raw_line:
                    line_no_text, raw_content = raw_line.split(":", 1)
                    line_no = int(line_no_text) if line_no_text.isdigit() else None
                else:
                    line_no = None
                    raw_content = raw_line
                content = self._extract_latest_eval_content(raw_content)
                if not content:
                    continue
                if content in deduped_entries:
                    del deduped_entries[content]
                deduped_entries[content] = EvalLogEntry(line_number=line_no, content=content)
        return EvalLogResponse(
            job_id=job_id,
            log_path=job.log_path,
            pattern=safe_pattern,
            entries=list(deduped_entries.values()),
        )

    def _extract_latest_eval_content(self, raw_content: str) -> str | None:
        cleaned = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw_content)
        cleaned = re.sub(r"[\x00-\x1f\x7f]+", " ", cleaned).strip()
        marker = "latest_eval="
        if marker not in cleaned:
            return None
        tail = cleaned.split(marker, 1)[1]
        metrics: list[str] = []
        for part in tail.split(","):
            candidate = part.strip()
            if not candidate:
                continue
            matched = re.match(
                r"(?P<key>[A-Za-z0-9_./-]+)\s*=\s*(?P<value>[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)",
                candidate,
            )
            if not matched:
                continue
            metrics.append(f"{matched.group('key')}={matched.group('value')}")
        if not metrics:
            return None
        return f"{marker}{', '.join(metrics)}"
