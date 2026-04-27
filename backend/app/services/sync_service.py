from __future__ import annotations

from pathlib import PurePosixPath

from app.core.database import Database
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.ssh_service import SSHError, SSHGatewayProtocol


class SyncService:
    def __init__(self, config_service: ConfigService, ssh_gateway: SSHGatewayProtocol, database: Database) -> None:
        self.config_service = config_service
        self.ssh_gateway = ssh_gateway
        self.database = database

    def sync_job(self, job: JobRecord) -> JobRecord:
        config = self.config_service.load()
        if not job.log_path:
            raise SSHError(f"Missing log path for job {job.job_id}")
        main_repo = self._repo_path(config, config.main_username)
        sub_repo = self._repo_path(config, job.account)

        output_source = str(PurePosixPath(sub_repo) / "output" / job.experiment)
        output_target = str(PurePosixPath(main_repo) / "output")
        log_target = str(PurePosixPath(main_repo) / job.log_path)

        self._run_main(config, f"mkdir -p {PurePosixPath(output_target)}")
        self._run_main(config, f"mkdir -p {PurePosixPath(log_target).parent}")
        self._run_main(
            config,
            f"scp -r {job.account}@{config.server_ip}:{output_source} {output_target}",
        )
        self._run_main(
            config,
            f"scp -r {job.account}@{config.server_ip}:{job.log_path} {log_target}",
        )
        self.database.mark_synced(job.job_id)
        job.synced = True
        return job

    def _repo_path(self, config: AppConfig, username: str) -> str:
        repo_path = config.repo_paths.get(username)
        if not repo_path:
            raise SSHError(f"Missing repository path for account: {username}")
        return repo_path

    def _run_main(self, config: AppConfig, command: str) -> None:
        result = self.ssh_gateway.run(config.main_username, command)
        if result.exit_code != 0:
            raise SSHError(result.stderr.strip() or f"Command failed: {command}")
