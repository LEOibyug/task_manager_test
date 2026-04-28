import { JobTable } from "../components/JobTable";
import { LogViewer } from "../components/LogViewer";
import { OutputTreeView } from "../components/OutputTreeView";
import { SectionCard } from "../components/SectionCard";
import type { JobLogCacheEntry, JobRecord } from "../types";

interface JobsPageProps {
  jobs: JobRecord[];
  selectedJob: JobRecord | null;
  selectedJobCache: JobLogCacheEntry | null;
  onSelectJob: (job: JobRecord) => void;
  onUpdateJobCache: (jobId: string, patch: Partial<JobLogCacheEntry>) => void;
  onRefresh: () => void;
  onClear: () => void;
  onSync: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  onRetry: (job: JobRecord) => void;
  isRefreshing: boolean;
  isClearing: boolean;
  syncingJobIds: string[];
  cancellingJobIds: string[];
  retryingJobIds: string[];
}

export function JobsPage({
  jobs,
  selectedJob,
  selectedJobCache,
  onSelectJob,
  onUpdateJobCache,
  onRefresh,
  onClear,
  onSync,
  onCancel,
  onRetry,
  isRefreshing,
  isClearing,
  syncingJobIds,
  cancellingJobIds,
  retryingJobIds,
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
          onRetry={onRetry}
          syncingJobIds={syncingJobIds}
          cancellingJobIds={cancellingJobIds}
          retryingJobIds={retryingJobIds}
        />
      </SectionCard>
      <div className="jobs-detail-grid">
        <LogViewer job={selectedJob} cacheEntry={selectedJobCache} onCacheUpdate={onUpdateJobCache} />
        <OutputTreeView job={selectedJob} />
      </div>
    </div>
  );
}
