from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.core.database import Database
from app.core.settings import RuntimeSettings
from app.services.config_service import ConfigService
from app.services.experiment_service import ExperimentService
from app.services.job_service import JobService
from app.services.log_service import LogService
from app.services.output_service import OutputService
from app.services.scheduler_service import SchedulerService, StatusBroadcaster
from app.services.ssh_service import ParamikoSSHGateway
from app.services.sync_service import SyncService

if TYPE_CHECKING:
    from fastapi import FastAPI


@dataclass
class AppContainer:
    settings: RuntimeSettings
    database: Database
    config_service: ConfigService
    ssh_gateway: ParamikoSSHGateway
    experiment_service: ExperimentService
    job_service: JobService
    log_service: LogService
    output_service: OutputService
    sync_service: SyncService
    broadcaster: StatusBroadcaster
    scheduler: SchedulerService

    def rebind_gateway(self, ssh_gateway: ParamikoSSHGateway) -> None:
        self.ssh_gateway.close()
        self.ssh_gateway = ssh_gateway
        self.experiment_service.ssh_gateway = ssh_gateway
        self.job_service.ssh_gateway = ssh_gateway
        self.log_service.ssh_gateway = ssh_gateway
        self.output_service.ssh_gateway = ssh_gateway
        self.sync_service.ssh_gateway = ssh_gateway
