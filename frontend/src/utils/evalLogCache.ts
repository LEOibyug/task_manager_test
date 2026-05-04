import { getJobEvalLinesBatch } from "../api";
import type { EvalLogResponse, JobRecord } from "../types";

const ACTIVE_JOB_STATUSES = new Set(["RUNNING", "PENDING"]);

const evalResponseCache = new Map<string, EvalLogResponse>();

export interface ChainEvalLogItem {
  jobId: string;
  trainingIndex: number;
  trainingTotal: number;
  response: EvalLogResponse;
}

function shouldReuseCachedEval(job: JobRecord): boolean {
  return !ACTIVE_JOB_STATUSES.has(job.status);
}

export async function getChainEvalLogs(
  evalJobs: JobRecord[],
  options: {
    force?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ChainEvalLogItem[]> {
  const responsesByJobId = new Map<string, EvalLogResponse>();
  const jobsToFetch = evalJobs.filter((job) => {
    if (!options.force && shouldReuseCachedEval(job)) {
      const cached = evalResponseCache.get(job.job_id);
      if (cached) {
        responsesByJobId.set(job.job_id, cached);
        return false;
      }
    }
    return true;
  });

  if (jobsToFetch.length > 0) {
    const fetchedResponses = await getJobEvalLinesBatch(
      jobsToFetch.map((job) => job.job_id),
      {
        pattern: "latest_eval=",
        limit: 0,
        signal: options.signal,
      },
    );
    if (options.signal?.aborted) {
      return [];
    }
    fetchedResponses.forEach((response, index) => {
      const job = jobsToFetch[index];
      if (!job) {
        return;
      }
      responsesByJobId.set(job.job_id, response);
      if (options.force || shouldReuseCachedEval(job)) {
        evalResponseCache.set(job.job_id, response);
      }
    });
  }

  const trainingTotal = evalJobs.length;
  return evalJobs.map((job, index) => ({
    jobId: job.job_id,
    trainingIndex: index + 1,
    trainingTotal,
    response: responsesByJobId.get(job.job_id) ?? {
      job_id: job.job_id,
      log_path: "",
      pattern: "latest_eval=",
      entries: [],
    },
  }));
}
