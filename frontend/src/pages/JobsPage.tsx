import { JobTable } from "../components/JobTable";
import { LogViewer } from "../components/LogViewer";
import { OutputTreeView } from "../components/OutputTreeView";
import { SectionCard } from "../components/SectionCard";
import { useMemo, useState } from "react";

import type { JobLogCacheEntry, JobRecord, JobState } from "../types";

type JobCategory = "ALL" | "ACTIVE" | "COMPLETED" | "TIMEOUT" | "FAILED" | "CANCELLED" | "UNKNOWN";

const categoryOptions: Array<{ id: JobCategory; label: string }> = [
  { id: "ALL", label: "全部" },
  { id: "ACTIVE", label: "运行/排队" },
  { id: "COMPLETED", label: "已完成" },
  { id: "TIMEOUT", label: "超时" },
  { id: "FAILED", label: "失败" },
  { id: "CANCELLED", label: "已取消" },
  { id: "UNKNOWN", label: "未知" },
];

function isTimeoutJob(job: JobRecord): boolean {
  return job.status === "TIMEOUT" || (job.last_error ?? "").toUpperCase().includes("TIMEOUT");
}

interface JobsPageProps {
  mainUsername: string;
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
  onDelete: (job: JobRecord) => void;
  autoRetryEnabled: boolean;
  onAutoRetryChange: (enabled: boolean) => void;
  isRefreshing: boolean;
  isClearing: boolean;
  syncingJobIds: string[];
  cancellingJobIds: string[];
  retryingJobIds: string[];
  deletingJobIds: string[];
}

export function JobsPage({
  mainUsername,
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
  onDelete,
  autoRetryEnabled,
  onAutoRetryChange,
  isRefreshing,
  isClearing,
  syncingJobIds,
  cancellingJobIds,
  retryingJobIds,
  deletingJobIds,
}: JobsPageProps) {
  const [category, setCategory] = useState<JobCategory>("ALL");
  const categoryCounts = useMemo(() => {
    const counts: Record<JobCategory, number> = {
      ALL: jobs.length,
      ACTIVE: jobs.filter((job) => ["RUNNING", "PENDING"].includes(job.status)).length,
      COMPLETED: jobs.filter((job) => job.status === "COMPLETED").length,
      TIMEOUT: jobs.filter(isTimeoutJob).length,
      FAILED: jobs.filter((job) => job.status === "FAILED" && !isTimeoutJob(job)).length,
      CANCELLED: jobs.filter((job) => job.status === "CANCELLED").length,
      UNKNOWN: jobs.filter((job) => job.status === "UNKNOWN").length,
    };
    return counts;
  }, [jobs]);
  const visibleJobs = useMemo(() => {
    if (category === "ALL") {
      return jobs;
    }
    if (category === "ACTIVE") {
      return jobs.filter((job) => ["RUNNING", "PENDING"].includes(job.status));
    }
    if (category === "TIMEOUT") {
      return jobs.filter(isTimeoutJob);
    }
    if (category === "FAILED") {
      return jobs.filter((job) => job.status === "FAILED" && !isTimeoutJob(job));
    }
    return jobs.filter((job) => job.status === (category as JobState));
  }, [category, jobs]);

  return (
    <div className="jobs-shell">
      <SectionCard
        title="全局任务面板"
        actions={
          <div className="inline-controls">
            <label className="switch-control">
              <input
                type="checkbox"
                checked={autoRetryEnabled}
                onChange={(event) => onAutoRetryChange(event.target.checked)}
              />
              <span>自动续训</span>
            </label>
            <button className="ghost-button" onClick={() => void onRefresh()} disabled={isRefreshing || isClearing}>
              {isRefreshing ? "刷新中..." : "立即刷新"}
            </button>
            <button className="ghost-button danger-button" onClick={() => void onClear()} disabled={isClearing || isRefreshing}>
              {isClearing ? "清空中..." : "一键清空"}
            </button>
          </div>
        }
      >
        <div className="job-category-tabs">
          {categoryOptions.map((option) => (
            <button
              key={option.id}
              className={`job-category-tab ${category === option.id ? "active" : ""}`}
              onClick={() => setCategory(option.id)}
            >
              <span>{option.label}</span>
              <span>{categoryCounts[option.id]}</span>
            </button>
          ))}
        </div>
        <JobTable
          jobs={visibleJobs}
          mainUsername={mainUsername}
          selectedJobId={selectedJob?.job_id ?? null}
          onSelect={onSelectJob}
          onSync={onSync}
          onCancel={onCancel}
          onRetry={onRetry}
          onDelete={onDelete}
          syncingJobIds={syncingJobIds}
          cancellingJobIds={cancellingJobIds}
          retryingJobIds={retryingJobIds}
          deletingJobIds={deletingJobIds}
        />
      </SectionCard>
      <div className="jobs-detail-grid">
        <LogViewer job={selectedJob} jobs={jobs} cacheEntry={selectedJobCache} onCacheUpdate={onUpdateJobCache} />
        <OutputTreeView job={selectedJob} />
      </div>
    </div>
  );
}
