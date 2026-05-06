import type { JobRecord } from "../types";

const ACTIVE_STATUSES = new Set(["RUNNING", "PENDING"]);

function jobTimestamp(job: JobRecord): number {
  if (!job.start_time) {
    return 0;
  }
  const value = Date.parse(job.start_time);
  return Number.isFinite(value) ? value : 0;
}

function jobNumericId(job: JobRecord): number {
  const value = Number.parseInt(job.job_id, 10);
  return Number.isFinite(value) ? value : 0;
}

function hasManualChainOrder(jobs: JobRecord[]): boolean {
  return jobs.some((job) => job.continuation_order !== null && job.continuation_order !== undefined);
}

function jobChainOrder(job: JobRecord): number {
  return job.continuation_order ?? 0;
}

export function getJobChainId(job: JobRecord): string {
  return job.continuation_root_job_id || job.job_id;
}

export function sortJobsByRecency(jobs: JobRecord[]): JobRecord[] {
  if (hasManualChainOrder(jobs)) {
    return [...jobs].sort((a, b) => {
      const orderDiff = jobChainOrder(b) - jobChainOrder(a);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      const timeDiff = jobTimestamp(b) - jobTimestamp(a);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return jobNumericId(b) - jobNumericId(a);
    });
  }
  return [...jobs].sort((a, b) => {
    const timeDiff = jobTimestamp(b) - jobTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return jobNumericId(b) - jobNumericId(a);
  });
}

export function getJobChainMembers(jobs: JobRecord[], targetJob: JobRecord): JobRecord[] {
  const chainId = getJobChainId(targetJob);
  return sortJobsByRecency(jobs.filter((job) => getJobChainId(job) === chainId));
}

export function getLatestJobInChain(jobs: JobRecord[], targetJob: JobRecord): JobRecord {
  return getJobChainMembers(jobs, targetJob)[0] ?? targetJob;
}

export function getLatestActiveJobInChain(jobs: JobRecord[], targetJob: JobRecord): JobRecord {
  const chainJobs = getJobChainMembers(jobs, targetJob);
  return chainJobs.find((job) => ACTIVE_STATUSES.has(job.status)) ?? chainJobs[0] ?? targetJob;
}

export interface JobChainGroup {
  chainId: string;
  summaryJob: JobRecord;
  jobs: JobRecord[];
  isChain: boolean;
}

export function buildJobChainGroups(jobs: JobRecord[]): JobChainGroup[] {
  const grouped = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const chainId = getJobChainId(job);
    const current = grouped.get(chainId);
    if (current) {
      current.push(job);
    } else {
      grouped.set(chainId, [job]);
    }
  }

  return Array.from(grouped.entries())
    .map(([chainId, groupJobs]) => {
      const sorted = sortJobsByRecency(groupJobs);
      return {
        chainId,
        summaryJob: sorted[0],
        jobs: sorted,
        isChain: sorted.length > 1,
      };
    })
    .sort((a, b) => {
      const timeDiff = jobTimestamp(b.summaryJob) - jobTimestamp(a.summaryJob);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return jobNumericId(b.summaryJob) - jobNumericId(a.summaryJob);
    });
}
