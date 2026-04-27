from __future__ import annotations

from pathlib import PurePosixPath

from app.schemas import OutputNode, OutputTreeResponse
from app.services.job_service import JobService
from app.services.ssh_service import SSHError, SSHGatewayProtocol


class OutputService:
    def __init__(self, ssh_gateway: SSHGatewayProtocol, job_service: JobService) -> None:
        self.ssh_gateway = ssh_gateway
        self.job_service = job_service

    def _build_tree(self, username: str, path: str, depth: int = 2) -> OutputNode:
        node = OutputNode(name=PurePosixPath(path).name or path, path=path, is_dir=True, children=[])
        if depth <= 0:
            return node
        for child_path, is_dir in self.ssh_gateway.listdir(username, path):
            child = OutputNode(name=PurePosixPath(child_path).name, path=child_path, is_dir=is_dir, children=[])
            if is_dir:
                child = self._build_tree(username, child_path, depth - 1)
            node.children.append(child)
        return node

    def _repo_path(self, job) -> str:
        return self.job_service.config_service.load().repo_paths.get(job.account, "")

    def _candidate_output_paths(self, job) -> list[str]:
        repo_path = self._repo_path(job)
        candidates: list[str] = []
        if job.output_path_hint:
            if job.output_path_hint.startswith("/"):
                if "/output/sbatch/" not in job.output_path_hint:
                    candidates.append(job.output_path_hint)
            elif repo_path:
                candidate_path = str(PurePosixPath(repo_path) / job.output_path_hint)
                if "/output/sbatch/" not in candidate_path:
                    candidates.append(candidate_path)
        if repo_path:
            candidates.append(str(PurePosixPath(repo_path) / "output" / job.experiment))
        seen: list[str] = []
        for candidate in candidates:
            if candidate not in seen:
                seen.append(candidate)
        return seen

    def get_tree(self, job_id: str) -> OutputTreeResponse:
        job = self.job_service.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        for root_path in self._candidate_output_paths(job):
            if self.ssh_gateway.stat(job.account, root_path):
                return OutputTreeResponse(job_id=job_id, root=self._build_tree(job.account, root_path))
        raise SSHError(f"Output path is not available for job {job_id}")

    def get_file_content(self, job_id: str, path: str) -> str:
        job = self.job_service.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        return self.ssh_gateway.read_file(job.account, path)

    def get_file_bytes(self, job_id: str, path: str) -> bytes:
        job = self.job_service.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        return self.ssh_gateway.read_bytes(job.account, path)
