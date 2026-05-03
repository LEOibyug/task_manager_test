from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
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
        if not main_repo:
            return False
        log_target = self._build_synced_log_path(main_repo, job.log_path)
        output_target = str(PurePosixPath(main_repo) / "output" / job.experiment)
        log_exists = self.ssh_gateway.stat(config.main_username, log_target) if log_target else False
        output_exists = self.ssh_gateway.stat(config.main_username, output_target) if output_target else False
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

    def _build_synced_log_path(self, main_repo: str, log_path: str | None) -> str | None:
        if not log_path:
            return None
        return str(PurePosixPath(main_repo) / "output" / "sbatch" / PurePosixPath(log_path).name)

    def _build_output_hint(self, experiment_name: str, job_id: str, job_name: str | None) -> str:
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
        if preferred_gpu_node:
            return f"sbatch -w {preferred_gpu_node} {relative_script}"
        return f"sbatch {relative_script}"

    def _is_timeout_job(self, job: JobRecord) -> bool:
        return job.status == "TIMEOUT" or bool(job.last_error and "TIMEOUT" in job.last_error)

    def _clone_job(self, job: JobRecord) -> JobRecord:
        return job.model_copy(deep=True)

    def _merge_job_metadata(self, refreshed_job: JobRecord, current_job: JobRecord | None) -> JobRecord:
        if current_job is None:
            return refreshed_job

        merged = self._clone_job(refreshed_job)

        if (
            merged.experiment.strip().lower() == "unknown"
            and current_job.experiment
            and current_job.experiment.strip().lower() != "unknown"
        ):
            merged.experiment = current_job.experiment
        if not merged.script_path and current_job.script_path:
            merged.script_path = current_job.script_path
        if merged.preferred_gpu_node is None and current_job.preferred_gpu_node is not None:
            merged.preferred_gpu_node = current_job.preferred_gpu_node
        if merged.start_time is None and current_job.start_time is not None:
            merged.start_time = current_job.start_time
        if not merged.runtime and current_job.runtime:
            merged.runtime = current_job.runtime
        if not merged.nodes and current_job.nodes:
            merged.nodes = list(current_job.nodes)
        if merged.resource_usage is None and current_job.resource_usage is not None:
            merged.resource_usage = current_job.resource_usage
        if merged.max_runtime_hours == 48 and current_job.max_runtime_hours != 48:
            merged.max_runtime_hours = current_job.max_runtime_hours
        if merged.log_path is None and current_job.log_path is not None:
            merged.log_path = current_job.log_path
        if merged.log_path_template is None and current_job.log_path_template is not None:
            merged.log_path_template = current_job.log_path_template
        if merged.job_name is None and current_job.job_name is not None:
            merged.job_name = current_job.job_name
        if merged.output_path_hint is None and current_job.output_path_hint is not None:
            merged.output_path_hint = current_job.output_path_hint
        if merged.resumed_from_job_id is None and current_job.resumed_from_job_id is not None:
            merged.resumed_from_job_id = current_job.resumed_from_job_id
        if merged.continuation_root_job_id is None and current_job.continuation_root_job_id is not None:
            merged.continuation_root_job_id = current_job.continuation_root_job_id
        if current_job.auto_retry_enabled:
            merged.auto_retry_enabled = current_job.auto_retry_enabled

        return merged

    def _build_sacct_command(self, username: str, job_ids: list[str]) -> str:
        if job_ids:
            return 'sacct -j "{job_ids}" --format=JobID,State,Elapsed -n -P'.format(
                job_ids=",".join(job_ids)
            )
        return 'sacct -u "{username}" --format=JobID,State,Elapsed -n -P'.format(username=username)

    def _should_collect_seff(self, previous: JobRecord | None, current: JobRecord) -> bool:
        if current.status not in {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"}:
            return False
        if current.resource_usage is None:
            return True
        if previous is None:
            return False
        return previous.status != current.status

    def _refresh_account_jobs(
        self,
        username: str,
        existing_jobs: dict[str, JobRecord],
        logger: CommandLogger | None = None,
    ) -> list[JobRecord]:
        account_updates: dict[str, JobRecord] = {}

        def get_or_create(job_id: str) -> JobRecord | None:
            cached = account_updates.get(job_id)
            if cached is not None:
                return cached
            previous = existing_jobs.get(job_id)
            if previous is None:
                return None
            cloned = self._clone_job(previous)
            account_updates[job_id] = cloned
            return cloned

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
            'squeue -u "{username}" -h -o "%i|%T|%M|%S|%N|%R"'.format(username=username),
            logger=logger,
        )
        if live_result.exit_code == 0:
            for line in live_result.stdout.splitlines():
                if not line.strip():
                    continue
                parts = (line.split("|", 5) + [""] * 6)[:6]
                job_id, state, runtime, start_time, node_value, _reason_value = parts
                previous = existing_jobs.get(job_id)
                cached = self._clone_job(previous) if previous is not None else JobRecord(
                    job_id=job_id,
                    account=username,
                    experiment="unknown",
                    script_path="",
                    status="UNKNOWN",
                )
                cached.status = state if state in {"RUNNING", "PENDING"} else "UNKNOWN"
                cached.runtime = runtime or cached.runtime
                cached.nodes = self._parse_allocated_nodes(node_value)
                cached.last_error = None
                if start_time and start_time not in {"N/A", "Unknown"}:
                    try:
                        cached.start_time = datetime.fromisoformat(start_time.replace(" ", "T"))
                    except ValueError:
                        pass
                account_updates[job_id] = cached

        tracked_job_ids = [job.job_id for job in existing_jobs.values() if job.account == username]
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
            self._build_sacct_command(username, tracked_job_ids),
            logger=logger,
        )
        if history_result.exit_code == 0:
            for line in history_result.stdout.splitlines():
                if not line.strip():
                    continue
                job_id, state, elapsed = (line.split("|", 2) + ["", ""])[:3]
                if "." in job_id:
                    continue
                previous = existing_jobs.get(job_id)
                cached = account_updates.get(job_id)
                if cached is None:
                    cached = get_or_create(job_id)
                if cached is None:
                    continue
                if state.startswith("COMPLETED"):
                    cached.status = "COMPLETED"
                    cached.last_error = None
                elif state.startswith("CANCELLED"):
                    cached.status = "CANCELLED"
                    cached.last_error = "任务已取消"
                elif state.startswith("TIMEOUT"):
                    cached.status = "TIMEOUT"
                    cached.last_error = state
                elif state.startswith("FAILED"):
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
                if self._should_collect_seff(previous, cached):
                    seff_result = self.ssh_gateway.run(username, f"seff {job_id}", logger=logger)
                    if seff_result.exit_code == 0:
                        cached.resource_usage = self._parse_seff_summary(seff_result.stdout)
                account_updates[job_id] = cached

        return list(account_updates.values())

    def _parse_allocated_nodes(self, node_value: str) -> list[str]:
        empty_values = {"", "(None)", "None", "N/A", "n/a"}
        return [
            item.strip()
            for item in node_value.split(",")
            if item.strip() and item.strip() not in empty_values
        ]

    def submit_job(
        self,
        request: SubmitJobRequest,
        logger: CommandLogger | None = None,
        resumed_from_job: JobRecord | None = None,
    ) -> JobRecord:
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
            preferred_gpu_node=request.preferred_gpu_node,
            status="PENDING",
            start_time=datetime.now(UTC),
            runtime="0:00",
            log_path=log_path,
            log_path_template=log_path_template,
            job_name=job_name,
            output_path_hint=output_hint,
            resumed_from_job_id=resumed_from_job.job_id if resumed_from_job else None,
            continuation_root_job_id=(
                resumed_from_job.continuation_root_job_id or resumed_from_job.job_id
            )
            if resumed_from_job
            else None,
            auto_retry_enabled=resumed_from_job.auto_retry_enabled if resumed_from_job else request.auto_retry_enabled,
        )
        self.database.upsert_job(job)
        job.synced = self._resolve_sync_state(config, job)
        return job

    def retry_job(self, job_id: str, logger: CommandLogger | None = None) -> JobRecord:
        job = self.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        if not self._is_timeout_job(job):
            raise SSHError(f"Job {job_id} is not a timed-out job and cannot be resumed.")
        if not job.continuation_root_job_id:
            job.continuation_root_job_id = job.job_id
            self.database.upsert_job(job)
        retry_request = SubmitJobRequest(
            experiment_name=job.experiment,
            script_path=job.script_path,
            account=job.account,
            preferred_gpu_node=job.preferred_gpu_node or (job.nodes[0] if job.nodes else None),
            auto_retry_enabled=job.auto_retry_enabled,
        )
        return self.submit_job(retry_request, logger=logger, resumed_from_job=job)

    def set_job_auto_retry(self, job_id: str, enabled: bool) -> JobListResponse:
        job = self.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        job.auto_retry_enabled = enabled
        self.database.upsert_job(job)
        return self.list_jobs()

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

    def delete_job(self, job_id: str) -> None:
        job = self.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        self.database.delete_job(job_id)

    def refresh_jobs(self, logger: CommandLogger | None = None) -> JobListResponse:
        config = self.config_service.load()
        stored_jobs = [self.normalize_job_record(job) for job in self.database.list_jobs()]
        existing_jobs = {job.job_id: job for job in stored_jobs}
        accounts = [job.account for job in stored_jobs if job.account]
        usernames = [username for username in dict.fromkeys(accounts) if config.repo_paths.get(username)]
        if not usernames:
            return self.list_jobs()

        max_workers = min(4, len(usernames))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._refresh_account_jobs, username, existing_jobs, logger): username
                for username in usernames
            }
            for future in as_completed(futures):
                for job in future.result():
                    self.database.upsert_job(self._merge_job_metadata(job, self.database.get_job(job.job_id)))

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
