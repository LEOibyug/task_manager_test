import { useEffect, useMemo, useRef, useState } from "react";

import { getJobLog } from "../api";
import type { EvalLogResponse, JobLogCacheEntry, JobRecord, LogResponse } from "../types";
import { SectionCard } from "./SectionCard";
import { renderTerminalText } from "../utils/terminal";
import { dedupeEvalCardsByContent, parseEvalLogEntries } from "../utils/evalMetrics";
import { extractProgressFromLog } from "../utils/logProgress";
import { getJobChainMembers } from "../utils/jobChain";
import { getChainEvalLogs, type ChainEvalLogItem } from "../utils/evalLogCache";

const TRACKABLE_JOB_STATUSES = new Set(["RUNNING", "PENDING"]);
const LOG_POLL_INTERVAL_MS = 1500;
const EVAL_POLL_INTERVAL_MS = 8000;
const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");

function formatEvalMetricKey(key: string): string {
  return key.replace(/^ads\//, "");
}

function parseEvalMetricNumber(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  const match = normalized.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMeanDelta(currentValue: string, previousValue: string | undefined): string | null {
  if (previousValue === undefined) {
    return null;
  }
  const current = parseEvalMetricNumber(currentValue);
  const previous = parseEvalMetricNumber(previousValue);
  if (current === null || previous === null) {
    return null;
  }
  const delta = current - previous;
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 4,
  }).format(Math.abs(delta));
  if (delta > 0) {
    return `+${formatted}`;
  }
  if (delta < 0) {
    return `-${formatted}`;
  }
  return "0";
}

export function LogViewer({
  job,
  jobs,
  cacheEntry,
  onCacheUpdate,
}: {
  job: JobRecord | null;
  jobs: JobRecord[];
  cacheEntry: JobLogCacheEntry | null;
  onCacheUpdate: (jobId: string, patch: Partial<JobLogCacheEntry>) => void;
}) {
  const [log, setLog] = useState<LogResponse | null>(null);
  const [evalLog, setEvalLog] = useState<EvalLogResponse | null>(null);
  const [chainEvalLogs, setChainEvalLogs] = useState<ChainEvalLogItem[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTracking, setIsTracking] = useState(true);
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const viewerRef = useRef<HTMLPreElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const requestControllerRef = useRef<AbortController | null>(null);
  const evalRequestControllerRef = useRef<AbortController | null>(null);
  const isRequestInFlightRef = useRef(false);
  const isEvalRequestInFlightRef = useRef(false);
  const appliedLogCacheAtRef = useRef(0);
  const appliedEvalCacheAtRef = useRef(0);
  const isTrackable = job ? TRACKABLE_JOB_STATUSES.has(job.status) : false;
  const activeJobId = job?.job_id ?? null;
  const isPreviewLog = log?.view === "preview";
  const evalJobs = useMemo(() => {
    if (!job) {
      return [];
    }
    const chainMembers = getJobChainMembers(jobs, job).reverse();
    return chainMembers.length > 0 ? chainMembers : [job];
  }, [jobs, job]);
  const evalJobIds = useMemo(() => evalJobs.map((item) => item.job_id).join("|"), [evalJobs]);

  useEffect(() => {
    requestControllerRef.current?.abort();
    evalRequestControllerRef.current?.abort();
    requestControllerRef.current = null;
    evalRequestControllerRef.current = null;
    isRequestInFlightRef.current = false;
    isEvalRequestInFlightRef.current = false;
    if (!job) {
      setLog(null);
      setEvalLog(null);
      setChainEvalLogs([]);
      setError(null);
      setEvalError(null);
      appliedLogCacheAtRef.current = 0;
      appliedEvalCacheAtRef.current = 0;
      return;
    }
    setIsTracking(true);
    setIsLogExpanded(false);
    setLog(cacheEntry?.log ?? null);
    setEvalLog(cacheEntry?.eval_log ?? null);
    setChainEvalLogs([]);
    appliedLogCacheAtRef.current = cacheEntry?.log_updated_at ?? 0;
    appliedEvalCacheAtRef.current = cacheEntry?.eval_updated_at ?? 0;
    if (!cacheEntry?.log) {
      void refreshLog(true, true, "preview");
    }
    if (evalJobs.length > 1 || !cacheEntry?.eval_log) {
      void refreshEvalLog(true);
    }
    return () => {
      requestControllerRef.current?.abort();
      evalRequestControllerRef.current?.abort();
      requestControllerRef.current = null;
      evalRequestControllerRef.current = null;
      isRequestInFlightRef.current = false;
      isEvalRequestInFlightRef.current = false;
    };
  }, [activeJobId, evalJobIds]);

  useEffect(() => {
    if (!cacheEntry || cacheEntry.job_id !== activeJobId) {
      return;
    }
    if (!isLogExpanded && !search.trim() && cacheEntry.log && cacheEntry.log_updated_at >= appliedLogCacheAtRef.current) {
      setLog(cacheEntry.log);
      appliedLogCacheAtRef.current = cacheEntry.log_updated_at;
    }
    if (evalJobs.length === 1 && cacheEntry.eval_log && cacheEntry.eval_updated_at >= appliedEvalCacheAtRef.current) {
      setEvalLog(cacheEntry.eval_log);
      appliedEvalCacheAtRef.current = cacheEntry.eval_updated_at;
    }
  }, [cacheEntry, activeJobId, isLogExpanded, search, evalJobs.length]);

  useEffect(() => {
    if (!job || !isTrackable || !isTracking || search.trim()) {
      return;
    }
    if (!isLogExpanded && cacheEntry?.log) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshLog(true, true, isLogExpanded ? "full" : "preview");
    }, LOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeJobId, isTrackable, isTracking, search, isLogExpanded, cacheEntry]);

  useEffect(() => {
    if (!job || !isTrackable || !isTracking) {
      return;
    }
    if (evalJobs.length === 1 && cacheEntry?.eval_log) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshEvalLog(true);
    }, EVAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeJobId, evalJobIds, isTrackable, isTracking, cacheEntry, evalJobs.length]);

  useEffect(() => {
    if (!isTracking || !viewerRef.current || !shouldAutoScrollRef.current) {
      return;
    }
    viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [log, isTracking]);

  const renderedContent = useMemo(() => {
    return renderTerminalText(log?.content ?? "请选择一个任务以查看对应的 sbatch 日志。");
  }, [log]);

  const progressItems = useMemo(() => extractProgressFromLog(renderedContent), [renderedContent]);
  const evalCards = useMemo(() => {
    if (chainEvalLogs.length > 0) {
      return dedupeEvalCardsByContent(
        chainEvalLogs.flatMap((item) =>
          parseEvalLogEntries(item.response.entries, {
            trainingIndex: item.trainingIndex,
            trainingTotal: item.trainingTotal,
            idPrefix: item.jobId,
          }),
        ),
      );
    }
    return dedupeEvalCardsByContent(
      parseEvalLogEntries(evalLog?.entries ?? [], {
        idPrefix: activeJobId ?? undefined,
      }),
    );
  }, [activeJobId, chainEvalLogs, evalJobs.length, evalLog]);
  const hasProgress = progressItems.length > 0;
  const showFullLog = !hasProgress || isLogExpanded;

  async function refreshLog(tail: boolean, silent = false, preferredView?: "preview" | "full") {
    if (!job) {
      return;
    }
    if (isRequestInFlightRef.current) {
      return;
    }
    const controller = new AbortController();
    requestControllerRef.current = controller;
    isRequestInFlightRef.current = true;
    try {
      if (!silent) {
        setIsLoading(true);
      }
      const next = await getJobLog(job.job_id, {
        tail,
        offset: tail ? undefined : log?.next_offset ?? 0,
        search: search || undefined,
        signal: controller.signal,
        view: search.trim() ? "full" : (preferredView ?? (isLogExpanded ? "full" : "preview")),
      });
      if (controller.signal.aborted) {
        return;
      }
      setLog(next);
      if (next.view === "preview") {
        const updatedAt = Date.now();
        appliedLogCacheAtRef.current = updatedAt;
        onCacheUpdate(job.job_id, { log: next, log_updated_at: updatedAt });
      }
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      setError((err as Error).message);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      isRequestInFlightRef.current = false;
      if (!silent) {
        setIsLoading(false);
      }
    }
  }

  async function refreshEvalLog(silent = false, force = false) {
    if (!job || isEvalRequestInFlightRef.current) {
      return;
    }
    const controller = new AbortController();
    evalRequestControllerRef.current = controller;
    isEvalRequestInFlightRef.current = true;
    try {
      const nextChainEvalLogs = await getChainEvalLogs(evalJobs, {
        force,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      const trainingTotal = evalJobs.length;
      setChainEvalLogs(trainingTotal > 1 ? nextChainEvalLogs : []);
      const next = nextChainEvalLogs[nextChainEvalLogs.length - 1]?.response ?? null;
      setEvalLog(next);
      const updatedAt = Date.now();
      if (trainingTotal === 1 && next) {
        appliedEvalCacheAtRef.current = updatedAt;
        onCacheUpdate(job.job_id, { eval_log: next, eval_updated_at: updatedAt });
      }
      setEvalError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      if (!silent) {
        setEvalError((err as Error).message);
      }
    } finally {
      if (evalRequestControllerRef.current === controller) {
        evalRequestControllerRef.current = null;
      }
      isEvalRequestInFlightRef.current = false;
    }
  }

  function handleViewerScroll() {
    const element = viewerRef.current;
    if (!element) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    shouldAutoScrollRef.current = nearBottom;
  }

  async function handleToggleLogMode() {
    if (!job) {
      return;
    }
    if (isLogExpanded) {
      setIsLogExpanded(false);
      void refreshLog(true, true, "preview");
      return;
    }
    setIsLogExpanded(true);
    void refreshLog(true, false, "full");
  }

  return (
    <SectionCard
      title="训练日志"
      actions={
        <div className="log-toolbar">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索日志"
          />
          <div className="log-toolbar__buttons">
            <button
              className="ghost-button"
              onClick={() => {
                setIsLogExpanded(true);
                void refreshLog(false, false, "full");
              }}
              disabled={!job || isLoading}
            >
              查找
            </button>
            <button
              className="ghost-button"
              onClick={() => void refreshLog(true, false, isLogExpanded ? "full" : "preview")}
              disabled={!job || isLoading}
            >
              {isLoading ? "读取中" : isLogExpanded ? "刷新" : "预览"}
            </button>
            <button
              className={isTracking ? "ghost-button active-log-button" : "ghost-button"}
              onClick={() => setIsTracking((current) => !current)}
              disabled={!job || !isTrackable}
            >
              {isTracking ? "跟踪中" : "已暂停"}
            </button>
          </div>
        </div>
      }
    >
      {error ? <p className="error-text">{error}</p> : null}
      {evalError ? <p className="error-text">{evalError}</p> : null}
      {job ? (
        <div className="log-status-strip">
          <span className="log-status-pill">{isPreviewLog ? "快速预览" : "完整日志"}</span>
          {isTrackable ? <span className="log-status-pill">{isTracking ? "自动跟踪" : "手动刷新"}</span> : null}
          {evalCards.length > 0 ? <span className="log-status-pill">评估 {evalCards.length}</span> : null}
        </div>
      ) : null}
      {evalCards.length > 0 ? (
        <>
          <div className="log-collapse-toolbar">
            <strong className="log-section-label">评估</strong>
            <button className="ghost-button" onClick={() => void refreshEvalLog(false, true)} disabled={!job}>
              刷新
            </button>
          </div>
          <div className="eval-list" role="table" aria-label="评估结果列表">
            <div className="eval-list__row eval-list__row--header" role="row">
              <span role="columnheader">评估</span>
              <span role="columnheader">训练</span>
              <span role="columnheader">指标（ads/）</span>
            </div>
            {evalCards.map((card, index) => (
              <div key={card.id} className="eval-list__row" role="row" title={card.rawLine}>
                <strong role="cell">#{index + 1}</strong>
                <span role="cell">
                  {card.trainingIndex && card.trainingTotal ? `${card.trainingIndex}/${card.trainingTotal}` : "-"}
                </span>
                <div className="eval-list__metrics" role="cell">
                  {card.prefix ? <span className="eval-list__prefix">{card.prefix}</span> : null}
                  {card.metrics.map((metric) => {
                    const previousMeanValue = evalCards[index - 1]?.metrics.find((item) => item.key === "ads/mean")?.value;
                    const meanDelta = metric.key === "ads/mean" ? formatMeanDelta(metric.value, previousMeanValue) : null;
                    return (
                      <span
                        key={`${card.id}-${metric.key}`}
                        className={
                          metric.key === "ads/mean"
                            ? "eval-list__metric eval-list__metric--highlight"
                            : "eval-list__metric"
                        }
                      >
                        <span>{formatEvalMetricKey(metric.key)}</span>
                        <strong>{metric.value}</strong>
                        {meanDelta ? (
                          <em className={`eval-list__delta ${meanDelta.startsWith("+") ? "eval-list__delta--up" : meanDelta.startsWith("-") ? "eval-list__delta--down" : ""}`}>
                            {meanDelta}
                          </em>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {hasProgress ? (
        <div className="log-progress-grid">
          {progressItems.map((item) => (
            <article key={item.name} className="log-progress-card" title={item.rawLine}>
              <div className="log-progress-card__header">
                <strong>{item.name}</strong>
                <span>{item.percent}%</span>
              </div>
              <div className="log-progress-bar" aria-hidden="true">
                <div className="log-progress-bar__fill" style={{ width: `${item.percent}%` }} />
              </div>
              <div className="log-progress-card__numbers">
                <span>
                  {NUMBER_FORMATTER.format(item.current)} / {NUMBER_FORMATTER.format(item.total)}
                </span>
                {item.rate ? <span>{item.rate}</span> : null}
              </div>
              <div className="log-progress-meta">
                {item.elapsed ? <span>已用时 {item.elapsed}</span> : null}
                {item.remaining ? <span>预计剩余 {item.remaining}</span> : null}
                {item.metrics.map((metric) => (
                  <span key={metric}>{metric}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {job ? (
        <div className="log-collapse-toolbar">
          <button className="ghost-button" onClick={() => void handleToggleLogMode()} disabled={isLoading || !!search.trim()}>
            {isLogExpanded ? "切回预览" : "完整日志"}
          </button>
        </div>
      ) : null}
      {showFullLog ? (
        <pre ref={viewerRef} className="log-viewer" onScroll={handleViewerScroll}>
          {renderedContent}
        </pre>
      ) : (
        <div className="log-viewer log-viewer--collapsed-note">
          完整日志已折叠
        </div>
      )}
    </SectionCard>
  );
}
