from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.core.database import Database


class DatabaseCompatibilityTestCase(unittest.TestCase):
    def test_initialize_adds_missing_log_path_template_column_for_existing_db(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "app.db"
            connection = sqlite3.connect(db_path)
            connection.execute(
                """
                CREATE TABLE jobs (
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
            connection.commit()
            connection.close()

            database = Database(db_path)
            database.initialize()

            check_connection = sqlite3.connect(db_path)
            columns = {
                row[1]
                for row in check_connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            check_connection.close()
            self.assertIn("log_path_template", columns)


if __name__ == "__main__":
    unittest.main()
