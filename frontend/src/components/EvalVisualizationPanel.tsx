import { useEffect, useMemo, useState } from "react";

import { getJobEvalLinesBatch } from "../api";
import type { EvalLogResponse, JobRecord } from "../types";
import {
  buildEvalMetricSeries,
  dedupeEvalCardsByContent,
  type EvalMetricSeries,
  parseEvalLogEntries,
} from "../utils/evalMetrics";
import { getJobChainMembers } from "../utils/jobChain";
import { SectionCard } from "./SectionCard";

const TRACKABLE_JOB_STATUSES = new Set(["RUNNING", "PENDING"]);
const EVAL_POLL_INTERVAL_MS = 8000;
const CHART_WIDTH = 640;
const CHART_HEIGHT = 240;
const CHART_PADDING = {
  top: 34,
  right: 26,
  bottom: 38,
  left: 58,
};

function formatChartNumber(value: number): string {
  const absValue = Math.abs(value);
  if (absValue !== 0 && (absValue >= 10000 || absValue < 0.001)) {
    return value.toExponential(2);
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: absValue >= 100 ? 2 : 4,
  }).format(value);
}

function buildPath(series: EvalMetricSeries, totalEvalCount: number, minValue: number, maxValue: number): string {
  return series.points
    .map((point, index) => {
      const x = getPointX(point.evalIndex, totalEvalCount);
      const y = getPointY(point.value, minValue, maxValue);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function getPointX(evalIndex: number, totalEvalCount: number): number {
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  if (totalEvalCount <= 1) {
    return CHART_PADDING.left + innerWidth / 2;
  }
  return CHART_PADDING.left + ((evalIndex - 1) / (totalEvalCount - 1)) * innerWidth;
}

function getPointY(value: number, minValue: number, maxValue: number): number {
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  if (minValue === maxValue) {
    return CHART_PADDING.top + innerHeight / 2;
  }
  return CHART_PADDING.top + ((maxValue - value) / (maxValue - minValue)) * innerHeight;
}

function EvalLineChart({ series, totalEvalCount }: { series: EvalMetricSeries; totalEvalCount: number }) {
  const values = series.points.map((point) => point.value);
  const rawMinValue = Math.min(...values);
  const rawMaxValue = Math.max(...values);
  const valueRange = rawMaxValue - rawMinValue;
  const padding = valueRange === 0 ? Math.max(Math.abs(rawMaxValue) * 0.08, 1) : valueRange * 0.12;
  const minValue = rawMinValue - padding;
  const maxValue = rawMaxValue + padding;
  const path = buildPath(series, totalEvalCount, minValue, maxValue);
  const yTicks = [rawMaxValue, (rawMaxValue + rawMinValue) / 2, rawMinValue];
  const xTicks = Array.from({ length: totalEvalCount }, (_, index) => index + 1);

  return (
    <article className="eval-line-chart">
      <div className="eval-line-chart__header">
        <strong>{series.key}</strong>
        <span>{series.points.length} 个数据点</span>
      </div>
      <svg className="eval-line-chart__svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img">
        <title>{`${series.key} 评估趋势`}</title>
        {yTicks.map((tick, index) => {
          const y = getPointY(tick, minValue, maxValue);
          return (
            <g key={`${series.key}-y-${index}`}>
              <line
                className="eval-line-chart__grid"
                x1={CHART_PADDING.left}
                x2={CHART_WIDTH - CHART_PADDING.right}
                y1={y}
                y2={y}
              />
              <text className="eval-line-chart__axis-label" x={CHART_PADDING.left - 10} y={y + 4} textAnchor="end">
                {formatChartNumber(tick)}
              </text>
            </g>
          );
        })}
        {xTicks.map((tick) => {
          const x = getPointX(tick, totalEvalCount);
          return (
            <g key={`${series.key}-x-${tick}`}>
              <line
                className="eval-line-chart__tick"
                x1={x}
                x2={x}
                y1={CHART_HEIGHT - CHART_PADDING.bottom}
                y2={CHART_HEIGHT - CHART_PADDING.bottom + 5}
              />
              {totalEvalCount <= 12 || tick === 1 || tick === totalEvalCount ? (
                <text
                  className="eval-line-chart__axis-label"
                  x={x}
                  y={CHART_HEIGHT - CHART_PADDING.bottom + 22}
                  textAnchor="middle"
                >
                  #{tick}
                </text>
              ) : null}
            </g>
          );
        })}
        <line
          className="eval-line-chart__axis"
          x1={CHART_PADDING.left}
          x2={CHART_WIDTH - CHART_PADDING.right}
          y1={CHART_HEIGHT - CHART_PADDING.bottom}
          y2={CHART_HEIGHT - CHART_PADDING.bottom}
        />
        <line
          className="eval-line-chart__axis"
          x1={CHART_PADDING.left}
          x2={CHART_PADDING.left}
          y1={CHART_PADDING.top}
          y2={CHART_HEIGHT - CHART_PADDING.bottom}
        />
        {series.points.length > 1 ? <path className="eval-line-chart__line" d={path} /> : null}
        {series.points.map((point) => {
          const x = getPointX(point.evalIndex, totalEvalCount);
          const y = getPointY(point.value, minValue, maxValue);
          const trainingLabel =
            point.trainingIndex && point.trainingTotal ? `第 ${point.trainingIndex}/${point.trainingTotal} 次训练，` : "";
          const detail = `${trainingLabel}评估 #${point.evalIndex}${
            point.lineNumber ? `，日志 #${point.lineNumber}` : ""
          }：${point.rawValue}`;
          return (
            <g key={`${series.key}-${point.evalIndex}-${point.rawValue}`}>
              <title>{detail}</title>
              <text className="eval-line-chart__point-label" x={x} y={Math.max(12, y - 10)} textAnchor="middle">
                {formatChartNumber(point.value)}
              </text>
              <circle className="eval-line-chart__point" cx={x} cy={y} r="4.5" />
            </g>
          );
        })}
      </svg>
    </article>
  );
}

export function EvalVisualizationPanel({ job, jobs }: { job: JobRecord | null; jobs: JobRecord[] }) {
  const [responses, setResponses] = useState<
    Array<{ jobId: string; trainingIndex: number; trainingTotal: number; response: EvalLogResponse }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const isTrackable = job ? TRACKABLE_JOB_STATUSES.has(job.status) : false;
  const evalJobs = useMemo(() => {
    if (!job) {
      return [];
    }
    const chainMembers = getJobChainMembers(jobs, job).reverse();
    return chainMembers.length > 0 ? chainMembers : [job];
  }, [jobs, job]);
  const evalJobIds = useMemo(() => evalJobs.map((item) => item.job_id).join("|"), [evalJobs]);
  const evalCards = useMemo(() => {
    return dedupeEvalCardsByContent(
      responses.flatMap((item) =>
        parseEvalLogEntries(item.response.entries, {
          trainingIndex: item.trainingIndex,
          trainingTotal: item.trainingTotal,
          idPrefix: item.jobId,
        }),
      ),
    );
  }, [responses]);
  const series = useMemo(() => buildEvalMetricSeries(evalCards), [evalCards]);

  async function refreshEvalCharts(signal?: AbortSignal, silent = false) {
    if (!job || evalJobs.length === 0) {
      setResponses([]);
      return;
    }
    try {
      if (!silent) {
        setIsLoading(true);
      }
      const nextResponses = await getJobEvalLinesBatch(
        evalJobs.map((item) => item.job_id),
        {
          pattern: "latest_eval=",
          limit: 0,
          signal,
        },
      );
      if (signal?.aborted) {
        return;
      }
      const trainingTotal = evalJobs.length;
      setResponses(
        nextResponses.map((response, index) => ({
          jobId: evalJobs[index]?.job_id ?? response.job_id,
          trainingIndex: index + 1,
          trainingTotal,
          response,
        })),
      );
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      setError((err as Error).message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setResponses([]);
    setError(null);
    void refreshEvalCharts(controller.signal);
    return () => controller.abort();
  }, [job?.job_id, evalJobIds]);

  useEffect(() => {
    if (!job || !isTrackable) {
      return;
    }
    const timer = window.setInterval(() => {
      const controller = new AbortController();
      void refreshEvalCharts(controller.signal, true);
    }, EVAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job?.job_id, evalJobIds, isTrackable]);

  return (
    <SectionCard
      title="评估可视化"
      actions={
        <button className="ghost-button" onClick={() => void refreshEvalCharts()} disabled={!job || isLoading}>
          {isLoading ? "读取中" : "刷新"}
        </button>
      }
    >
      {error ? <p className="error-text">{error}</p> : null}
      {job ? (
        <div className="eval-visual-summary">
          <span>评估 {evalCards.length}</span>
          <span>指标 {series.length}</span>
          {evalJobs.length > 1 ? <span>续训链 {evalJobs.length} 次</span> : null}
        </div>
      ) : null}
      {series.length > 0 ? (
        <div className="eval-chart-grid">
          {series.map((item) => (
            <EvalLineChart key={item.key} series={item} totalEvalCount={evalCards.length} />
          ))}
        </div>
      ) : (
        <p className="muted-text">{job ? "暂未发现 latest_eval= 评估结果。" : "选择任务后显示评估折线图。"}</p>
      )}
    </SectionCard>
  );
}
