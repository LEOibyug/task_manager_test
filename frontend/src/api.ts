import type {
  AppConfig,
  CancelJobResponse,
  ConnectionCheckResponse,
  EvalLogResponse,
  ExperimentDetail,
  ExperimentSummary,
  JobsResponse,
  LogResponse,
  OutputTreeResponse,
} from "./types";

const jsonHeaders = {
  "Content-Type": "application/json",
};

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getConfig(): Promise<AppConfig> {
  return handleResponse<AppConfig>(await fetch("/api/config"));
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  return handleResponse<AppConfig>(
    await fetch("/api/config", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(config),
    }),
  );
}

export async function testConnection(config: AppConfig): Promise<ConnectionCheckResponse> {
  return handleResponse<ConnectionCheckResponse>(
    await fetch("/api/connection/test", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ config }),
    }),
  );
}

export async function listExperiments(): Promise<ExperimentSummary[]> {
  return handleResponse<ExperimentSummary[]>(await fetch("/api/experiments"));
}

export async function getExperimentDetail(experimentName: string): Promise<ExperimentDetail> {
  return handleResponse<ExperimentDetail>(await fetch(`/api/experiments/${encodeURIComponent(experimentName)}/files`));
}

export async function listJobs(): Promise<JobsResponse> {
  return handleResponse<JobsResponse>(await fetch("/api/jobs"));
}

export async function refreshJobs(): Promise<JobsResponse> {
  return handleResponse<JobsResponse>(await fetch("/api/jobs/refresh", { method: "POST" }));
}

export async function clearJobs(): Promise<JobsResponse> {
  return handleResponse<JobsResponse>(await fetch("/api/jobs/clear", { method: "POST" }));
}

export async function submitJob(payload: {
  experiment_name: string;
  script_path: string;
  account: string;
  preferred_gpu_node: "gpu1" | "gpu2" | "gpu3" | null;
}): Promise<{ message: string }> {
  return handleResponse<{ message: string }>(
    await fetch("/api/jobs/submit", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),
  );
}

export async function getJobLog(
  jobId: string,
  options: { offset?: number; tail?: boolean; search?: string; signal?: AbortSignal; view?: "preview" | "full" } = {},
): Promise<LogResponse> {
  const params = new URLSearchParams();
  if (options.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  if (options.tail) {
    params.set("tail", "true");
  }
  if (options.search) {
    params.set("search", options.search);
  }
  if (options.view) {
    params.set("view", options.view);
  }
  return handleResponse<LogResponse>(
    await fetch(`/api/jobs/${jobId}/log?${params.toString()}`, {
      signal: options.signal,
    }),
  );
}

export async function getOutputTree(jobId: string, signal?: AbortSignal): Promise<OutputTreeResponse> {
  return handleResponse<OutputTreeResponse>(
    await fetch(`/api/jobs/${jobId}/outputs/tree`, {
      signal,
    }),
  );
}

export async function getJobEvalLines(
  jobId: string,
  options: { pattern?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<EvalLogResponse> {
  const params = new URLSearchParams();
  if (options.pattern) {
    params.set("pattern", options.pattern);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  return handleResponse<EvalLogResponse>(
    await fetch(`/api/jobs/${jobId}/log/evals?${params.toString()}`, {
      signal: options.signal,
    }),
  );
}

export async function downloadOutputFile(jobId: string, path: string): Promise<void> {
  window.open(`/api/jobs/${jobId}/outputs/file?path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
}

export async function syncJob(jobId: string): Promise<{ message: string }> {
  return handleResponse<{ message: string }>(await fetch(`/api/jobs/${jobId}/sync`, { method: "POST" }));
}

export async function cancelJob(jobId: string): Promise<CancelJobResponse> {
  return handleResponse<CancelJobResponse>(await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function retryJob(jobId: string): Promise<{ job: { job_id: string }; message: string }> {
  return handleResponse<{ job: { job_id: string }; message: string }>(await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" }));
}
