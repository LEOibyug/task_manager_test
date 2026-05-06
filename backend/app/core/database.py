from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
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
                    preferred_gpu_node TEXT,
                    status TEXT NOT NULL,
                    start_time TEXT,
                    runtime TEXT,
                    nodes TEXT,
                    resource_usage TEXT,
                    max_runtime_hours INTEGER NOT NULL,
                    log_path TEXT,
                    log_path_template TEXT,
                    job_name TEXT,
                    output_path_hint TEXT,
                    synced INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    resumed_from_job_id TEXT,
                    continuation_root_job_id TEXT,
                    continuation_order INTEGER,
                    auto_retry_enabled INTEGER NOT NULL DEFAULT 1
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
            self._ensure_job_columns(connection)
            self._migrate_legacy_job_rows(connection)

    def _ensure_job_columns(self, connection: sqlite3.Connection) -> None:
        existing_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
        }
        expected_columns = {
            "log_path_template": "TEXT",
            "preferred_gpu_node": "TEXT",
            "resumed_from_job_id": "TEXT",
            "continuation_root_job_id": "TEXT",
            "continuation_order": "INTEGER",
            "auto_retry_enabled": "INTEGER NOT NULL DEFAULT 1",
        }
        for column_name, column_type in expected_columns.items():
            if column_name not in existing_columns:
                connection.execute(
                    f"ALTER TABLE jobs ADD COLUMN {column_name} {column_type}"
                )

    def _migrate_legacy_job_rows(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            UPDATE jobs
            SET status = 'TIMEOUT'
            WHERE status = 'FAILED'
              AND last_error IS NOT NULL
              AND UPPER(last_error) LIKE '%TIMEOUT%'
            """
        )

    def _row_value(self, row: sqlite3.Row, key: str) -> str | int | None:
        return row[key] if key in row.keys() else None

    def _job_from_row(self, row: sqlite3.Row) -> JobRecord:
        start_time = self._row_value(row, "start_time")
        nodes = self._row_value(row, "nodes")
        synced = self._row_value(row, "synced")
        max_runtime_hours = self._row_value(row, "max_runtime_hours")
        auto_retry_enabled = self._row_value(row, "auto_retry_enabled")
        continuation_order = self._row_value(row, "continuation_order")
        return JobRecord(
            job_id=str(row["job_id"]),
            account=str(row["account"]),
            experiment=str(row["experiment"]),
            script_path=str(row["script_path"]),
            preferred_gpu_node=self._row_value(row, "preferred_gpu_node"),
            status=str(row["status"]),
            start_time=datetime.fromisoformat(start_time) if start_time else None,
            runtime=self._row_value(row, "runtime"),
            nodes=[item for item in (nodes or "").split(",") if item],
            resource_usage=self._row_value(row, "resource_usage"),
            max_runtime_hours=int(max_runtime_hours) if max_runtime_hours is not None else 48,
            log_path=self._row_value(row, "log_path"),
            log_path_template=self._row_value(row, "log_path_template"),
            job_name=self._row_value(row, "job_name"),
            output_path_hint=self._row_value(row, "output_path_hint"),
            synced=bool(synced) if synced is not None else False,
            last_error=self._row_value(row, "last_error"),
            resumed_from_job_id=self._row_value(row, "resumed_from_job_id"),
            continuation_root_job_id=self._row_value(row, "continuation_root_job_id"),
            continuation_order=int(continuation_order) if continuation_order is not None else None,
            auto_retry_enabled=bool(auto_retry_enabled) if auto_retry_enabled is not None else True,
        )

    def upsert_job(self, job: JobRecord) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (
                    job_id, account, experiment, script_path, preferred_gpu_node, status, start_time, runtime, nodes,
                    resource_usage, max_runtime_hours, log_path, log_path_template, job_name, output_path_hint, synced, last_error,
                    resumed_from_job_id, continuation_root_job_id, continuation_order, auto_retry_enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    account=excluded.account,
                    experiment=excluded.experiment,
                    script_path=excluded.script_path,
                    preferred_gpu_node=excluded.preferred_gpu_node,
                    status=excluded.status,
                    start_time=excluded.start_time,
                    runtime=excluded.runtime,
                    nodes=excluded.nodes,
                    resource_usage=excluded.resource_usage,
                    max_runtime_hours=excluded.max_runtime_hours,
                    log_path=excluded.log_path,
                    log_path_template=excluded.log_path_template,
                    job_name=excluded.job_name,
                    output_path_hint=excluded.output_path_hint,
                    synced=excluded.synced,
                    last_error=excluded.last_error,
                    resumed_from_job_id=excluded.resumed_from_job_id,
                    continuation_root_job_id=excluded.continuation_root_job_id,
                    continuation_order=excluded.continuation_order,
                    auto_retry_enabled=excluded.auto_retry_enabled
                """,
                (
                    job.job_id,
                    job.account,
                    job.experiment,
                    job.script_path,
                    job.preferred_gpu_node,
                    job.status,
                    job.start_time.isoformat() if job.start_time else None,
                    job.runtime,
                    ",".join(job.nodes),
                    job.resource_usage,
                    job.max_runtime_hours,
                    job.log_path,
                    job.log_path_template,
                    job.job_name,
                    job.output_path_hint,
                    int(job.synced),
                    job.last_error,
                    job.resumed_from_job_id,
                    job.continuation_root_job_id,
                    job.continuation_order,
                    int(job.auto_retry_enabled),
                ),
            )

    def list_jobs(self) -> list[JobRecord]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM jobs ORDER BY COALESCE(start_time, '') DESC, job_id DESC").fetchall()
        return [self._job_from_row(row) for row in rows]

    def get_job(self, job_id: str) -> JobRecord | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return self._job_from_row(row)

    def mark_synced(self, job_id: str) -> None:
        timestamp = datetime.now(UTC).isoformat()
        with self.connect() as connection:
            connection.execute("UPDATE jobs SET synced = 1 WHERE job_id = ?", (job_id,))
            connection.execute(
                """
                INSERT INTO sync_records(job_id, synced_at) VALUES (?, ?)
                ON CONFLICT(job_id) DO UPDATE SET synced_at = excluded.synced_at
                """,
                (job_id, timestamp),
            )

    def set_job_auto_retry(self, job_id: str, enabled: bool) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE jobs SET auto_retry_enabled = ? WHERE job_id = ?",
                (int(enabled), job_id),
            )

    def delete_job(self, job_id: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            connection.execute("DELETE FROM sync_records WHERE job_id = ?", (job_id,))

    def clear_jobs(self) -> None:
        with self.connect() as connection:
            removable_job_ids = [
                row["job_id"]
                for row in connection.execute(
                    "SELECT job_id FROM jobs WHERE status NOT IN ('RUNNING', 'PENDING')"
                ).fetchall()
            ]
            connection.execute("DELETE FROM jobs WHERE status NOT IN ('RUNNING', 'PENDING')")
            if removable_job_ids:
                placeholders = ",".join("?" for _ in removable_job_ids)
                connection.execute(
                    f"DELETE FROM sync_records WHERE job_id IN ({placeholders})",
                    removable_job_ids,
                )
