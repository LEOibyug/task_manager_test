from __future__ import annotations

from pathlib import PurePosixPath

from app.core.database import Database
from app.schemas import AppConfig, JobRecord
from app.services.config_service import ConfigService
from app.services.ssh_service import CommandLogger, SSHError, SSHGatewayProtocol

MAIN_ACCOUNT_SYNC_HOST = "workstation"


class SyncService:
    def __init__(self, config_service: ConfigService, ssh_gateway: SSHGatewayProtocol, database: Database) -> None:
        self.config_service = config_service
        self.ssh_gateway = ssh_gateway
        self.database = database

    def sync_job(self, job: JobRecord, logger: CommandLogger | None = None) -> JobRecord:
        config = self.config_service.load()
        if not job.log_path:
            raise SSHError(f"Missing log path for job {job.job_id}")
        main_repo = self._repo_path(config, config.main_username)
        sub_repo = self._repo_path(config, job.account)

        output_source = str(PurePosixPath(sub_repo) / "output" / job.experiment)
        output_target = str(PurePosixPath(main_repo) / "output")
        log_target = self._map_log_target(main_repo=main_repo, sub_repo=sub_repo, log_path=job.log_path)
        if logger is not None:
            logger(
                {
                    "stage": "stdout",
                    "username": job.account,
                    "message": (
                        f"准备从副账户 {job.account} 发起同步。"
                        f" 产出目录 {output_source} -> {output_target}，日志文件 {job.log_path} -> {log_target}"
                    ),
                }
            )

        self._run_sub(
            job.account,
            f"ssh {config.main_username}@{MAIN_ACCOUNT_SYNC_HOST} 'mkdir -p {PurePosixPath(output_target)}'",
            logger=logger,
        )
        self._run_sub(
            job.account,
            f"ssh {config.main_username}@{MAIN_ACCOUNT_SYNC_HOST} 'mkdir -p {PurePosixPath(log_target).parent}'",
            logger=logger,
        )
        self._run_sub(
            job.account,
            f"scp -r {output_source} {config.main_username}@{MAIN_ACCOUNT_SYNC_HOST}:{output_target}",
            logger=logger,
            get_pty=True,
        )
        self._run_sub(
            job.account,
            f"scp -r {job.log_path} {config.main_username}@{MAIN_ACCOUNT_SYNC_HOST}:{log_target}",
            logger=logger,
            get_pty=True,
        )
        self.database.mark_synced(job.job_id)
        job.synced = True
        return job

    def _map_log_target(self, main_repo: str, sub_repo: str, log_path: str) -> str:
        log_posix = PurePosixPath(log_path)
        if log_posix.is_absolute() and str(log_posix).startswith(sub_repo):
            relative = log_posix.relative_to(sub_repo)
            return str(PurePosixPath(main_repo) / relative)
        if log_posix.is_absolute():
            return str(PurePosixPath(main_repo) / log_posix.name)
        return str(PurePosixPath(main_repo) / log_posix)

    def _repo_path(self, config: AppConfig, username: str) -> str:
        repo_path = config.repo_paths.get(username)
        if not repo_path:
            raise SSHError(f"Missing repository path for account: {username}")
        return repo_path

    def _run_sub(
        self,
        username: str,
        command: str,
        logger: CommandLogger | None = None,
        get_pty: bool = False,
    ) -> None:
        result = self.ssh_gateway.run(username, command, logger=logger, get_pty=get_pty)
        if result.exit_code != 0:
            raise SSHError(result.stderr.strip() or f"Command failed: {command}")
