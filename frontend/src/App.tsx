import { useEffect, useMemo, useRef, useState } from "react";

import {
  cancelJob,
  clearJobs,
  deleteJob,
  detachJobFromChain,
  getConfig,
  insertJobIntoChain,
  listJobs,
  proactiveRetryJob,
  refreshJobs,
  reorderJobChain,
  retryJob,
  setJobAutoRetry,
  syncJob,
} from "./api";
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
  JobState,
  LogResponse,
  StatusEvent,
} from "./types";
import type { ExperimentSummary } from "./types";
import { buildJobChainGroups, getJobChainId } from "./utils/jobChain";

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

function isTimeoutJob(job: JobRecord): boolean {
  return job.status === "TIMEOUT" || (job.last_error ?? "").toUpperCase().includes("TIMEOUT");
}

function statusForAutoRetry(job: JobRecord): JobState {
  return isTimeoutJob(job) ? "TIMEOUT" : job.status;
}

function createEmptyJobLogCacheEntry(jobId: string): JobLogCacheEntry {
  return {
    job_id: jobId,
    log: null,
    eval_log: null,
    log_updated_at: 0,
    eval_updated_at: 0,
  };
}

function getLatestContinuableJob(jobs: JobRecord[]): JobRecord {
  const fallback = jobs[0];
  if (!fallback) {
    throw new Error("空续训链");
  }
  return jobs.find((job) => job.status !== "CANCELLED") ?? fallback;
}

function rebuildChainLinks(jobMap: Map<string, JobRecord>, displayOrderedJobIds: string[]): void {
  const chronologicalJobIds = [...displayOrderedJobIds].reverse();
  const rootJobId = chronologicalJobIds[0];
  chronologicalJobIds.forEach((jobId, index) => {
    const job = jobMap.get(jobId);
    if (!job || !rootJobId) {
      return;
    }
    job.continuation_root_job_id = job.job_id === rootJobId ? null : rootJobId;
    job.continuation_order = index + 1;
    job.resumed_from_job_id = index > 0 ? chronologicalJobIds[index - 1] : null;
  });
}

function optimisticallyReorderChain(
  currentJobs: JobRecord[],
  targetChainId: string,
  displayOrderedJobIds: string[],
): JobRecord[] {
  const movingJobIds = new Set(displayOrderedJobIds);
  const jobMap = new Map(currentJobs.map((job) => [job.job_id, { ...job }]));
  const originalChainIds = new Set(
    displayOrderedJobIds
      .map((jobId) => {
        const job = currentJobs.find((item) => item.job_id === jobId);
        return job ? getJobChainId(job) : null;
      })
      .filter((chainId): chainId is string => Boolean(chainId)),
  );
  const groups = buildJobChainGroups(currentJobs);
  const targetGroup = groups.find((group) => group.chainId === targetChainId);
  const omittedTargetJobIds = (targetGroup?.jobs ?? [])
    .map((job) => job.job_id)
    .filter((jobId) => !movingJobIds.has(jobId));

  rebuildChainLinks(jobMap, [...displayOrderedJobIds, ...omittedTargetJobIds]);

  for (const chainId of originalChainIds) {
    if (chainId === targetChainId) {
      continue;
    }
    const sourceGroup = groups.find((group) => group.chainId === chainId);
    const remainingJobIds = (sourceGroup?.jobs ?? [])
      .map((job) => job.job_id)
      .filter((jobId) => !movingJobIds.has(jobId));
    rebuildChainLinks(jobMap, remainingJobIds);
  }

  return currentJobs.map((job) => jobMap.get(job.job_id) ?? job);
}

function optimisticallyDetachJob(currentJobs: JobRecord[], jobId: string): JobRecord[] {
  const sourceJob = currentJobs.find((job) => job.job_id === jobId);
  if (!sourceJob) {
    return currentJobs;
  }
  const sourceChainId = getJobChainId(sourceJob);
  const sourceGroup = buildJobChainGroups(currentJobs).find((group) => group.chainId === sourceChainId);
  const jobMap = new Map(currentJobs.map((job) => [job.job_id, { ...job }]));
  const detached = jobMap.get(jobId);
  if (detached) {
    detached.continuation_root_job_id = null;
    detached.resumed_from_job_id = null;
    detached.continuation_order = null;
  }
  const remainingJobIds = (sourceGroup?.jobs ?? [])
    .map((job) => job.job_id)
    .filter((item) => item !== jobId);
  rebuildChainLinks(jobMap, remainingJobIds);
  return currentJobs.map((job) => jobMap.get(job.job_id) ?? job);
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("jobs");
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
  const [proactiveRetryingJobIds, setProactiveRetryingJobIds] = useState<string[]>([]);
  const [chainInsertingJobIds, setChainInsertingJobIds] = useState<string[]>([]);
  const [deletingJobIds, setDeletingJobIds] = useState<string[]>([]);
  const [updatingAutoRetryJobIds, setUpdatingAutoRetryJobIds] = useState<string[]>([]);
  const [jobLogCache, setJobLogCache] = useState<Record<string, JobLogCacheEntry>>({});
  const autoRetryAttemptedJobIds = useRef<Set<string>>(new Set());
  const previousJobStatusesRef = useRef<Record<string, JobState>>({});

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
    const previousStatuses = previousJobStatusesRef.current;
    const nextStatuses = Object.fromEntries(jobs.map((job) => [job.job_id, statusForAutoRetry(job)])) as Record<
      string,
      JobState
    >;
    previousJobStatusesRef.current = nextStatuses;

    for (const group of buildJobChainGroups(jobs)) {
      const latestJob = group.summaryJob;
      const previousStatus = previousStatuses[latestJob.job_id];
      const currentStatus = statusForAutoRetry(latestJob);
      if (previousStatus !== "RUNNING" || currentStatus !== "TIMEOUT") {
        continue;
      }
      if (!latestJob.auto_retry_enabled) {
        continue;
      }
      if (updatingAutoRetryJobIds.includes(latestJob.job_id)) {
        continue;
      }
      if (retryingJobIds.includes(latestJob.job_id) || autoRetryAttemptedJobIds.current.has(latestJob.job_id)) {
        continue;
      }
      autoRetryAttemptedJobIds.current.add(latestJob.job_id);
      void handleRetry(latestJob, { automatic: true });
    }
  }, [jobs, retryingJobIds, updatingAutoRetryJobIds]);

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
      const nextEntry: JobLogCacheEntry = current[jobId] ? { ...current[jobId] } : createEmptyJobLogCacheEntry(jobId);
      Object.assign(nextEntry, patch);
      nextEntry.job_id = jobId;
      return {
        ...current,
        [jobId]: nextEntry,
      };
    });
  }

  function handleConfigChange(nextConfig: AppConfig) {
    setConfig(nextConfig);
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
    { id: "jobs" as const, label: "任务", badge: jobs.length > 0 ? String(jobs.length) : null },
    { id: "experiments" as const, label: "实验", badge: experimentCache ? String(experimentCache.length) : null },
    { id: "config" as const, label: "配置", badge: null },
  ], [experimentCache, jobs.length]);

  function beginPendingRequest(label: string, detail: string): string {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setPendingRequests((current) => [...current, { id, label, detail }]);
    setBanner(`${label}已发起，等待后端返回实时反馈。`);
    return id;
  }

  function finishPendingRequest(id: string): void {
    setPendingRequests((current) => current.filter((item) => item.id !== id));
  }

  async function withPendingRequest<T>(label: string, detail: string, action: () => Promise<T>): Promise<T> {
    const pendingId = beginPendingRequest(label, detail);
    try {
      return await action();
    } finally {
      finishPendingRequest(pendingId);
    }
  }

  async function handleRefreshJobs() {
    setIsRefreshingJobs(true);
    try {
      await withPendingRequest("刷新任务", "已向后端发出刷新请求，等待远端任务扫描输出。", async () => {
        const response = await refreshJobs();
        setJobs(response.jobs);
      });
    } finally {
      setIsRefreshingJobs(false);
    }
  }

  async function handleSync(job: JobRecord) {
    setSyncingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await withPendingRequest("同步结果", `任务 ${job.job_id} 正在发起从 ${job.account} 到主账户的同步。`, async () => {
        await syncJob(job.job_id);
        const response = await listJobs();
        setJobs(response.jobs);
      });
    } finally {
      setSyncingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleCancel(job: JobRecord) {
    setCancellingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await withPendingRequest("取消任务", `任务 ${job.job_id} 正在请求取消，请等待 scancel 输出。`, async () => {
        await cancelJob(job.job_id);
        const response = await listJobs();
        setJobs(response.jobs);
      });
    } finally {
      setCancellingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleClearJobs() {
    setIsClearingJobs(true);
    try {
      await withPendingRequest("清空任务", "正在清空本地任务记录列表。", async () => {
        const response = await clearJobs();
        setJobs(response.jobs);
        setSelectedJob(null);
      });
    } finally {
      setIsClearingJobs(false);
    }
  }

  async function handleDeleteJob(job: JobRecord) {
    const confirmed = window.confirm(
      `确定删除任务 ${job.job_id} 的本地记录吗？\n\n这只会从任务列表移除该条目，不会取消或删除远端 Slurm 任务与输出文件。`,
    );
    if (!confirmed) {
      return;
    }
    setDeletingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await withPendingRequest("删除任务", `正在删除任务 ${job.job_id} 的本地记录。`, async () => {
        const response = await deleteJob(job.job_id);
        setJobs(response.jobs);
        if (selectedJob?.job_id === job.job_id) {
          setSelectedJob(null);
        }
      });
    } catch (error) {
      setBanner(`删除任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleRetry(job: JobRecord, options: { automatic?: boolean } = {}) {
    setRetryingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      const label = options.automatic ? "自动续训" : "续训任务";
      await withPendingRequest(label, `任务 ${job.job_id} 已超时，正在以相同账户与脚本重新提交。`, async () => {
        const response = await retryJob(job.job_id);
        const nextJobs = await listJobs();
        setJobs(nextJobs.jobs);
        const nextSelected = nextJobs.jobs.find((item) => item.job_id === response.job.job_id) ?? null;
        if (nextSelected) {
          setSelectedJob(nextSelected);
        }
      });
    } catch (error) {
      setBanner(`${options.automatic ? "自动续训" : "续训"}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRetryingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleProactiveRetry(job: JobRecord) {
    const confirmed = window.confirm(
      `确定对运行中任务 ${job.job_id} 执行主动续训吗？\n\n这会先停止当前 Slurm 任务，将旧任务标记为主动超时，然后按续训链逻辑提交新的后继任务。`,
    );
    if (!confirmed) {
      return;
    }
    setProactiveRetryingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await withPendingRequest("主动续训", `任务 ${job.job_id} 正在主动停止，并将提交续训后继任务。`, async () => {
        const response = await proactiveRetryJob(job.job_id);
        const nextJobs = await listJobs();
        setJobs(nextJobs.jobs);
        const nextSelected = nextJobs.jobs.find((item) => item.job_id === response.job.job_id) ?? null;
        if (nextSelected) {
          setSelectedJob(nextSelected);
        }
      });
    } catch (error) {
      setBanner(`主动续训失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProactiveRetryingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleInsertIntoChain(job: JobRecord) {
    const sourceChainId = getJobChainId(job);
    const targetGroups = buildJobChainGroups(jobs).filter((group) => group.chainId !== sourceChainId);
    if (targetGroups.length === 0) {
      setBanner("当前没有可插入的其它续训链或任务。");
      return;
    }
    const optionLines = targetGroups.map((group, index) => {
      const anchor = getLatestContinuableJob(group.jobs);
      const chainLabel = group.isChain ? `续训链 ${group.chainId}` : `单任务 ${group.chainId}`;
      return `${index + 1}. ${chainLabel} · 插入到 ${anchor.job_id} 后 · ${anchor.experiment}`;
    });
    const answer = window.prompt(
      [
        `将任务 ${job.job_id} 插入哪条续训链？`,
        "可输入序号，或直接输入目标链中的任意任务 ID。",
        "",
        ...optionLines,
      ].join("\n"),
    );
    if (!answer) {
      return;
    }
    const trimmedAnswer = answer.trim();
    const selectedIndex = Number.parseInt(trimmedAnswer, 10);
    const selectedGroup =
      String(selectedIndex) === trimmedAnswer && selectedIndex >= 1 && selectedIndex <= targetGroups.length
        ? targetGroups[selectedIndex - 1]
        : null;
    const targetJobId = selectedGroup ? getLatestContinuableJob(selectedGroup.jobs).job_id : trimmedAnswer;
    if (targetJobId === job.job_id) {
      setBanner("不能将任务插入到自身所在链条。");
      return;
    }

    const confirmed = window.confirm(
      `确定将任务 ${job.job_id} 插入到任务 ${targetJobId} 所在续训链吗？\n\n如果该任务本身已有后继续训任务，会一并移动到目标链，方便合并查看评估数据。`,
    );
    if (!confirmed) {
      return;
    }

    setChainInsertingJobIds((current) => Array.from(new Set([...current, job.job_id])));
    try {
      await withPendingRequest("插入续训链", `正在将任务 ${job.job_id} 插入任务 ${targetJobId} 所在续训链。`, async () => {
        const response = await insertJobIntoChain(job.job_id, targetJobId);
        setJobs(response.jobs);
        const nextSelected = response.jobs.find((item) => item.job_id === job.job_id) ?? null;
        if (nextSelected) {
          setSelectedJob(nextSelected);
        }
      });
      setBanner(`任务 ${job.job_id} 已插入目标续训链。`);
    } catch (error) {
      setBanner(`插入续训链失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setChainInsertingJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  async function handleReorderChain(targetChainId: string, displayOrderedJobIds: string[]) {
    if (displayOrderedJobIds.length === 0) {
      return;
    }
    const previousJobs = jobs;
    const optimisticJobs = optimisticallyReorderChain(previousJobs, targetChainId, displayOrderedJobIds);
    setJobs(optimisticJobs);
    setSelectedJob((current) =>
      current ? optimisticJobs.find((job) => job.job_id === current.job_id) ?? current : current,
    );
    try {
      await withPendingRequest("调整续训链", `正在更新续训链 ${targetChainId} 的任务顺序。`, async () => {
        await reorderJobChain(targetChainId, displayOrderedJobIds);
      });
      setBanner(`续训链 ${targetChainId} 的顺序已更新。`);
    } catch (error) {
      setJobs(previousJobs);
      setSelectedJob((current) =>
        current ? previousJobs.find((job) => job.job_id === current.job_id) ?? current : current,
      );
      setBanner(`调整续训链失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleDetachFromChain(job: JobRecord) {
    const previousJobs = jobs;
    const optimisticJobs = optimisticallyDetachJob(previousJobs, job.job_id);
    setJobs(optimisticJobs);
    const optimisticSelected = optimisticJobs.find((item) => item.job_id === job.job_id) ?? null;
    if (optimisticSelected) {
      setSelectedJob(optimisticSelected);
    }
    try {
      await withPendingRequest("移出续训链", `正在将任务 ${job.job_id} 移出当前续训链。`, async () => {
        await detachJobFromChain(job.job_id);
      });
      setBanner(`任务 ${job.job_id} 已移出续训链。`);
    } catch (error) {
      setJobs(previousJobs);
      const previousSelected = previousJobs.find((item) => item.job_id === job.job_id) ?? null;
      if (previousSelected) {
        setSelectedJob(previousSelected);
      }
      setBanner(`移出续训链失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleJobAutoRetryChange(job: JobRecord, enabled: boolean) {
    setUpdatingAutoRetryJobIds((current) => Array.from(new Set([...current, job.job_id])));
    const previousJobs = jobs;
    setJobs((current) =>
      current.map((item) => (item.job_id === job.job_id ? { ...item, auto_retry_enabled: enabled } : item)),
    );
    try {
      const response = await setJobAutoRetry(job.job_id, enabled);
      if (enabled) {
        autoRetryAttemptedJobIds.current.delete(job.job_id);
      }
      setJobs(response.jobs);
      setBanner(`任务 ${job.job_id} 的自动续训已${enabled ? "开启" : "关闭"}。`);
    } catch (error) {
      setJobs(previousJobs);
      setBanner(`保存自动续训配置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUpdatingAutoRetryJobIds((current) => current.filter((item) => item !== job.job_id));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__main">
          <div className="topbar__title">
            <h1>Exp Queue</h1>
            <p>远程实验队列管理</p>
          </div>
          <nav className="tab-bar" aria-label="主导航">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={activeTab === tab.id ? "tab-button active" : "tab-button"}
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.label}</span>
                {tab.badge ? <em>{tab.badge}</em> : null}
              </button>
            ))}
          </nav>
        </div>
        <div className="topbar__status">
          <span className="pulse-dot" />
          <p>{banner}</p>
        </div>
      </header>

      <main className="page-content">
        {activeTab === "config" ? (
          <ConfigurationPage
            config={config}
            onConfigChange={handleConfigChange}
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
            mainUsername={config.main_username}
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
            onProactiveRetry={handleProactiveRetry}
            onInsertIntoChain={handleInsertIntoChain}
            onReorderChain={handleReorderChain}
            onDetachFromChain={handleDetachFromChain}
            onDelete={handleDeleteJob}
            onAutoRetryChange={handleJobAutoRetryChange}
            isRefreshing={isRefreshingJobs}
            isClearing={isClearingJobs}
            syncingJobIds={syncingJobIds}
            cancellingJobIds={cancellingJobIds}
            retryingJobIds={retryingJobIds}
            proactiveRetryingJobIds={proactiveRetryingJobIds}
            chainInsertingJobIds={chainInsertingJobIds}
            deletingJobIds={deletingJobIds}
            updatingAutoRetryJobIds={updatingAutoRetryJobIds}
          />
        ) : null}
      </main>
      <OperationConsole
        entries={commandLogs}
        activeOperationCount={activeOperationIds.length}
        pendingRequests={pendingRequests}
        onClear={() => setCommandLogs([])}
      />
    </div>
  );
}
