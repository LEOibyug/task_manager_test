import { useEffect, useMemo, useRef, useState } from "react";

import { getJobLog } from "../api";
import type { JobRecord, LogResponse } from "../types";
import { SectionCard } from "./SectionCard";
import { renderTerminalText } from "../utils/terminal";

const TRACKABLE_JOB_STATUSES = new Set(["RUNNING", "PENDING"]);
const LOG_POLL_INTERVAL_MS = 1500;

export function LogViewer({ job }: { job: JobRecord | null }) {
  const [log, setLog] = useState<LogResponse | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTracking, setIsTracking] = useState(true);
  const viewerRef = useRef<HTMLPreElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isTrackable = job ? TRACKABLE_JOB_STATUSES.has(job.status) : false;

  useEffect(() => {
    if (!job) {
      setLog(null);
      setError(null);
      return;
    }
    setIsTracking(true);
    void refreshLog(true, true);
  }, [job]);

  useEffect(() => {
    if (!job || !isTrackable || !isTracking || search.trim()) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshLog(true, true);
    }, LOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job, isTrackable, isTracking, search]);

  useEffect(() => {
    if (!isTracking || !viewerRef.current || !shouldAutoScrollRef.current) {
      return;
    }
    viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [log, isTracking]);

  const renderedContent = useMemo(() => {
    return renderTerminalText(log?.content ?? "请选择一个任务以查看对应的 sbatch 日志。");
  }, [log]);

  async function refreshLog(tail: boolean, silent = false) {
    if (!job) {
      return;
    }
    try {
      if (!silent) {
        setIsLoading(true);
      }
      const next = await getJobLog(job.job_id, {
        tail,
        offset: tail ? undefined : log?.next_offset ?? 0,
        search: search || undefined,
      });
      setLog(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
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

  return (
    <SectionCard
      title="Sbatch 日志"
      actions={
        <div className="inline-controls">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索关键字"
          />
          <button className="ghost-button" onClick={() => void refreshLog(false)} disabled={!job || isLoading}>
            搜索
          </button>
          <button className="ghost-button" onClick={() => void refreshLog(true)} disabled={!job || isLoading}>
            {isLoading ? "读取中..." : "跳到末尾"}
          </button>
          <button
            className={isTracking ? "ghost-button active-log-button" : "ghost-button"}
            onClick={() => setIsTracking((current) => !current)}
            disabled={!job || !isTrackable}
          >
            {isTracking ? "停止跟踪" : "开始跟踪"}
          </button>
        </div>
      }
    >
      {error ? <p className="error-text">{error}</p> : null}
      {job && isTrackable ? (
        <p className="helper-text">
          {isTracking ? "正在持续跟踪日志尾部，运行中的进度条会按终端覆盖效果展示。" : "已暂停自动跟踪，可手动刷新。"}
        </p>
      ) : null}
      <pre ref={viewerRef} className="log-viewer" onScroll={handleViewerScroll}>
        {renderedContent}
      </pre>
    </SectionCard>
  );
}
