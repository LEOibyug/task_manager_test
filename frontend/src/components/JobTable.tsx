import { Fragment, useState } from "react";
import type { DragEvent } from "react";

import type { JobRecord } from "../types";
import { buildJobChainGroups, getJobChainId } from "../utils/jobChain";
import { StatusBadge } from "./StatusBadge";

interface JobTableProps {
  jobs: JobRecord[];
  mainUsername: string;
  selectedJobId: string | null;
  onSelect: (job: JobRecord) => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  onRetry: (job: JobRecord) => void;
  onProactiveRetry: (job: JobRecord) => void;
  onInsertIntoChain: (job: JobRecord) => void;
  onReorderChain: (targetChainId: string, displayOrderedJobIds: string[]) => void;
  onDetachFromChain: (job: JobRecord) => void;
  onDelete: (job: JobRecord) => void;
  onAutoRetryChange: (job: JobRecord, enabled: boolean) => void;
  syncingJobIds: string[];
  cancellingJobIds: string[];
  retryingJobIds: string[];
  proactiveRetryingJobIds: string[];
  chainInsertingJobIds: string[];
  deletingJobIds: string[];
  updatingAutoRetryJobIds: string[];
}

export function JobTable({
  jobs,
  mainUsername,
  selectedJobId,
  onSelect,
  onSync,
  onCancel,
  onRetry,
  onProactiveRetry,
  onInsertIntoChain,
  onReorderChain,
  onDetachFromChain,
  onDelete,
  onAutoRetryChange,
  syncingJobIds,
  cancellingJobIds,
  retryingJobIds,
  proactiveRetryingJobIds,
  chainInsertingJobIds,
  deletingJobIds,
  updatingAutoRetryJobIds,
}: JobTableProps) {
  const [draggedJobId, setDraggedJobId] = useState<string | null>(null);
  const [dragOverJobId, setDragOverJobId] = useState<string | null>(null);
  const [dragOverChainId, setDragOverChainId] = useState<string | null>(null);

  function isTimeoutJob(job: JobRecord) {
    return job.status === "TIMEOUT" || (job.last_error ?? "").toUpperCase().includes("TIMEOUT");
  }

  function isProactiveTimeoutJob(job: JobRecord) {
    const marker = job.last_error ?? "";
    return job.status === "TIMEOUT" && (marker.includes("主动超时") || marker.toUpperCase().includes("ACTIVE_TIMEOUT"));
  }

  function buildDropOrder(targetJobs: JobRecord[], draggedJob: JobRecord, targetJob: JobRecord | null) {
    const existingIds = targetJobs.map((item) => item.job_id);
    const withoutDragged = targetJobs.filter((item) => item.job_id !== draggedJob.job_id);
    const targetIndex = targetJob
      ? withoutDragged.findIndex((item) => item.job_id === targetJob.job_id)
      : 0;
    const insertIndex = targetIndex >= 0 ? targetIndex : withoutDragged.length;
    const nextJobs = [...withoutDragged];
    nextJobs.splice(insertIndex, 0, draggedJob);
    const nextIds = nextJobs.map((item) => item.job_id);
    return nextIds.every((jobId, index) => jobId === existingIds[index]) && nextIds.length === existingIds.length
      ? null
      : nextIds;
  }

  function findGroupIdForJob(jobId: string | null): string | null {
    if (!jobId) {
      return null;
    }
    return chainGroups.find((group) => group.jobs.some((job) => job.job_id === jobId))?.chainId ?? null;
  }

  function isJobGrouped(job: JobRecord): boolean {
    const group = chainGroups.find((item) => item.chainId === getJobChainId(job));
    return Boolean(group?.isChain || job.continuation_root_job_id);
  }

  function handleDropIntoGroup(
    event: DragEvent,
    group: ReturnType<typeof buildJobChainGroups>[number],
    targetJob: JobRecord | null,
  ) {
    event.preventDefault();
    const sourceJobId = event.dataTransfer.getData("text/plain") || draggedJobId;
    const draggedJob = jobs.find((item) => item.job_id === sourceJobId);
    setDragOverJobId(null);
    setDragOverChainId(null);
    setDraggedJobId(null);
    if (!draggedJob) {
      return;
    }
    const sourceGroupId = findGroupIdForJob(draggedJob.job_id);
    if (targetJob && sourceGroupId !== group.chainId) {
      return;
    }
    const nextOrder = buildDropOrder(group.jobs, draggedJob, targetJob);
    if (!nextOrder) {
      return;
    }
    onReorderChain(group.chainId, nextOrder);
  }

  const chainGroups = buildJobChainGroups(jobs);
  const draggedJob = draggedJobId ? jobs.find((item) => item.job_id === draggedJobId) ?? null : null;
  const showDetachZone = Boolean(draggedJob && isJobGrouped(draggedJob));

  function handleDetachDrop(event: DragEvent) {
    event.preventDefault();
    const sourceJobId = event.dataTransfer.getData("text/plain") || draggedJobId;
    const sourceJob = jobs.find((item) => item.job_id === sourceJobId);
    setDragOverJobId(null);
    setDragOverChainId(null);
    setDraggedJobId(null);
    if (sourceJob && isJobGrouped(sourceJob)) {
      onDetachFromChain(sourceJob);
    }
  }

  function renderDetachZone(position: "top" | "bottom") {
    if (!showDetachZone) {
      return null;
    }
    return (
      <div
        className={[
          "chain-detach-zone",
          `chain-detach-zone--${position}`,
          dragOverChainId === "__detach__" ? "is-drag-over" : "",
        ].filter(Boolean).join(" ")}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOverChainId("__detach__");
          setDragOverJobId(null);
        }}
        onDragLeave={() => setDragOverChainId(null)}
        onDrop={handleDetachDrop}
      >
        <strong>{position === "top" ? "移出续训链" : "放到列表外，作为独立任务"}</strong>
        <span>出组请拖到这里；入组请拖到链条标题；同链任务行仅用于调整顺序。</span>
      </div>
    );
  }

  return (
    <div className="job-table-shell">
      {renderDetachZone("top")}
      <div className="table-shell">
      <table className="job-table">
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>账户</th>
            <th>实验</th>
            <th>状态</th>
            <th>同步</th>
            <th>运行时长</th>
            <th>节点</th>
            <th>时限</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {chainGroups.map((group) => {
            const chronologicalJobs = [...group.jobs].reverse();
            const latestContinuableJob = group.jobs.find((item) => item.status !== "CANCELLED") ?? group.summaryJob;
            return (
              <Fragment key={group.chainId}>
                {group.isChain ? (
                  <tr
                    className={[
                      "job-chain-header",
                      draggedJobId && dragOverChainId === group.chainId && dragOverJobId === null ? "is-drag-over" : "",
                    ].filter(Boolean).join(" ")}
                    onDragOver={(event) => {
                      if (!draggedJobId) {
                        return;
                      }
                      const sourceGroupId = findGroupIdForJob(draggedJobId);
                      if (sourceGroupId !== group.chainId && !group.isChain) {
                        return;
                      }
                      event.preventDefault();
                      setDragOverChainId(group.chainId);
                      setDragOverJobId(null);
                    }}
                    onDragLeave={() => {
                      setDragOverChainId(null);
                    }}
                    onDrop={(event) => handleDropIntoGroup(event, group, null)}
                  >
                    <td colSpan={9}>
                      <div className="job-chain-summary">
                        <span>续训链 {group.chainId}</span>
                        <span>共 {group.jobs.length} 次</span>
                        <span>最新任务 {group.summaryJob.job_id}</span>
                        {latestContinuableJob.job_id !== group.summaryJob.job_id ? (
                          <span>当前续训点 {latestContinuableJob.job_id}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
                {group.jobs.map((job) => {
            const isSyncing = syncingJobIds.includes(job.job_id);
            const isCancelling = cancellingJobIds.includes(job.job_id);
            const isRetrying = retryingJobIds.includes(job.job_id);
            const isProactiveRetrying = proactiveRetryingJobIds.includes(job.job_id);
            const isChainInserting = chainInsertingJobIds.includes(job.job_id);
            const isDeleting = deletingJobIds.includes(job.job_id);
            const isUpdatingAutoRetry = updatingAutoRetryJobIds.includes(job.job_id);
            const isMainAccountJob = job.account === mainUsername;
            const canRetry = isTimeoutJob(job) && latestContinuableJob.job_id === job.job_id;
            const canProactiveRetry = job.status === "RUNNING" && latestContinuableJob.job_id === job.job_id;
            const showRetry = canRetry || isRetrying;
            const showProactiveRetry = canProactiveRetry || isProactiveRetrying;
            const chainIndex = chronologicalJobs.findIndex((item) => item.job_id === job.job_id) + 1;
            const previousJob = chronologicalJobs[chainIndex - 2] ?? null;
            return (
            <tr
              key={job.job_id}
              draggable
              className={[
                selectedJobId === job.job_id ? "is-selected" : "",
                group.isChain ? "job-chain-row" : "",
                draggedJobId === job.job_id ? "is-dragging" : "",
                draggedJobId && dragOverJobId === job.job_id ? "is-drag-over" : "",
              ].filter(Boolean).join(" ")}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", job.job_id);
                setDraggedJobId(job.job_id);
              }}
              onDragEnd={() => {
                setDraggedJobId(null);
                setDragOverJobId(null);
                setDragOverChainId(null);
              }}
              onDragOver={(event) => {
                if (!draggedJobId || draggedJobId === job.job_id) {
                  return;
                }
                if (findGroupIdForJob(draggedJobId) !== group.chainId) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverChainId(group.chainId);
                setDragOverJobId(job.job_id);
              }}
              onDrop={(event) => handleDropIntoGroup(event, group, job)}
              onClick={() => onSelect(job)}
            >
              <td>
                <div className="job-id-stack">
                  <span>{job.job_id}</span>
                  {group.isChain ? <span className="job-chain-step">第 {chainIndex}/{group.jobs.length} 次</span> : null}
                </div>
                {previousJob ? <div className="job-subnote">续自 {previousJob.job_id}</div> : null}
                {group.isChain && chainIndex === 1 ? <div className="job-subnote">链路起点</div> : null}
              </td>
              <td>{job.account}</td>
              <td>
                <div>{job.experiment}</div>
                {group.isChain ? <div className="job-subnote">根任务 {group.chainId}</div> : null}
              </td>
              <td>
                <div className="job-status-cell">
                  <StatusBadge status={isTimeoutJob(job) ? "TIMEOUT" : job.status} />
                  {isProactiveTimeoutJob(job) ? <div className="job-subnote">主动超时</div> : null}
                  <label
                    className="slide-switch slide-switch--compact"
                    title="开启后，该任务从运行中转为超时时会自动续训；自动产生的后继任务会继承此设置。"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={job.auto_retry_enabled}
                      disabled={isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting || isUpdatingAutoRetry}
                      onChange={(event) => onAutoRetryChange(job, event.target.checked)}
                    />
                    <span className="slide-switch__track" aria-hidden="true">
                      <span className="slide-switch__thumb" />
                    </span>
                    <span className="slide-switch__label">
                      {isUpdatingAutoRetry ? "续训保存中" : job.auto_retry_enabled ? "自动续训开" : "自动续训关"}
                    </span>
                  </label>
                </div>
              </td>
              <td>{isMainAccountJob ? "主账户任务" : job.synced ? "已同步" : "未同步"}</td>
              <td>{job.runtime ?? "-"}</td>
              <td>
                {job.preferred_gpu_node ? <div>指定 {job.preferred_gpu_node}</div> : null}
                {job.nodes.length > 0 ? (
                  <div className={job.preferred_gpu_node ? "job-subnote" : ""}>运行 {job.nodes.join(", ")}</div>
                ) : null}
                {!job.preferred_gpu_node && job.nodes.length === 0 ? "-" : null}
              </td>
              <td>{job.max_runtime_hours}h</td>
              <td>
                <div className="table-actions">
                  {showRetry ? (
                    <button
                      className="ghost-button compact-action-button"
                      disabled={!canRetry || isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRetry(job);
                      }}
                    >
                      {isRetrying ? "续训中..." : "续训"}
                    </button>
                  ) : null}
                  {showProactiveRetry ? (
                    <button
                      className="ghost-button compact-action-button"
                      title="先主动停止当前运行任务，并以续训链逻辑提交新任务。"
                      disabled={!canProactiveRetry || isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onProactiveRetry(job);
                      }}
                    >
                      {isProactiveRetrying ? "主动续训中..." : "主动续训"}
                    </button>
                  ) : null}
                  {!isMainAccountJob ? (
                    <button
                      className="ghost-button compact-action-button"
                      disabled={job.status !== "COMPLETED" || job.synced || isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSync(job);
                      }}
                    >
                      {job.synced ? "已同步" : isSyncing ? "同步中..." : "同步"}
                    </button>
                  ) : null}
                  <button
                    className="ghost-button compact-action-button"
                    title="将该任务或该任务所在续训链插入到另一条续训链，便于合并查看全局评估数据。"
                    disabled={isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onInsertIntoChain(job);
                    }}
                  >
                    {isChainInserting ? "插入中..." : "插入链"}
                  </button>
                  <button
                    className="ghost-button danger-button compact-action-button"
                    disabled={!["RUNNING", "PENDING"].includes(job.status) || isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancel(job);
                    }}
                  >
                    {isCancelling ? "取消中..." : "取消"}
                  </button>
                  <button
                    className="ghost-button danger-button compact-action-button"
                    disabled={isSyncing || isCancelling || isRetrying || isProactiveRetrying || isChainInserting || isDeleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(job);
                    }}
                  >
                    {isDeleting ? "删除中..." : "删除"}
                  </button>
                </div>
              </td>
            </tr>
            );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {renderDetachZone("bottom")}
    </div>
  );
}
