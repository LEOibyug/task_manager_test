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

    def _get_job_or_raise(self, job_id: str):
        job = self.job_service.database.get_job(job_id)
        if job is None:
            raise SSHError(f"Unknown job id: {job_id}")
        return job

    def _candidate_output_paths(self, job) -> list[str]:
        repo_path = self._repo_path(job)
        candidates: list[str] = []
        if repo_path:
            candidates.append(str(PurePosixPath(repo_path) / "output" / job.experiment))
        return list(dict.fromkeys(candidates))

    def _existing_output_root(self, username: str, candidate_path: str, repo_path: str) -> str | None:
        candidate = PurePosixPath(candidate_path)
        repo = PurePosixPath(repo_path) if repo_path else None
        min_anchor = PurePosixPath(repo_path) / "output" if repo_path else None

        current = candidate
        while True:
            current_str = str(current)
            if self.ssh_gateway.stat(username, current_str):
                return current_str
            if min_anchor is not None and current == min_anchor:
                break
            if repo is not None and current == repo:
                break
            if current.parent == current:
                break
            current = current.parent
        return None

    def get_tree(self, job_id: str) -> OutputTreeResponse:
        job = self._get_job_or_raise(job_id)
        repo_path = self._repo_path(job)
        for root_path in self._candidate_output_paths(job):
            existing_root = self._existing_output_root(job.account, root_path, repo_path)
            if existing_root is not None:
                return OutputTreeResponse(job_id=job_id, root=self._build_tree(job.account, existing_root))
        raise SSHError(f"Output path is not available for job {job_id}")

    def get_file_content(self, job_id: str, path: str) -> str:
        job = self._get_job_or_raise(job_id)
        return self.ssh_gateway.read_file(job.account, path)

    def get_file_bytes(self, job_id: str, path: str) -> bytes:
        job = self._get_job_or_raise(job_id)
        return self.ssh_gateway.read_bytes(job.account, path)
