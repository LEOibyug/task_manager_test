import type { JobRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

interface JobTableProps {
  jobs: JobRecord[];
  selectedJobId: string | null;
  onSelect: (job: JobRecord) => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
}

export function JobTable({ jobs, selectedJobId, onSelect, onSync, onCancel }: JobTableProps) {
  return (
    <div className="table-shell">
      <table className="job-table">
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>账户</th>
            <th>实验</th>
            <th>状态</th>
            <th>运行时长</th>
            <th>节点</th>
            <th>时限</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.job_id}
              className={selectedJobId === job.job_id ? "is-selected" : ""}
              onClick={() => onSelect(job)}
            >
              <td>{job.job_id}</td>
              <td>{job.account}</td>
              <td>{job.experiment}</td>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>{job.runtime ?? "-"}</td>
              <td>{job.nodes.join(", ") || "-"}</td>
              <td>{job.max_runtime_hours}h</td>
              <td>
                <div className="table-actions">
                  <button
                    className="ghost-button"
                    disabled={job.status !== "COMPLETED" || job.synced}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSync(job);
                    }}
                  >
                    {job.synced ? "已同步" : "同步"}
                  </button>
                  <button
                    className="ghost-button danger-button"
                    disabled={!["RUNNING", "PENDING"].includes(job.status)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancel(job);
                    }}
                  >
                    取消
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
