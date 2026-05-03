import { Fragment } from "react";

import type { JobRecord } from "../types";
import { buildJobChainGroups } from "../utils/jobChain";
import { StatusBadge } from "./StatusBadge";

interface JobTableProps {
  jobs: JobRecord[];
  mainUsername: string;
  selectedJobId: string | null;
  onSelect: (job: JobRecord) => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  onRetry: (job: JobRecord) => void;
  onDelete: (job: JobRecord) => void;
  onAutoRetryChange: (job: JobRecord, enabled: boolean) => void;
  syncingJobIds: string[];
  cancellingJobIds: string[];
  retryingJobIds: string[];
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
  onDelete,
  onAutoRetryChange,
  syncingJobIds,
  cancellingJobIds,
  retryingJobIds,
  deletingJobIds,
  updatingAutoRetryJobIds,
}: JobTableProps) {
  function isTimeoutJob(job: JobRecord) {
    return job.status === "TIMEOUT" || (job.last_error ?? "").toUpperCase().includes("TIMEOUT");
  }

  const chainGroups = buildJobChainGroups(jobs);

  return (
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
            <th>自动续训</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {chainGroups.map((group) => {
            const chronologicalJobs = [...group.jobs].reverse();
            return (
              <Fragment key={group.chainId}>
                {group.isChain ? (
                  <tr className="job-chain-header">
                    <td colSpan={10}>
                      <div className="job-chain-summary">
                        <span>续训链 {group.chainId}</span>
                        <span>共 {group.jobs.length} 次</span>
                        <span>最新任务 {group.summaryJob.job_id}</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {group.jobs.map((job) => {
            const isSyncing = syncingJobIds.includes(job.job_id);
            const isCancelling = cancellingJobIds.includes(job.job_id);
            const isRetrying = retryingJobIds.includes(job.job_id);
            const isDeleting = deletingJobIds.includes(job.job_id);
            const isUpdatingAutoRetry = updatingAutoRetryJobIds.includes(job.job_id);
            const isMainAccountJob = job.account === mainUsername;
            const canRetry = isTimeoutJob(job) && group.summaryJob.job_id === job.job_id;
            const showRetry = canRetry || isRetrying;
            const chainIndex = chronologicalJobs.findIndex((item) => item.job_id === job.job_id) + 1;
            const previousJob = chronologicalJobs[chainIndex - 2] ?? null;
            return (
            <tr
              key={job.job_id}
              className={[
                selectedJobId === job.job_id ? "is-selected" : "",
                group.isChain ? "job-chain-row" : "",
              ].filter(Boolean).join(" ")}
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
                <label className="switch-control compact-switch-control" title="开启后，该任务超时会自动续训；自动产生的后继任务会继承此设置。">
                  <input
                    type="checkbox"
                    checked={job.auto_retry_enabled}
                    disabled={isSyncing || isCancelling || isRetrying || isDeleting || isUpdatingAutoRetry}
                    onChange={(event) => {
                      event.stopPropagation();
                      onAutoRetryChange(job, event.target.checked);
                    }}
                    onClick={(event) => event.stopPropagation()}
                  />
                  <span>{isUpdatingAutoRetry ? "保存中" : job.auto_retry_enabled ? "开启" : "关闭"}</span>
                </label>
              </td>
              <td>
                <div className="table-actions">
                  {showRetry ? (
                    <button
                      className="ghost-button compact-action-button"
                      disabled={!canRetry || isSyncing || isCancelling || isRetrying || isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRetry(job);
                      }}
                    >
                      {isRetrying ? "续训中..." : "续训"}
                    </button>
                  ) : null}
                  {!isMainAccountJob ? (
                    <button
                      className="ghost-button compact-action-button"
                      disabled={job.status !== "COMPLETED" || job.synced || isSyncing || isCancelling || isRetrying || isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSync(job);
                      }}
                    >
                      {job.synced ? "已同步" : isSyncing ? "同步中..." : "同步"}
                    </button>
                  ) : null}
                  <button
                    className="ghost-button danger-button compact-action-button"
                    disabled={!["RUNNING", "PENDING"].includes(job.status) || isSyncing || isCancelling || isRetrying || isDeleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancel(job);
                    }}
                  >
                    {isCancelling ? "取消中..." : "取消"}
                  </button>
                  <button
                    className="ghost-button danger-button compact-action-button"
                    disabled={isSyncing || isCancelling || isRetrying || isDeleting}
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
  );
}
