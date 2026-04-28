import { useEffect, useMemo, useState } from "react";

import { cancelJob, clearJobs, getConfig, listJobs, refreshJobs, retryJob, syncJob } from "./api";
import { OperationConsole } from "./components/OperationConsole";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { ExperimentsPage } from "./pages/ExperimentsPage";
import { JobsPage } from "./pages/JobsPage";
import type {
  AppConfig,
  CommandLogEventPayload,
  EvalLogResponse,
  JobLogCacheEntry,
  JobRecord,
  LogResponse,
  StatusEvent,
} from "./types";
import type { ExperimentSummary } from "./types";

const emptyConfig: AppConfig = {
  server_ip: "",
  server_port: 22,
  main_username: "",
  sub_usernames: [],
  repo_paths: {},
  refresh_interval: 10,
};

type TabId = "config" | "experiments" | "jobs";
type PendingRequest = {
  id: string;
  label: string;
  detail: string;
};

const TRACKABLE_JOB_STATUSES = new Set(["RUNNING", "PENDING"]);

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("config");
  const [banner, setBanner] = useState<string>("尚未建立实时状态连接。");
  const [commandLogs, setCommandLogs] = useState<Array<{ payload: CommandLogEventPayload; timestamp: string }>>([]);
  const [activeOperationIds, setActiveOperationIds] = useState<string[]>([]);
  const [experimentCache, setExperimentCache] = useState<ExperimentSummary[] | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [isRefreshingJobs, setIsRefreshingJobs] = useState(false);
  const [isClearingJobs, setIsClearingJobs] = useState(false);
  const [syncingJobIds, setSyncingJobIds] = useState<string[]>([]);
  const [cancellingJobIds, setCancellingJobIds] = useState<string[]>([]);
  const [retryingJobIds, setRetryingJobIds] = useState<string[]>([]);
  const [jobLogCache, setJobLogCache] = useState<Record<string, JobLogCacheEntry>>({});

  useEffect(() => {
    setSelectedJob((current) => {
      if (!current) {
        return current;
      }
      return jobs.find((job) => job.job_id === current.job_id) ?? null;
    });
  }, [jobs]);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => undefined);
    listJobs().then((response) => setJobs(response.jobs)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const cacheableJobIds = new Set(
      jobs
        .filter((job) => TRACKABLE_JOB_STATUSES.has(job.status) || job.job_id === selectedJob?.job_id)
        .map((job) => job.job_id),
    );
    setJobLogCache((current) =>
      Object.fromEntries(Object.entries(current).filter(([jobId]) => cacheableJobIds.has(jobId))),
    );
  }, [jobs, selectedJob?.job_id]);

  function updateJobLogCache(jobId: string, patch: Partial<JobLogCacheEntry>) {
    setJobLogCache((current) => {
      const nextEntry: JobLogCacheEntry = current[jobId]
        ? { ...current[jobId] }
        : {
            job_id: jobId,
            log: null,
            eval_log: null,
            log_updated_at: 0,
            eval_updated_at: 0,
          };
      Object.assign(nextEntry, patch);
      nextEntry.job_id = jobId;
      return {
        ...current,
        [jobId]: nextEntry,
      };
    });
  }

  function applyJobLogStreamUpdate(
    jobId: string,
    payload: {
      log?: LogResponse | null;
      eval_log?: EvalLogResponse | null;
    },
    updatedAt: number,
  ) {
    updateJobLogCache(jobId, {
      ...(payload.log !== undefined ? { log: payload.log ?? null, log_updated_at: updatedAt } : {}),
      ...(payload.eval_log !== undefined ? { eval_log: payload.eval_log ?? null, eval_updated_at: updatedAt } : {}),
    });
  }

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/ws/status`);
    socket.addEventListener("open", () => {
      setBanner("实时状态流已连接。");
      socket.send("subscribe");
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as StatusEvent;
      if (message.type === "jobs_refreshed") {
        const nextJobs = (message.payload.jobs as JobRecord[]) ?? [];
        setJobs(nextJobs);
        setBanner(`已收到实时更新：当前跟踪 ${nextJobs.length} 个任务。`);
      }
      if (message.type === "command_log") {
        const payload = message.payload as unknown as CommandLogEventPayload;
        setCommandLogs((current) => {
          const next = [
            ...current,
            {
              payload,
              timestamp: message.timestamp,
            },
          ];
          return next.slice(-300);
        });
        if (payload.stage === "operation_start") {
          setActiveOperationIds((current) => Array.from(new Set([...current, payload.operation_id])));
        }
        if (payload.stage === "operation_end" || payload.stage === "operation_error") {
          setActiveOperationIds((current) => current.filter((operationId) => operationId !== payload.operation_id));
        }
      }
      if (message.type === "job_log_cache_update") {
        const jobId = String(message.payload.job_id ?? "");
        if (!jobId) {
          return;
        }
        const timestamp = Date.parse(message.timestamp);
        applyJobLogStreamUpdate(
          jobId,
          {
            log: (message.payload.log as LogResponse | undefined) ?? undefined,
            eval_log: (message.payload.eval_log as EvalLogResponse | undefined) ?? undefined,
          },
          Number.isFinite(timestamp) ? timestamp : Date.now(),
        );
      }
      if (message.type === "error") {
        setBanner(`后台刷新出错：${String(message.payload.message ?? "未知错误")}`);
      }
    });
    socket.addEventListener("close", () => setBanner("实时状态流已断开。"));
    return () => socket.close();
  }, []);

  const tabs = useMemo(() => [
    { id: "config" as const, label: "配置" },
    { id: "experiments" as const, label: "实验" },
    { id: "jobs" as const, label: "任务" },
  ], []);

  function beginPendingRequest(label: string, detail: string): string {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setPendingRequests((current) => [...current, { id, label, detail }]);
    setBanner(`${label}已发起，等待后端返回实时反馈。`);
    return id;
  }

  function finishPendingRequest(id: string): void {
    setPendingRequests((current) => current.filter((item) => item.id !== id));
  }

  async function handleRefreshJobs() {
    const pendingId = beginPendingRequest("刷新任务", "已向后端发出刷新请求，等待远端任务扫描输出。");
    setIsRefreshingJobs(true);
    try {
      const response = await refreshJobs();
      setJobs(response.jobs);
    } finally {
      setIsRefreshingJobs(false);
      finishPendingRequest(pendingId);
    }
  }

  async function handleSync(job: JobRecord) {
    const pendingId = beginPendingRequest("同步结果", `任务 ${job.job_id} 正在发起从 ${job.account} 到主账户的同步。`);
    setSyncingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await syncJob(job.job_id);
      const response = await listJobs();
      setJobs(response.jobs);
    } finally {
      setSyncingJobIds((current) => current.filter((item) => item !== job.job_id));
      finishPendingRequest(pendingId);
    }
  }

  async function handleCancel(job: JobRecord) {
    const pendingId = beginPendingRequest("取消任务", `任务 ${job.job_id} 正在请求取消，请等待 scancel 输出。`);
    setCancellingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await cancelJob(job.job_id);
      const response = await listJobs();
      setJobs(response.jobs);
    } finally {
      setCancellingJobIds((current) => current.filter((item) => item !== job.job_id));
      finishPendingRequest(pendingId);
    }
  }

  async function handleClearJobs() {
    const pendingId = beginPendingRequest("清空任务", "正在清空本地任务记录列表。");
    setIsClearingJobs(true);
    try {
      const response = await clearJobs();
      setJobs(response.jobs);
      setSelectedJob(null);
    } finally {
      setIsClearingJobs(false);
      finishPendingRequest(pendingId);
    }
  }

  async function handleRetry(job: JobRecord) {
    const pendingId = beginPendingRequest("续训任务", `任务 ${job.job_id} 已超时，正在以相同账户与脚本重新提交。`);
    setRetryingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      const response = await retryJob(job.job_id);
      const nextJobs = await listJobs();
      setJobs(nextJobs.jobs);
      const nextSelected = nextJobs.jobs.find((item) => item.job_id === response.job.job_id) ?? null;
      if (nextSelected) {
        setSelectedJob(nextSelected);
      }
    } finally {
      setRetryingJobIds((current) => current.filter((item) => item !== job.job_id));
      finishPendingRequest(pendingId);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__title">
          <h1>Exp-Queue-Manager</h1>
          <p>远程实验队列管理</p>
        </div>
        <div className="topbar__status">
          <span className="pulse-dot" />
          <p>{banner}</p>
        </div>
      </header>

      <nav className="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "tab-button active" : "tab-button"}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "config" ? (
        <ConfigurationPage
          config={config}
          onConfigChange={setConfig}
          onOperationStart={beginPendingRequest}
          onOperationEnd={finishPendingRequest}
        />
      ) : null}
      {activeTab === "experiments" ? (
        <ExperimentsPage
          config={config}
          experiments={experimentCache}
          onExperimentsChange={setExperimentCache}
          onOperationStart={beginPendingRequest}
          onOperationEnd={finishPendingRequest}
        />
      ) : null}
      {activeTab === "jobs" ? (
        <JobsPage
          jobs={jobs}
          selectedJob={selectedJob}
          selectedJobCache={selectedJob ? (jobLogCache[selectedJob.job_id] ?? null) : null}
          onSelectJob={setSelectedJob}
          onUpdateJobCache={updateJobLogCache}
          onRefresh={handleRefreshJobs}
          onClear={handleClearJobs}
          onSync={handleSync}
          onCancel={handleCancel}
          onRetry={handleRetry}
          isRefreshing={isRefreshingJobs}
          isClearing={isClearingJobs}
          syncingJobIds={syncingJobIds}
          cancellingJobIds={cancellingJobIds}
          retryingJobIds={retryingJobIds}
        />
      ) : null}
      <OperationConsole
        entries={commandLogs}
        activeOperationCount={activeOperationIds.length}
        pendingRequests={pendingRequests}
        onClear={() => setCommandLogs([])}
      />
    </div>
  );
}
