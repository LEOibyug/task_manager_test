import { useEffect, useState } from "react";

import { cancelJob, clearJobs, getConfig, listJobs, refreshJobs, syncJob } from "./api";
import { OperationConsole } from "./components/OperationConsole";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { ExperimentsPage } from "./pages/ExperimentsPage";
import { JobsPage } from "./pages/JobsPage";
import type { AppConfig, CommandLogEventPayload, JobRecord, StatusEvent } from "./types";
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
      if (message.type === "error") {
        setBanner(`后台刷新出错：${String(message.payload.message ?? "未知错误")}`);
      }
    });
    socket.addEventListener("close", () => setBanner("实时状态流已断开。"));
    return () => socket.close();
  }, []);

  const tabs = [
    { id: "config" as const, label: "配置" },
    { id: "experiments" as const, label: "实验" },
    { id: "jobs" as const, label: "任务" },
  ];

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

  return (
    <div className="app-shell">
      <div className="hero">
        <div>
          <p className="eyebrow">远程实验编排</p>
          <h1>Exp-Queue-Manager</h1>
          <p className="hero-copy">
            统一管理 Slurm 实验队列、账户间代码同步、日志查看，以及从分账户回收训练产出到主账户。
          </p>
        </div>
        <div className="hero-status">
          <span className="pulse-dot" />
          <p>{banner}</p>
        </div>
      </div>

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
          onSelectJob={setSelectedJob}
          onRefresh={handleRefreshJobs}
          onClear={handleClearJobs}
          onSync={handleSync}
          onCancel={handleCancel}
          isRefreshing={isRefreshingJobs}
          isClearing={isClearingJobs}
          syncingJobIds={syncingJobIds}
          cancellingJobIds={cancellingJobIds}
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
