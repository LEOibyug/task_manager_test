from __future__ import annotations

from pathlib import PurePosixPath

from app.schemas import ExperimentDetail, ExperimentFile, ExperimentSummary
from app.services.config_service import ConfigService
from app.services.ssh_service import SSHGatewayProtocol


class ExperimentService:
    def __init__(self, config_service: ConfigService, ssh_gateway: SSHGatewayProtocol) -> None:
        self.config_service = config_service
        self.ssh_gateway = ssh_gateway

    def _main_repo_path(self) -> tuple[str, str]:
        config = self.config_service.load()
        return config.main_username, config.repo_paths.get(config.main_username, "")

    def list_experiments(self) -> list[ExperimentSummary]:
        main_username, repo_path = self._main_repo_path()
        if not repo_path or not main_username:
            return []
        experiments_root = str(PurePosixPath(repo_path) / "experiments")
        entries = self.ssh_gateway.listdir(main_username, experiments_root)
        summaries = []
        for path, is_dir in entries:
            if is_dir:
                summaries.append(ExperimentSummary(name=PurePosixPath(path).name, path=path))
        return sorted(summaries, key=lambda item: item.name)

    def get_experiment_detail(self, experiment_name: str) -> ExperimentDetail:
        main_username, repo_path = self._main_repo_path()
        base_path = str(PurePosixPath(repo_path) / "experiments" / experiment_name)
        entries = self.ssh_gateway.listdir(main_username, base_path)
        files: list[ExperimentFile] = []
        for path, is_dir in entries:
            name = PurePosixPath(path).name
            kind = "directory" if is_dir else "file"
            if name.endswith(".sbatch"):
                kind = "sbatch"
            elif name.endswith(".sh"):
                kind = "shell"
            files.append(ExperimentFile(name=name, path=path, is_dir=is_dir, kind=kind))
        return ExperimentDetail(
            experiment=ExperimentSummary(name=experiment_name, path=base_path),
            files=sorted(files, key=lambda item: (not item.is_dir, item.name)),
        )
