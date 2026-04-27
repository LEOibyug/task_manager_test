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
}

export function JobsPage({ jobs, selectedJob, onSelectJob, onRefresh, onSync }: JobsPageProps) {
  return (
    <div className="jobs-shell">
      <SectionCard
        title="Global Job Board"
        actions={
          <button className="ghost-button" onClick={onRefresh}>
            Refresh now
          </button>
        }
      >
        <JobTable jobs={jobs} selectedJobId={selectedJob?.job_id ?? null} onSelect={onSelectJob} onSync={onSync} />
      </SectionCard>
      <div className="jobs-detail-grid">
        <LogViewer job={selectedJob} />
        <OutputTreeView job={selectedJob} />
      </div>
    </div>
  );
}

