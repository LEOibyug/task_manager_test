import { useEffect, useState } from "react";

import { cancelJob, getConfig, listJobs, refreshJobs, syncJob } from "./api";
import { OperationConsole } from "./components/OperationConsole";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { ExperimentsPage } from "./pages/ExperimentsPage";
import { JobsPage } from "./pages/JobsPage";
import type { AppConfig, CommandLogEventPayload, JobRecord, StatusEvent } from "./types";

const emptyConfig: AppConfig = {
  server_ip: "",
  server_port: 22,
  main_username: "",
  sub_usernames: [],
  repo_paths: {},
  refresh_interval: 10,
};

type TabId = "config" | "experiments" | "jobs";

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("config");
  const [banner, setBanner] = useState<string>("尚未建立实时状态连接。");
  const [commandLogs, setCommandLogs] = useState<Array<{ payload: CommandLogEventPayload; timestamp: string }>>([]);

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
        setCommandLogs((current) => {
          const next = [
            ...current,
            {
              payload: message.payload as unknown as CommandLogEventPayload,
              timestamp: message.timestamp,
            },
          ];
          return next.slice(-300);
        });
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

  async function handleRefreshJobs() {
    const response = await refreshJobs();
    setJobs(response.jobs);
  }

  async function handleSync(job: JobRecord) {
    await syncJob(job.job_id);
    const response = await listJobs();
    setJobs(response.jobs);
  }

  async function handleCancel(job: JobRecord) {
    await cancelJob(job.job_id);
    const response = await listJobs();
    setJobs(response.jobs);
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

      {activeTab === "config" ? <ConfigurationPage config={config} onConfigChange={setConfig} /> : null}
      {activeTab === "experiments" ? <ExperimentsPage config={config} /> : null}
      {activeTab === "jobs" ? (
        <JobsPage
          jobs={jobs}
          selectedJob={selectedJob}
          onSelectJob={setSelectedJob}
          onRefresh={handleRefreshJobs}
          onSync={handleSync}
          onCancel={handleCancel}
        />
      ) : null}
      <OperationConsole entries={commandLogs} onClear={() => setCommandLogs([])} />
    </div>
  );
}
