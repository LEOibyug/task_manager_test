import type { JobRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

interface JobTableProps {
  jobs: JobRecord[];
  selectedJobId: string | null;
  onSelect: (job: JobRecord) => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  onRetry: (job: JobRecord) => void;
  syncingJobIds: string[];
  cancellingJobIds: string[];
  retryingJobIds: string[];
}

export function JobTable({
  jobs,
  selectedJobId,
  onSelect,
  onSync,
  onCancel,
  onRetry,
  syncingJobIds,
  cancellingJobIds,
  retryingJobIds,
}: JobTableProps) {
  function isTimeoutJob(job: JobRecord) {
    return job.status === "FAILED" && (job.last_error ?? "").toUpperCase().includes("TIMEOUT");
  }

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
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const isSyncing = syncingJobIds.includes(job.job_id);
            const isCancelling = cancellingJobIds.includes(job.job_id);
            const isRetrying = retryingJobIds.includes(job.job_id);
            const canRetry = isTimeoutJob(job);
            const showRetry = canRetry || isRetrying;
            return (
            <tr
              key={job.job_id}
              className={selectedJobId === job.job_id ? "is-selected" : ""}
              onClick={() => onSelect(job)}
            >
              <td>
                <div>{job.job_id}</div>
                {job.resumed_from_job_id ? <div className="job-subnote">续自 {job.resumed_from_job_id}</div> : null}
                {!job.resumed_from_job_id && job.continuation_root_job_id === job.job_id ? <div className="job-subnote">续训链根任务</div> : null}
              </td>
              <td>{job.account}</td>
              <td>
                <div>{job.experiment}</div>
                {job.continuation_root_job_id && job.continuation_root_job_id !== job.job_id ? (
                  <div className="job-subnote">链路 {job.continuation_root_job_id}</div>
                ) : null}
              </td>
              <td>
                <div className="job-status-cell">
                  <StatusBadge status={job.status} />
                  {showRetry ? (
                    <button
                      className="ghost-button compact-action-button"
                      disabled={!canRetry || isSyncing || isCancelling || isRetrying}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRetry(job);
                      }}
                    >
                      {isRetrying ? "续训中..." : "续训"}
                    </button>
                  ) : null}
                </div>
              </td>
              <td>{job.synced ? "已同步" : job.account === "main" ? "主账户任务" : "未同步"}</td>
              <td>{job.runtime ?? "-"}</td>
              <td>{job.nodes.join(", ") || "-"}</td>
              <td>{job.max_runtime_hours}h</td>
              <td>
                <div className="table-actions">
                  <button
                    className="ghost-button"
                    disabled={job.status !== "COMPLETED" || job.synced || isSyncing || isCancelling || isRetrying}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSync(job);
                    }}
                  >
                    {job.synced ? "已同步" : isSyncing ? "同步中..." : "同步"}
                  </button>
                  <button
                    className="ghost-button danger-button"
                    disabled={!["RUNNING", "PENDING"].includes(job.status) || isSyncing || isCancelling || isRetrying}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancel(job);
                    }}
                  >
                    {isCancelling ? "取消中..." : "取消"}
                  </button>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
