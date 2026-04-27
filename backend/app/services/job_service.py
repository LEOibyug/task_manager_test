from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import PurePosixPath

from app.core.database import Database
from app.schemas import AppConfig, JobListResponse, JobRecord, SubmitJobRequest
from app.services.config_service import ConfigService
from app.services.ssh_service import CommandResult, SSHError, SSHGatewayProtocol


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

    def parse_sbatch_metadata(self, script_content: str, script_path: str, experiment_name: str) -> tuple[str, str | None, str | None]:
        output_match = SBATCH_OUTPUT_PATTERN.search(script_content)
        output_path = output_match.group("path").strip() if output_match else f"slurm-%j.out"
        name_match = SBATCH_NAME_PATTERN.search(script_content)
        job_name = name_match.group("name").strip() if name_match else None
        output_hint = f"output/{experiment_name}"
        if job_name:
            tag = job_name.replace(" ", "_")
            output_hint = f"output/{experiment_name}/model_config/{tag}"
        return output_path, job_name, output_hint

    def _ensure_ok(self, result: CommandResult, action: str) -> CommandResult:
        if result.exit_code != 0:
            message = result.stderr.strip() or f"{action} failed"
            raise SSHError(message)
        return result

    def _count_active_jobs(self, username: str) -> int:
        result = self.ssh_gateway.run(username, 'squeue -u "{username}" -h -o "%T"'.format(username=username))
        self._ensure_ok(result, "squeue")
        states = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return sum(1 for state in states if state in {"RUNNING", "PENDING"})

    def submit_job(self, request: SubmitJobRequest) -> JobRecord:
        config = self.config_service.load()
        repo_path = self._repo_path(config, request.account)
        target_script_path = self._map_script_path(config, request.experiment_name, request.script_path, request.account)
        active_jobs = self._count_active_jobs(request.account)
        if active_jobs >= 2:
            raise SSHError(f"Account {request.account} already has {active_jobs} active jobs.")

        branch_result = self._ensure_ok(
            self.ssh_gateway.run(request.account, "git rev-parse --abbrev-ref HEAD", cwd=repo_path),
            "git rev-parse",
        )
        branch = branch_result.stdout.strip() or "main"
        self._ensure_ok(self.ssh_gateway.run(request.account, f"git pull origin {branch}", cwd=repo_path), "git pull")

        script_content = self.ssh_gateway.read_file(request.account, target_script_path)
        raw_log_path, job_name, output_hint = self.parse_sbatch_metadata(script_content, target_script_path, request.experiment_name)
        log_path = self._resolve_remote_output_path(repo_path, raw_log_path)

        relative_script = str(PurePosixPath(target_script_path).relative_to(repo_path))
        submit_result = self._ensure_ok(
            self.ssh_gateway.run(request.account, f"sbatch {relative_script} -w gpu1,gpu2,gpu3", cwd=repo_path),
            "sbatch",
        )
        match = SBATCH_JOB_PATTERN.search(submit_result.stdout)
        if not match:
            raise SSHError(f"Unable to parse job id from sbatch output: {submit_result.stdout.strip()}")

        job = JobRecord(
            job_id=match.group("job_id"),
            account=request.account,
            experiment=request.experiment_name,
            script_path=target_script_path,
            status="PENDING",
            start_time=datetime.now(UTC),
            runtime="0:00",
            log_path=log_path,
            job_name=job_name,
            output_path_hint=output_hint,
        )
        self.database.upsert_job(job)
        return job

    def list_jobs(self) -> JobListResponse:
        return JobListResponse(jobs=self.database.list_jobs(), refreshed_at=datetime.now(UTC))

    def refresh_jobs(self) -> JobListResponse:
        config = self.config_service.load()
        existing_jobs = {job.job_id: job for job in self.database.list_jobs()}
        for username in config.sub_usernames:
            repo_path = config.repo_paths.get(username)
            if not repo_path:
                continue
            live_result = self.ssh_gateway.run(
                username,
                'squeue -u "{username}" -h -o "%i|%T|%M|%S|%R"'.format(username=username),
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
                    if start_time and start_time not in {"N/A", "Unknown"}:
                        try:
                            cached.start_time = datetime.fromisoformat(start_time.replace(" ", "T"))
                        except ValueError:
                            pass
                    self.database.upsert_job(cached)

            history_result = self.ssh_gateway.run(
                username,
                'sacct -u "{username}" --format=JobID,State,Elapsed -n -P'.format(username=username),
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
                    elif state.startswith("FAILED") or state.startswith("CANCELLED") or state.startswith("TIMEOUT"):
                        cached.status = "FAILED"
                    cached.runtime = elapsed or cached.runtime
                    seff_result = self.ssh_gateway.run(username, f"seff {job_id}")
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
