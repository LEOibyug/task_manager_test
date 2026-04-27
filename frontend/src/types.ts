export type JobState = "RUNNING" | "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";

export interface AppConfig {
  server_ip: string;
  server_port: number;
  main_username: string;
  sub_usernames: string[];
  repo_paths: Record<string, string>;
  refresh_interval: number;
}

export interface ExperimentSummary {
  name: string;
  path: string;
}

export interface ExperimentFile {
  name: string;
  path: string;
  is_dir: boolean;
  kind: "directory" | "sbatch" | "shell" | "file";
}

export interface ExperimentDetail {
  experiment: ExperimentSummary;
  files: ExperimentFile[];
}

export interface JobRecord {
  job_id: string;
  account: string;
  experiment: string;
  script_path: string;
  status: JobState;
  start_time: string | null;
  runtime: string | null;
  nodes: string[];
  resource_usage: string | null;
  max_runtime_hours: number;
  log_path: string | null;
  job_name: string | null;
  output_path_hint: string | null;
  synced: boolean;
  last_error: string | null;
}

export interface JobsResponse {
  jobs: JobRecord[];
  refreshed_at: string;
}

export interface CancelJobResponse {
  job_id: string;
  account: string;
  message: string;
}

export interface ConnectionCheckResult {
  username: string;
  reachable: boolean;
  repo_path?: string | null;
  message: string;
}

export interface ConnectionCheckResponse {
  checks: ConnectionCheckResult[];
}

export interface LogResponse {
  job_id: string;
  log_path: string;
  content: string;
  next_offset: number;
  size: number;
  truncated: boolean;
}

export interface OutputNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: OutputNode[];
}

export interface OutputTreeResponse {
  job_id: string;
  root: OutputNode;
}

export interface OutputFileItem {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface StatusEvent {
  type: "jobs_refreshed" | "sync_complete" | "error" | "heartbeat" | "command_log";
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CommandLogEventPayload {
  operation_id: string;
  action: string;
  stage: "operation_start" | "command_start" | "stdout" | "stderr" | "command_end" | "operation_end" | "operation_error";
  username?: string;
  command?: string;
  message?: string;
  exit_code?: number;
}
