from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


JobState = Literal["RUNNING", "PENDING", "COMPLETED", "FAILED", "UNKNOWN"]


class AppConfig(BaseModel):
    server_ip: str = ""
    server_port: int = 22
    main_username: str = ""
    sub_usernames: list[str] = Field(default_factory=list)
    repo_paths: dict[str, str] = Field(default_factory=dict)
    refresh_interval: int = 10


class ConnectionCheckRequest(BaseModel):
    config: AppConfig


class ConnectionCheckResult(BaseModel):
    username: str
    reachable: bool
    repo_path: str | None = None
    message: str


class ConnectionCheckResponse(BaseModel):
    checks: list[ConnectionCheckResult]


class ExperimentSummary(BaseModel):
    name: str
    path: str


class ExperimentFile(BaseModel):
    name: str
    path: str
    is_dir: bool
    kind: Literal["directory", "sbatch", "shell", "file"]


class ExperimentDetail(BaseModel):
    experiment: ExperimentSummary
    files: list[ExperimentFile]


class JobRecord(BaseModel):
    job_id: str
    account: str
    experiment: str
    script_path: str
    status: JobState = "UNKNOWN"
    start_time: datetime | None = None
    runtime: str | None = None
    nodes: list[str] = Field(default_factory=list)
    resource_usage: str | None = None
    max_runtime_hours: int = 48
    log_path: str | None = None
    job_name: str | None = None
    output_path_hint: str | None = None
    synced: bool = False
    last_error: str | None = None


class JobListResponse(BaseModel):
    jobs: list[JobRecord]
    refreshed_at: datetime


class SubmitJobRequest(BaseModel):
    experiment_name: str
    script_path: str
    account: str


class SubmitJobResponse(BaseModel):
    job: JobRecord
    message: str


class CancelJobResponse(BaseModel):
    job_id: str
    account: str
    message: str


class RefreshJobsResponse(BaseModel):
    jobs: list[JobRecord]
    refreshed_at: datetime


class LogResponse(BaseModel):
    job_id: str
    log_path: str
    content: str
    next_offset: int
    size: int
    truncated: bool


class OutputNode(BaseModel):
    name: str
    path: str
    is_dir: bool
    children: list["OutputNode"] = Field(default_factory=list)


class OutputTreeResponse(BaseModel):
    job_id: str
    root: OutputNode


class SyncResponse(BaseModel):
    job: JobRecord
    message: str


class StatusEvent(BaseModel):
    type: Literal["jobs_refreshed", "sync_complete", "error", "heartbeat", "command_log"]
    payload: dict[str, Any]
    timestamp: datetime = Field(default_factory=datetime.utcnow)


OutputNode.model_rebuild()
