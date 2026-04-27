import { JobTable } from "../components/JobTable";
import { LogViewer } from "../components/LogViewer";
import { OutputTreeView } from "../components/OutputTreeView";
import { SectionCard } from "../components/SectionCard";
import type { JobRecord } from "../types";

interface JobsPageProps {
  jobs: JobRecord[];
  selectedJob: JobRecord | null;
  onSelectJob: (job: JobRecord) => void;
  onRefresh: () => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
}

export function JobsPage({ jobs, selectedJob, onSelectJob, onRefresh, onSync, onCancel }: JobsPageProps) {
  return (
    <div className="jobs-shell">
      <SectionCard
        title="全局任务面板"
        actions={
          <button className="ghost-button" onClick={onRefresh}>
            立即刷新
          </button>
        }
      >
        <JobTable
          jobs={jobs}
          selectedJobId={selectedJob?.job_id ?? null}
          onSelect={onSelectJob}
          onSync={onSync}
          onCancel={onCancel}
        />
      </SectionCard>
      <div className="jobs-detail-grid">
        <LogViewer job={selectedJob} />
        <OutputTreeView job={selectedJob} />
      </div>
    </div>
  );
}
