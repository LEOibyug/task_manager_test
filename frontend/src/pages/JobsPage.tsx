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
  onClear: () => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  isRefreshing: boolean;
  isClearing: boolean;
  syncingJobIds: string[];
  cancellingJobIds: string[];
}

export function JobsPage({
  jobs,
  selectedJob,
  onSelectJob,
  onRefresh,
  onClear,
  onSync,
  onCancel,
  isRefreshing,
  isClearing,
  syncingJobIds,
  cancellingJobIds,
}: JobsPageProps) {
  return (
    <div className="jobs-shell">
      <SectionCard
        title="全局任务面板"
        actions={
          <div className="inline-controls">
            <button className="ghost-button" onClick={() => void onRefresh()} disabled={isRefreshing || isClearing}>
              {isRefreshing ? "刷新中..." : "立即刷新"}
            </button>
            <button className="ghost-button danger-button" onClick={() => void onClear()} disabled={isClearing || isRefreshing}>
              {isClearing ? "清空中..." : "一键清空"}
            </button>
          </div>
        }
      >
        <JobTable
          jobs={jobs}
          selectedJobId={selectedJob?.job_id ?? null}
          onSelect={onSelectJob}
          onSync={onSync}
          onCancel={onCancel}
          syncingJobIds={syncingJobIds}
          cancellingJobIds={cancellingJobIds}
        />
      </SectionCard>
      <div className="jobs-detail-grid">
        <LogViewer job={selectedJob} />
        <OutputTreeView job={selectedJob} />
      </div>
    </div>
  );
}
