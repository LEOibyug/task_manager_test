import type { JobRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

interface JobTableProps {
  jobs: JobRecord[];
  selectedJobId: string | null;
  onSelect: (job: JobRecord) => void;
  onSync: (job: JobRecord) => void;
}

export function JobTable({ jobs, selectedJobId, onSelect, onSync }: JobTableProps) {
  return (
    <div className="table-shell">
      <table className="job-table">
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Account</th>
            <th>Experiment</th>
            <th>Status</th>
            <th>Runtime</th>
            <th>Nodes</th>
            <th>Max</th>
            <th>Sync</th>
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
                <button
                  className="ghost-button"
                  disabled={job.status !== "COMPLETED" || job.synced}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSync(job);
                  }}
                >
                  {job.synced ? "Synced" : "Sync"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

