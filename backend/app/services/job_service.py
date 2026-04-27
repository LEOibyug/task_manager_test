from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import PurePosixPath

from app.core.database import Database
from app.schemas import AppConfig, JobListResponse, JobRecord, SubmitJobRequest
from app.services.config_service import ConfigService
from app.services.ssh_service import CommandLogger, CommandResult, SSHError, SSHGatewayProtocol


SBATCH_OUTPUT_PATTERN = re.compile(r"^#SBATCH\s+-o\s+(?P<path>.+)$", re.MULTILINE)
SBATCH_NAME_PATTERN = re.compile(r"^#SBATCH\s+-J\s+(?P<name>.+)$", re.MULTILINE)
SBATCH_JOB_PATTERN = re.compile(r"Submitted batch job (?P<job_id>\d+)")


class JobService:
    def __init__(self, config_service: ConfigService, ssh_gateway: SSHGatewayProtocol, database: Database) -> None:
        self.config_service = config_service
        self.ssh_gateway = ssh_gateway
        self.database = database

    def _repo_path(self, config: AppConfig, username: str) -> str:
        repo_path = config.repo_paths.get(username)
        if not repo_path:
            raise SSHError(f"Missing repository path for account: {username}")
        return repo_path

    def _map_script_path(self, config: AppConfig, experiment_name: str, script_path: str, account: str) -> str:
        target_repo = PurePosixPath(self._repo_path(config, account))
        if script_path.startswith(str(target_repo)):
            return script_path
        main_repo = PurePosixPath(self._repo_path(config, config.main_username))
        source_path = PurePosixPath(script_path)
        if source_path.is_absolute() and str(source_path).startswith(str(main_repo)):
            relative = source_path.relative_to(main_repo)
        else:
            relative = PurePosixPath("experiments") / experiment_name / PurePosixPath(script_path).name
        return str(target_repo / relative)

    def _resolve_remote_output_path(self, repo_path: str, raw_path: str) -> str:
        candidate = raw_path.strip()
        if candidate.startswith("/"):
            return candidate
        return str(PurePosixPath(repo_path) / candidate)

    def _map_path_between_accounts(self, source_repo: str, target_repo: str, path: str | None) -> str | None:
        if not path:
            return None
        candidate = PurePosixPath(path)
        if candidate.is_absolute() and str(candidate).startswith(source_repo):
            relative = candidate.relative_to(source_repo)
            return str(PurePosixPath(target_repo) / relative)
        if candidate.is_absolute():
            return str(PurePosixPath(target_repo) / candidate.name)
        return str(PurePosixPath(target_repo) / candidate)

    def _resolve_sync_state(self, config: AppConfig, job: JobRecord) -> bool:
        if job.account == config.main_username:
            return True
        main_repo = config.repo_paths.get(config.main_username)
        sub_repo = config.repo_paths.get(job.account)
        if not main_repo or not sub_repo:
            return False
        log_target = self._map_path_between_accounts(sub_repo, main_repo, job.log_path)
        output_target = self._map_path_between_accounts(sub_repo, main_repo, job.output_path_hint)
        fallback_output_target = str(PurePosixPath(main_repo) / "output" / job.experiment)
        log_exists = self.ssh_gateway.stat(config.main_username, log_target) if log_target else False
        output_exists = self.ssh_gateway.stat(config.main_username, output_target) if output_target else False
        if not output_exists:
            output_exists = self.ssh_gateway.stat(config.main_username, fallback_output_target)
        return log_exists and output_exists

    def _apply_sync_state(self, jobs: list[JobRecord]) -> list[JobRecord]:
        config = self.config_service.load()
        for job in jobs:
            self.normalize_job_record(job)
            job.synced = self._resolve_sync_state(config, job)
        return jobs

    def _resolve_log_output_path(self, repo_path: str, raw_path: str, job_id: str) -> tuple[str, str]:
        template = raw_path.strip() if raw_path.strip() else "slurm-%j.out"
        resolved = template.replace("%j", job_id)
        return self._resolve_remote_output_path(repo_path, resolved), template

    def normalize_job_record(self, job: JobRecord) -> JobRecord:
        try:
            repo_path = self._repo_path(self.config_service.load(), job.account)
        except SSHError:
            return job

        source_path = job.log_path_template or job.log_path
        if source_path:
            if "%j" in source_path:
                normalized_log_path, normalized_template = self._resolve_log_output_path(
                    repo_path,
                    source_path,
                    job.job_id,
                )
                job.log_path_template = normalized_template
            else:
                normalized_log_path = self._resolve_remote_output_path(repo_path, source_path)
            if normalized_log_path != job.log_path:
                job.log_path = normalized_log_path
                self.database.upsert_job(job)
        return job

    def _build_output_hint(self, experiment_name: str, job_id: str, job_name: str | None) -> str:
        if job_name:
            tag = job_name.replace(" ", "_")
            return f"output/{experiment_name}/model_config/{tag}"
        return f"output/{experiment_name}"

    def parse_sbatch_metadata(self, script_content: str, script_path: str, experiment_name: str) -> tuple[str, str | None]:
        output_match = SBATCH_OUTPUT_PATTERN.search(script_content)
        output_path = output_match.group("path").strip() if output_match else f"slurm-%j.out"
        name_match = SBATCH_NAME_PATTERN.search(script_content)
        job_name = name_match.group("name").strip() if name_match else None
        return output_path, job_name

    def _ensure_ok(self, result: CommandResult, action: str) -> CommandResult:
        if result.exit_code != 0:
            message = result.stderr.strip() or f"{action} failed"
            raise SSHError(message)
        return result

    def _count_active_jobs(self, username: str, logger: CommandLogger | None = None) -> int:
        result = self.ssh_gateway.run(
            username,
            'squeue -u "{username}" -h -o "%T"'.format(username=username),
            logger=logger,
        )
        self._ensure_ok(result, "squeue")
        states = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return sum(1 for state in states if state in {"RUNNING", "PENDING"})

    def _build_sbatch_command(self, relative_script: str, preferred_gpu_node: str | None) -> str:
        command = f"sbatch {relative_script}"
        if preferred_gpu_node:
            command += f" -w {preferred_gpu_node}"
        return command

    def submit_job(self, request: SubmitJobRequest, logger: CommandLogger | None = None) -> JobRecord:
        config = self.config_service.load()
        repo_path = self._repo_path(config, request.account)
        target_script_path = self._map_script_path(config, request.experiment_name, request.script_path, request.account)
        if logger is not None:
            logger(
                {
                    "stage": "stdout",
                    "username": request.account,
                    "message": f"准备检查账户 {request.account} 的活跃任务数，目标脚本为 {target_script_path}",
                }
            )
        active_jobs = self._count_active_jobs(request.account, logger=logger)
        if active_jobs >= 2:
            raise SSHError(f"Account {request.account} already has {active_jobs} active jobs.")

        if request.account != config.main_username:
            if logger is not None:
                logger(
                    {
                        "stage": "stdout",
                        "username": request.account,
                        "message": "目标账户不是主账户，开始检查当前 Git 分支并执行 git pull",
                    }
                )
            branch_result = self._ensure_ok(
                self.ssh_gateway.run(request.account, "git rev-parse --abbrev-ref HEAD", cwd=repo_path, logger=logger),
                "git rev-parse",
            )
            branch = branch_result.stdout.strip() or "main"
            self._ensure_ok(
                self.ssh_gateway.run(request.account, f"git pull origin {branch}", cwd=repo_path, logger=logger),
                "git pull",
            )
        elif logger is not None:
            logger(
                {
                    "stage": "stdout",
                    "username": request.account,
                    "message": "目标账户是主账户，跳过 git pull，直接读取脚本并提交任务",
                }
            )

        script_content = self.ssh_gateway.read_file(request.account, target_script_path)
        raw_log_path, job_name = self.parse_sbatch_metadata(script_content, target_script_path, request.experiment_name)
        if logger is not None:
            logger(
                {
                    "stage": "stdout",
                    "username": request.account,
                    "message": f"已解析 sbatch 元信息，日志模板 {raw_log_path}，任务名 {job_name or '未设置'}",
                }
            )

        relative_script = str(PurePosixPath(target_script_path).relative_to(repo_path))
        if logger is not None:
            logger(
                {
                    "stage": "stdout",
                    "username": request.account,
                    "message": (
                        f"开始执行 sbatch，脚本相对路径为 {relative_script}，"
                        f"{f'指定节点 {request.preferred_gpu_node}' if request.preferred_gpu_node else '未指定节点'}"
                    ),
                }
            )
        submit_command = self._build_sbatch_command(relative_script, request.preferred_gpu_node)
        submit_result = self._ensure_ok(
            self.ssh_gateway.run(
                request.account,
                submit_command,
                cwd=repo_path,
                logger=logger,
            ),
            "sbatch",
        )
        match = SBATCH_JOB_PATTERN.search(submit_result.stdout)
        if not match:
            raise SSHError(f"Unable to parse job id from sbatch output: {submit_result.stdout.strip()}")
        job_id = match.group("job_id")
        log_path, log_path_template = self._resolve_log_output_path(repo_path, raw_log_path, job_id)
        output_hint = self._build_output_hint(request.experiment_name, job_id, job_name)

        job = JobRecord(
            job_id=job_id,
            account=request.account,
            experiment=request.experiment_name,
            script_path=target_script_path,
            status="PENDING",
            start_time=datetime.now(UTC),
            runtime="0:00",
            log_path=log_path,
            log_path_template=log_path_template,
            job_name=job_name,
            output_path_hint=output_hint,
        )
        self.database.upsert_job(job)
        job.synced = self._resolve_sync_state(config, job)
        return job

    def list_jobs(self) -> JobListResponse:
        return JobListResponse(jobs=self._apply_sync_state(self.database.list_jobs()), refreshed_at=datetime.now(UTC))

    def cancel_job(self, job_id: str, logger: CommandLogger | None = None) -> JobRecord:
        job = self.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        self.normalize_job_record(job)
        self._ensure_ok(
            self.ssh_gateway.run(job.account, f"scancel {job_id}", logger=logger),
            "scancel",
        )
        job.last_error = "已提交取消请求，等待 Slurm 状态刷新"
        self.database.upsert_job(job)
        job.synced = self._resolve_sync_state(self.config_service.load(), job)
        return job

    def refresh_jobs(self, logger: CommandLogger | None = None) -> JobListResponse:
        config = self.config_service.load()
        stored_jobs = [self.normalize_job_record(job) for job in self.database.list_jobs()]
        existing_jobs = {job.job_id: job for job in stored_jobs}
        accounts = [job.account for job in stored_jobs if job.account]
        for username in list(dict.fromkeys(accounts)):
            repo_path = config.repo_paths.get(username)
            if not repo_path:
                continue
            if logger is not None:
                logger(
                    {
                        "stage": "stdout",
                        "username": username,
                        "message": "开始通过 squeue 扫描运行中和排队中的任务",
                    }
                )
            live_result = self.ssh_gateway.run(
                username,
                'squeue -u "{username}" -h -o "%i|%T|%M|%S|%R"'.format(username=username),
                logger=logger,
            )
            if live_result.exit_code == 0:
                for line in live_result.stdout.splitlines():
                    if not line.strip():
                        continue
                    job_id, state, runtime, start_time, node_value = (line.split("|", 4) + [""] * 5)[:5]
                    cached = existing_jobs.get(job_id)
                    if cached is None:
                        cached = JobRecord(
                            job_id=job_id,
                            account=username,
                            experiment="unknown",
                            script_path="",
                            status="UNKNOWN",
                        )
                    cached.status = state if state in {"RUNNING", "PENDING"} else "UNKNOWN"
                    cached.runtime = runtime or cached.runtime
                    cached.nodes = [item.strip() for item in node_value.split(",") if item.strip()]
                    cached.last_error = None
                    if start_time and start_time not in {"N/A", "Unknown"}:
                        try:
                            cached.start_time = datetime.fromisoformat(start_time.replace(" ", "T"))
                        except ValueError:
                            pass
                    self.database.upsert_job(cached)

            if logger is not None:
                logger(
                    {
                        "stage": "stdout",
                        "username": username,
                        "message": "开始通过 sacct 回填已完成、失败或取消的任务状态",
                    }
                )
            history_result = self.ssh_gateway.run(
                username,
                'sacct -u "{username}" --format=JobID,State,Elapsed -n -P'.format(username=username),
                logger=logger,
            )
            if history_result.exit_code == 0:
                for line in history_result.stdout.splitlines():
                    if not line.strip():
                        continue
                    job_id, state, elapsed = (line.split("|", 2) + ["", ""])[:3]
                    if "." in job_id:
                        continue
                    cached = existing_jobs.get(job_id) or self.database.get_job(job_id)
                    if cached is None:
                        continue
                    if state.startswith("COMPLETED"):
                        cached.status = "COMPLETED"
                        cached.last_error = None
                    elif state.startswith("CANCELLED"):
                        cached.status = "CANCELLED"
                        cached.last_error = "任务已取消"
                    elif state.startswith("FAILED") or state.startswith("TIMEOUT"):
                        cached.status = "FAILED"
                        cached.last_error = state
                    cached.runtime = elapsed or cached.runtime
                    if logger is not None:
                        logger(
                            {
                                "stage": "stdout",
                                "username": username,
                                "message": f"任务 {job_id} 当前归档状态为 {state}",
                            }
                        )
                    seff_result = self.ssh_gateway.run(username, f"seff {job_id}", logger=logger)
                    if seff_result.exit_code == 0:
                        cached.resource_usage = self._parse_seff_summary(seff_result.stdout)
                    self.database.upsert_job(cached)

        return self.list_jobs()

    def _parse_seff_summary(self, content: str) -> str | None:
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        if not lines:
            return None
        interesting = []
        for line in lines:
            if any(token in line for token in ("CPU Efficiency", "Memory Efficiency", "GPU")):
                interesting.append(line)
        return " | ".join(interesting) if interesting else lines[-1]

    def clear_jobs(self) -> None:
        self.database.clear_jobs()
