from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

from app.schemas import JobRecord


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    account TEXT NOT NULL,
                    experiment TEXT NOT NULL,
                    script_path TEXT NOT NULL,
                    status TEXT NOT NULL,
                    start_time TEXT,
                    runtime TEXT,
                    nodes TEXT,
                    resource_usage TEXT,
                    max_runtime_hours INTEGER NOT NULL,
                    log_path TEXT,
                    job_name TEXT,
                    output_path_hint TEXT,
                    synced INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_records (
                    job_id TEXT PRIMARY KEY,
                    synced_at TEXT NOT NULL
                )
                """
            )

    def upsert_job(self, job: JobRecord) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (
                    job_id, account, experiment, script_path, status, start_time, runtime, nodes,
                    resource_usage, max_runtime_hours, log_path, job_name, output_path_hint, synced, last_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    account=excluded.account,
                    experiment=excluded.experiment,
                    script_path=excluded.script_path,
                    status=excluded.status,
                    start_time=excluded.start_time,
                    runtime=excluded.runtime,
                    nodes=excluded.nodes,
                    resource_usage=excluded.resource_usage,
                    max_runtime_hours=excluded.max_runtime_hours,
                    log_path=excluded.log_path,
                    job_name=excluded.job_name,
                    output_path_hint=excluded.output_path_hint,
                    synced=excluded.synced,
                    last_error=excluded.last_error
                """,
                (
                    job.job_id,
                    job.account,
                    job.experiment,
                    job.script_path,
                    job.status,
                    job.start_time.isoformat() if job.start_time else None,
                    job.runtime,
                    ",".join(job.nodes),
                    job.resource_usage,
                    job.max_runtime_hours,
                    job.log_path,
                    job.job_name,
                    job.output_path_hint,
                    int(job.synced),
                    job.last_error,
                ),
            )

    def list_jobs(self) -> list[JobRecord]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM jobs ORDER BY COALESCE(start_time, '') DESC, job_id DESC").fetchall()
        jobs: list[JobRecord] = []
        for row in rows:
            jobs.append(
                JobRecord(
                    job_id=row["job_id"],
                    account=row["account"],
                    experiment=row["experiment"],
                    script_path=row["script_path"],
                    status=row["status"],
                    start_time=datetime.fromisoformat(row["start_time"]) if row["start_time"] else None,
                    runtime=row["runtime"],
                    nodes=[item for item in (row["nodes"] or "").split(",") if item],
                    resource_usage=row["resource_usage"],
                    max_runtime_hours=row["max_runtime_hours"],
                    log_path=row["log_path"],
                    job_name=row["job_name"],
                    output_path_hint=row["output_path_hint"],
                    synced=bool(row["synced"]),
                    last_error=row["last_error"],
                )
            )
        return jobs

    def get_job(self, job_id: str) -> JobRecord | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return JobRecord(
            job_id=row["job_id"],
            account=row["account"],
            experiment=row["experiment"],
            script_path=row["script_path"],
            status=row["status"],
            start_time=datetime.fromisoformat(row["start_time"]) if row["start_time"] else None,
            runtime=row["runtime"],
            nodes=[item for item in (row["nodes"] or "").split(",") if item],
            resource_usage=row["resource_usage"],
            max_runtime_hours=row["max_runtime_hours"],
            log_path=row["log_path"],
            job_name=row["job_name"],
            output_path_hint=row["output_path_hint"],
            synced=bool(row["synced"]),
            last_error=row["last_error"],
        )

    def mark_synced(self, job_id: str) -> None:
        timestamp = datetime.utcnow().isoformat()
        with self.connect() as connection:
            connection.execute("UPDATE jobs SET synced = 1 WHERE job_id = ?", (job_id,))
            connection.execute(
                """
                INSERT INTO sync_records(job_id, synced_at) VALUES (?, ?)
                ON CONFLICT(job_id) DO UPDATE SET synced_at = excluded.synced_at
                """,
                (job_id, timestamp),
            )

