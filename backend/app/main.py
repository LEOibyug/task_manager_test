from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.container import AppContainer
from app.core.database import Database
from app.core.settings import RuntimeSettings, get_settings
from app.services.config_service import ConfigService
from app.services.experiment_service import ExperimentService
from app.services.job_service import JobService
from app.services.log_service import LogService
from app.services.output_service import OutputService
from app.services.scheduler_service import SchedulerService, StatusBroadcaster
from app.services.ssh_service import ParamikoSSHGateway
from app.services.sync_service import SyncService


def build_container() -> AppContainer:
    settings = get_settings()
    database = Database(settings.database_path)
    database.initialize()
    config_service = ConfigService(settings.config_file)
    config = config_service.load()
    ssh_gateway = ParamikoSSHGateway(host=config.server_ip or "127.0.0.1", port=config.server_port)
    broadcaster = StatusBroadcaster()
    job_service = JobService(config_service=config_service, ssh_gateway=ssh_gateway, database=database)
    log_service = LogService(ssh_gateway=ssh_gateway, job_service=job_service, settings=settings)
    container = AppContainer(
        settings=settings,
        database=database,
        config_service=config_service,
        ssh_gateway=ssh_gateway,
        experiment_service=ExperimentService(config_service=config_service, ssh_gateway=ssh_gateway),
        job_service=job_service,
        log_service=log_service,
        output_service=OutputService(ssh_gateway=ssh_gateway, job_service=job_service),
        sync_service=SyncService(config_service=config_service, ssh_gateway=ssh_gateway, database=database),
        broadcaster=broadcaster,
        scheduler=SchedulerService(
            config_service=config_service,
            job_service=job_service,
            broadcaster=broadcaster,
            log_service=log_service,
        ),
    )
    return container


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router, prefix=settings.api_prefix)

    container = build_container()
    app.state.container = container

    @app.on_event("startup")
    async def on_startup() -> None:
        await app.state.container.scheduler.start()

    @app.on_event("shutdown")
    async def on_shutdown() -> None:
        await app.state.container.scheduler.stop()
        app.state.container.ssh_gateway.close()

    if settings.frontend_dist.exists():
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")

    return app


app = create_app()
