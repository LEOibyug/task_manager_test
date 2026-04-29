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

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  return handleResponse<T>(await fetch(input, init));
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getConfig(): Promise<AppConfig> {
  return requestJson<AppConfig>("/api/config");
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  return requestJson<AppConfig>("/api/config", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(config),
  });
}

export async function testConnection(config: AppConfig): Promise<ConnectionCheckResponse> {
  return requestJson<ConnectionCheckResponse>("/api/connection/test", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ config }),
  });
}

export async function listExperiments(): Promise<ExperimentSummary[]> {
  return requestJson<ExperimentSummary[]>("/api/experiments");
}

export async function getExperimentDetail(experimentName: string): Promise<ExperimentDetail> {
  return requestJson<ExperimentDetail>(`/api/experiments/${encodeURIComponent(experimentName)}/files`);
}

export async function listJobs(): Promise<JobsResponse> {
  return requestJson<JobsResponse>("/api/jobs");
}

export async function refreshJobs(): Promise<JobsResponse> {
  return requestJson<JobsResponse>("/api/jobs/refresh", { method: "POST" });
}

export async function clearJobs(): Promise<JobsResponse> {
  return requestJson<JobsResponse>("/api/jobs/clear", { method: "POST" });
}

export async function submitJob(payload: {
  experiment_name: string;
  script_path: string;
  account: string;
  preferred_gpu_node: "gpu1" | "gpu2" | "gpu3" | null;
}): Promise<{ message: string }> {
  return requestJson<{ message: string }>("/api/jobs/submit", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
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
  return requestJson<LogResponse>(`/api/jobs/${jobId}/log?${params.toString()}`, {
    signal: options.signal,
  });
}

export async function getOutputTree(jobId: string, signal?: AbortSignal): Promise<OutputTreeResponse> {
  return requestJson<OutputTreeResponse>(`/api/jobs/${jobId}/outputs/tree`, {
    signal,
  });
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
  return requestJson<EvalLogResponse>(`/api/jobs/${jobId}/log/evals?${params.toString()}`, {
    signal: options.signal,
  });
}

export async function downloadOutputFile(jobId: string, path: string): Promise<void> {
  window.open(`/api/jobs/${jobId}/outputs/file?path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
}

export async function syncJob(jobId: string): Promise<{ message: string }> {
  return requestJson<{ message: string }>(`/api/jobs/${jobId}/sync`, { method: "POST" });
}

export async function cancelJob(jobId: string): Promise<CancelJobResponse> {
  return requestJson<CancelJobResponse>(`/api/jobs/${jobId}/cancel`, { method: "POST" });
}

export async function retryJob(jobId: string): Promise<{ job: { job_id: string }; message: string }> {
  return requestJson<{ job: { job_id: string }; message: string }>(`/api/jobs/${jobId}/retry`, { method: "POST" });
}
