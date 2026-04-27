import { useEffect, useState } from "react";

import { getConfig, listJobs, refreshJobs, syncJob } from "./api";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { ExperimentsPage } from "./pages/ExperimentsPage";
import { JobsPage } from "./pages/JobsPage";
import type { AppConfig, JobRecord, StatusEvent } from "./types";

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
  const [banner, setBanner] = useState<string>("No active status stream yet.");

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
      setBanner("Live status stream connected.");
      socket.send("subscribe");
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as StatusEvent;
      if (message.type === "jobs_refreshed") {
        const nextJobs = (message.payload.jobs as JobRecord[]) ?? [];
        setJobs(nextJobs);
        setBanner(`Live update received: ${nextJobs.length} tracked jobs.`);
      }
      if (message.type === "error") {
        setBanner(`Background refresh error: ${String(message.payload.message ?? "unknown error")}`);
      }
    });
    socket.addEventListener("close", () => setBanner("Status stream disconnected."));
    return () => socket.close();
  }, []);

  const tabs = [
    { id: "config" as const, label: "Config" },
    { id: "experiments" as const, label: "Experiments" },
    { id: "jobs" as const, label: "Jobs" },
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

  return (
    <div className="app-shell">
      <div className="hero">
        <div>
          <p className="eyebrow">Remote Experiment Orchestration</p>
          <h1>Exp-Queue-Manager</h1>
          <p className="hero-copy">
            Manage Slurm experiment queues, sync code across accounts, inspect logs, and pull training outputs back to the main account.
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
        />
      ) : null}
    </div>
  );
}
