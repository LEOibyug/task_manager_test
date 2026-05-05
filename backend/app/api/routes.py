from __future__ import annotations

import asyncio
from pathlib import PurePosixPath
from typing import Literal
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
    EvalLogResponse,
    JobAutoRetryUpdateRequest,
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


def check_connection_for_account(
    gateway: ParamikoSSHGateway,
    username: str,
    repo_path: str | None,
    logger,
) -> ConnectionCheckResult:
    if not repo_path:
        logger({"stage": "stderr", "username": username, "message": "缺少仓库路径配置"})
        return ConnectionCheckResult(
            username=username,
            reachable=False,
            message="缺少仓库路径配置",
        )
    result = gateway.run(username, "pwd", None, logger, False)
    reachable = result.exit_code == 0
    repo_exists = gateway.stat(username, repo_path)
    logger(
        {
            "stage": "stdout" if reachable and repo_exists else "stderr",
            "username": username,
            "message": "连接正常" if reachable and repo_exists else result.stderr.strip() or "仓库路径不存在",
        }
    )
    return ConnectionCheckResult(
        username=username,
        reachable=reachable and repo_exists,
        repo_path=repo_path,
        message="连接正常" if reachable and repo_exists else result.stderr.strip() or "仓库路径不存在",
    )


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
    logger({"stage": "operation_start", "message": "正在测试各账户 SSH 连接与仓库路径"})
    gateway = ParamikoSSHGateway(host=request.config.server_ip or "127.0.0.1", port=request.config.server_port)
    checks: list[ConnectionCheckResult] = []
    try:
        usernames = [username for username in [request.config.main_username, *request.config.sub_usernames] if username]
        tasks = [
            run_in_threadpool(
                check_connection_for_account,
                gateway,
                username,
                request.config.repo_paths.get(username),
                logger,
            )
            for username in usernames
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for username, result in zip(usernames, results, strict=False):
            if isinstance(result, Exception):
                repo_path = request.config.repo_paths.get(username)
                checks.append(
                    ConnectionCheckResult(
                        username=username,
                        reachable=False,
                        repo_path=repo_path,
                        message=str(result),
                    )
                )
                logger({"stage": "stderr", "username": username, "message": str(result)})
                continue
            checks.append(result)
        logger({"stage": "operation_end", "message": f"连接测试完成，共检查 {len(checks)} 个账户"})
        return ConnectionCheckResponse(checks=checks)
    except Exception as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise
    finally:
        gateway.close()


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
    logger({"stage": "operation_start", "message": "正在刷新远端任务状态"})
    try:
        result = await run_in_threadpool(container.job_service.refresh_jobs, logger)
        logger({"stage": "operation_end", "message": f"任务刷新完成，当前共 {len(result.jobs)} 条记录"})
        await container.broadcaster.broadcast(
            container.scheduler.build_jobs_refreshed_event(result.jobs)
        )
        return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/submit", response_model=SubmitJobResponse)
async def submit_job(request: SubmitJobRequest, container: AppContainer = Depends(get_container)) -> SubmitJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-submit")
    logger({"stage": "operation_start", "message": f"正在向账户 {request.account} 提交脚本 {request.script_path}"})
    try:
        job = await run_in_threadpool(container.job_service.submit_job, request, logger)
        logger({"stage": "operation_end", "message": f"任务 {job.job_id} 已提交到 {job.account}"})
        jobs_result = await run_in_threadpool(container.job_service.list_jobs)
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(jobs_result.jobs)
            )
        )
        return SubmitJobResponse(job=job, message=f"任务 {job.job_id} 已提交到 {job.account}（操作 {operation_id}）")
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/retry", response_model=SubmitJobResponse)
async def retry_job(job_id: str, container: AppContainer = Depends(get_container)) -> SubmitJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-retry")
    logger({"stage": "operation_start", "message": f"正在为超时任务 {job_id} 提交续训任务"})
    try:
        job = await run_in_threadpool(container.job_service.retry_job, job_id, logger)
        logger({"stage": "operation_end", "message": f"续训任务 {job.job_id} 已提交到 {job.account}"})
        return SubmitJobResponse(job=job, message=f"续训任务 {job.job_id} 已提交到 {job.account}（操作 {operation_id}）")
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/proactive-retry", response_model=SubmitJobResponse)
async def proactive_retry_job(job_id: str, container: AppContainer = Depends(get_container)) -> SubmitJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-proactive-retry")
    logger({"stage": "operation_start", "message": f"正在主动停止任务 {job_id} 并提交续训任务"})
    try:
        job = await run_in_threadpool(container.job_service.proactive_retry_job, job_id, logger)
        logger({"stage": "operation_end", "message": f"主动续训任务 {job.job_id} 已提交到 {job.account}"})
        jobs_result = await run_in_threadpool(container.job_service.list_jobs)
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(jobs_result.jobs)
            )
        )
        return SubmitJobResponse(job=job, message=f"主动续训任务 {job.job_id} 已提交到 {job.account}（操作 {operation_id}）")
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/jobs/{job_id}/auto-retry", response_model=RefreshJobsResponse)
async def update_job_auto_retry(
    job_id: str,
    request: JobAutoRetryUpdateRequest,
    container: AppContainer = Depends(get_container),
) -> RefreshJobsResponse:
    loop = asyncio.get_running_loop()
    _, logger = build_command_logger(container, loop, "job-auto-retry")
    logger(
        {
            "stage": "operation_start",
            "message": f"正在{'开启' if request.auto_retry_enabled else '关闭'}任务 {job_id} 的自动续训",
        }
    )
    try:
        result = await run_in_threadpool(
            container.job_service.set_job_auto_retry,
            job_id,
            request.auto_retry_enabled,
        )
        logger({"stage": "operation_end", "message": f"任务 {job_id} 的自动续训配置已保存"})
        await container.broadcaster.broadcast(
            container.scheduler.build_jobs_refreshed_event(result.jobs)
        )
        return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel", response_model=CancelJobResponse)
async def cancel_job(job_id: str, container: AppContainer = Depends(get_container)) -> CancelJobResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-cancel")
    logger({"stage": "operation_start", "message": f"正在取消任务 {job_id}"})
    try:
        await run_in_threadpool(container.job_service.cancel_job, job_id, logger)
        result = await run_in_threadpool(container.job_service.refresh_jobs, logger)
        job = next((item for item in result.jobs if item.job_id == job_id), None)
        logger({"stage": "operation_end", "message": f"任务 {job_id} 已提交取消，并已按 Slurm 状态刷新"})
        asyncio.create_task(
            container.broadcaster.broadcast(
                container.scheduler.build_jobs_refreshed_event(result.jobs)
            )
        )
        return CancelJobResponse(
            job_id=job.job_id if job else job_id,
            account=job.account if job else "",
            message=f"任务 {job_id} 已提交取消并完成状态刷新（操作 {operation_id}）",
        )
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/jobs/{job_id}", response_model=RefreshJobsResponse)
async def delete_job(job_id: str, container: AppContainer = Depends(get_container)) -> RefreshJobsResponse:
    loop = asyncio.get_running_loop()
    operation_id, logger = build_command_logger(container, loop, "job-delete")
    logger({"stage": "operation_start", "message": f"正在删除任务 {job_id} 的本地记录"})
    try:
        await run_in_threadpool(container.job_service.delete_job, job_id)
        result = container.job_service.list_jobs()
        logger({"stage": "operation_end", "message": f"任务 {job_id} 的本地记录已删除"})
        await container.broadcaster.broadcast(
            container.scheduler.build_jobs_refreshed_event(result.jobs)
        )
        return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)
    except SSHError as exc:
        logger({"stage": "operation_error", "message": str(exc)})
        raise HTTPException(status_code=400, detail=f"{exc}（操作 {operation_id}）") from exc


@router.post("/jobs/clear", response_model=RefreshJobsResponse)
async def clear_jobs(container: AppContainer = Depends(get_container)) -> RefreshJobsResponse:
    loop = asyncio.get_running_loop()
    _, logger = build_command_logger(container, loop, "jobs-clear")
    logger({"stage": "operation_start", "message": "正在清空本地非运行任务记录"})
    await run_in_threadpool(container.job_service.clear_jobs)
    result = container.job_service.list_jobs()
    logger({"stage": "operation_end", "message": "本地非运行任务记录已清空"})
    await container.broadcaster.broadcast(
        container.scheduler.build_jobs_refreshed_event(result.jobs)
    )
    return RefreshJobsResponse(jobs=result.jobs, refreshed_at=result.refreshed_at)


@router.get("/jobs/{job_id}/log", response_model=LogResponse)
def read_log(
    job_id: str,
    offset: int = Query(default=0, ge=0),
    tail: bool = False,
    search: str | None = None,
    view: Literal["preview", "full"] = Query(default="full"),
    container: AppContainer = Depends(get_container),
) -> LogResponse:
    try:
        return container.log_service.read_log(job_id=job_id, offset=offset, tail=tail, search=search, view=view)
    except SSHError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/log/evals", response_model=EvalLogResponse)
def read_eval_log_lines(
    job_id: str,
    pattern: str = Query(default="latest_eval="),
    limit: int = Query(default=12, ge=0, le=10000),
    container: AppContainer = Depends(get_container),
) -> EvalLogResponse:
    try:
        return container.log_service.read_eval_lines(job_id=job_id, pattern=pattern, limit=limit)
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
    await container.scheduler.sync_log_tracking(container.database.list_jobs())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        container.broadcaster.disconnect(websocket)
        await container.scheduler.sync_log_tracking(container.database.list_jobs())
