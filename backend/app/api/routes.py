from __future__ import annotations

import asyncio
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from app.api.deps import get_container
from app.container import AppContainer
from app.schemas import (
    AppConfig,
    ConnectionCheckRequest,
    ConnectionCheckResponse,
    ConnectionCheckResult,
    LogResponse,
    OutputTreeResponse,
    RefreshJobsResponse,
    SubmitJobRequest,
    SubmitJobResponse,
    SyncResponse,
)
from app.services.ssh_service import ParamikoSSHGateway, SSHError

router = APIRouter()


@router.get("/config", response_model=AppConfig)
def get_config(container: AppContainer = Depends(get_container)) -> AppConfig:
    return container.config_service.load()


@router.put("/config", response_model=AppConfig)
def put_config(config: AppConfig, container: AppContainer = Depends(get_container)) -> AppConfig:
    saved = container.config_service.save(config)
    container.rebind_gateway(ParamikoSSHGateway(host=saved.server_ip or "127.0.0.1", port=saved.server_port))
    return saved


@router.post("/connection/test", response_model=ConnectionCheckResponse)
def test_connection(
    request: ConnectionCheckRequest,
    _container: AppContainer = Depends(get_container),
) -> ConnectionCheckResponse:
    gateway = ParamikoSSHGateway(host=request.config.server_ip or "127.0.0.1", port=request.config.server_port)
    checks: list[ConnectionCheckResult] = []
    try:
        for username in [request.config.main_username, *request.config.sub_usernames]:
            if not username:
                continue
            repo_path = request.config.repo_paths.get(username)
            if not repo_path:
                checks.append(
                    ConnectionCheckResult(
                        username=username,
                        reachable=False,
                        message="Missing repository path",
                    )
                )
                continue
            try:
                result = gateway.run(username, "pwd")
                reachable = result.exit_code == 0
                repo_exists = gateway.stat(username, repo_path)
                checks.append(
                    ConnectionCheckResult(
                        username=username,
                        reachable=reachable and repo_exists,
                        repo_path=repo_path,
                        message="OK" if reachable and repo_exists else result.stderr.strip() or "Repository path not found",
                    )
                )
            except Exception as exc:
                checks.append(
                    ConnectionCheckResult(
                        username=username,
                        reachable=False,
                        repo_path=repo_path,
                        message=str(exc),
                    )
                )
    finally:
        gateway.close()
    return ConnectionCheckResponse(checks=checks)


@router.get("/experiments")
def list_experiments(container: AppContainer = Depends(get_container)):
    return container.experiment_service.list_experiments()


@router.get("/experiments/{experiment_name}/files")
def experiment_detail(experiment_name: str, container: AppContainer = Depends(get_container)):
    try:
        return container.experiment_service.get_experiment_detail(experiment_name)
    except SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/jobs", response_model=RefreshJobsResponse)
def list_jobs(container: AppContainer = Depends(get_container)) -> RefreshJobsResponse:
    result = container.job_service.list_jobs()
    return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)


@router.post("/jobs/refresh", response_model=RefreshJobsResponse)
async def refresh_jobs(container: AppContainer = Depends(get_container)) -> RefreshJobsResponse:
    try:
        result = container.job_service.refresh_jobs()
        await container.broadcaster.broadcast(
            container.scheduler.build_jobs_refreshed_event(result.jobs)
        )
        return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)
    except SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/submit", response_model=SubmitJobResponse)
def submit_job(request: SubmitJobRequest, container: AppContainer = Depends(get_container)) -> SubmitJobResponse:
    try:
        job = container.job_service.submit_job(request)
        return SubmitJobResponse(job=job, message=f"Job {job.job_id} submitted to {job.account}")
    except SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/log", response_model=LogResponse)
def read_log(
    job_id: str,
    offset: int = Query(default=0, ge=0),
    tail: bool = False,
    search: str | None = None,
    container: AppContainer = Depends(get_container),
) -> LogResponse:
    try:
        return container.log_service.read_log(job_id=job_id, offset=offset, tail=tail, search=search)
    except SSHError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/outputs/tree", response_model=OutputTreeResponse)
def output_tree(job_id: str, container: AppContainer = Depends(get_container)) -> OutputTreeResponse:
    try:
        return container.output_service.get_tree(job_id)
    except SSHError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/outputs/file")
def output_file(job_id: str, path: str, container: AppContainer = Depends(get_container)) -> Response:
    try:
        content = container.output_service.get_file_bytes(job_id, path)
        filename = PurePosixPath(path).name
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        return Response(content=content, media_type="application/octet-stream", headers=headers)
    except SSHError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/sync", response_model=SyncResponse)
def sync_job(job_id: str, container: AppContainer = Depends(get_container)) -> SyncResponse:
    job = container.database.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    try:
        synced_job = container.sync_service.sync_job(job)
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(container.database.list_jobs())
            )
        )
        return SyncResponse(job=synced_job, message=f"Job {job_id} synced to main account")
    except SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.websocket("/ws/status")
async def status_websocket(websocket: WebSocket, container: AppContainer = Depends(get_container)) -> None:
    await container.broadcaster.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        container.broadcaster.disconnect(websocket)
