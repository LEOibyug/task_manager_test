from __future__ import annotations

import asyncio
from pathlib import PurePosixPath
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.api.deps import get_container
from app.container import AppContainer
from app.schemas import (
    AppConfig,
    CancelJobResponse,
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


def build_command_logger(container: AppContainer, loop: asyncio.AbstractEventLoop, action: str):
    operation_id = str(uuid4())

    def logger(payload: dict[str, object]) -> None:
        event_payload = {"operation_id": operation_id, "action": action, **payload}
        loop.call_soon_threadsafe(
            asyncio.create_task,
            container.broadcaster.broadcast(
                container.broadcaster.build_command_event(event_payload)
            ),
        )

    return operation_id, logger


@router.get("/config", response_model=AppConfig)
def get_config(container: AppContainer = Depends(get_container)) -> AppConfig:
    return container.config_service.load()


@router.put("/config", response_model=AppConfig)
def put_config(config: AppConfig, container: AppContainer = Depends(get_container)) -> AppConfig:
    saved = container.config_service.save(config)
    container.rebind_gateway(ParamikoSSHGateway(host=saved.server_ip or "127.0.0.1", port=saved.server_port))
    return saved


@router.post("/connection/test", response_model=ConnectionCheckResponse)
async def test_connection(
    request: ConnectionCheckRequest,
    container: AppContainer = Depends(get_container),
) -> ConnectionCheckResponse:
    loop = asyncio.get_running_loop()
    _, logger = build_command_logger(container, loop, "connection-test")
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
                        message="缺少仓库路径配置",
                    )
            )
                continue
            try:
                result = await run_in_threadpool(gateway.run, username, "pwd", None, logger, False)
                reachable = result.exit_code == 0
                repo_exists = gateway.stat(username, repo_path)
                checks.append(
                    ConnectionCheckResult(
                        username=username,
                        reachable=reachable and repo_exists,
                        repo_path=repo_path,
                        message="连接正常" if reachable and repo_exists else result.stderr.strip() or "仓库路径不存在",
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
    loop = asyncio.get_running_loop()
    _, logger = build_command_logger(container, loop, "jobs-refresh")
    try:
        result = await run_in_threadpool(container.job_service.refresh_jobs, logger)
        await container.broadcaster.broadcast(
            container.scheduler.build_jobs_refreshed_event(result.jobs)
        )
        return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)
    except SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/submit", response_model=SubmitJobResponse)
async def submit_job(request: SubmitJobRequest, container: AppContainer = Depends(get_container)) -> SubmitJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-submit")
    logger({"stage": "operation_start", "message": f"正在向账户 {request.account} 提交脚本 {request.script_path}"})
    try:
        job = await run_in_threadpool(container.job_service.submit_job, request, logger)
        logger({"stage": "operation_end", "message": f"任务 {job.job_id} 已提交到 {job.account}"})
        return SubmitJobResponse(job=job, message=f"任务 {job.job_id} 已提交到 {job.account}（操作 {operation_id}）")
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel", response_model=CancelJobResponse)
async def cancel_job(job_id: str, container: AppContainer = Depends(get_container)) -> CancelJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-cancel")
    logger({"stage": "operation_start", "message": f"正在取消任务 {job_id}"})
    try:
        job = await run_in_threadpool(container.job_service.cancel_job, job_id, logger)
        logger({"stage": "operation_end", "message": f"任务 {job_id} 已取消"})
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(container.database.list_jobs())
            )
        )
        return CancelJobResponse(
            job_id=job.job_id,
            account=job.account,
            message=f"任务 {job.job_id} 已取消（操作 {operation_id}）",
        )
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
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
async def sync_job(job_id: str, container: AppContainer = Depends(get_container)) -> SyncResponse:
    job = container.database.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"未知任务：{job_id}")
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-sync")
    logger({"stage": "operation_start", "message": f"正在将任务 {job_id} 的产出从 {job.account} 同步到 {container.config_service.load().main_username}"})
    try:
        synced_job = await run_in_threadpool(container.sync_service.sync_job, job, logger)
        logger({"stage": "operation_end", "message": f"任务 {job_id} 同步完成"})
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(container.database.list_jobs())
            )
        )
        return SyncResponse(job=synced_job, message=f"任务 {job_id} 已同步到主账户（操作 {operation_id}）")
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.websocket("/ws/status")
async def status_websocket(websocket: WebSocket, container: AppContainer = Depends(get_container)) -> None:
    await container.broadcaster.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        container.broadcaster.disconnect(websocket)
