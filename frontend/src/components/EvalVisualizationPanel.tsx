import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";

import type { JobRecord } from "../types";
import {
  buildEvalMetricSeries,
  dedupeEvalCardsByContent,
  type EvalMetricChartPoint,
  type EvalMetricSeries,
  parseEvalLogEntries,
} from "../utils/evalMetrics";
import { getChainEvalLogs, type ChainEvalLogItem } from "../utils/evalLogCache";
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
const CHART_COLORS = ["#64f9a7", "#5da2ff", "#ffd37f", "#ff8fc7", "#bba7ff", "#72e6ff", "#ff9b72", "#c9f56a"];

interface ChartScale {
  min: number;
  max: number;
  ticks: number[];
}

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

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  if (residual > 5) {
    return 10 * magnitude;
  }
  if (residual > 2) {
    return 5 * magnitude;
  }
  if (residual > 1) {
    return 2 * magnitude;
  }
  return magnitude;
}

function buildChartScale(values: number[]): ChartScale {
  const rawMinValue = Math.min(...values);
  const rawMaxValue = Math.max(...values);
  let minValue = rawMinValue;
  let maxValue = rawMaxValue;
  if (minValue === maxValue) {
    const spread = Math.max(Math.abs(minValue) * 0.1, 1);
    minValue -= spread;
    maxValue += spread;
  } else {
    const spread = (maxValue - minValue) * 0.08;
    minValue -= spread;
    maxValue += spread;
  }
  const step = niceStep((maxValue - minValue) / 4);
  const min = Math.floor(minValue / step) * step;
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step * 0.5; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return {
    min,
    max: max === min ? min + step : max,
    ticks: ticks.reverse(),
  };
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

function CombinedEvalChart({ series, totalEvalCount }: { series: EvalMetricSeries[]; totalEvalCount: number }) {
  const [hoverEvalIndex, setHoverEvalIndex] = useState<number | null>(null);
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const scale = buildChartScale(values);
  const xTicks = Array.from({ length: totalEvalCount }, (_, index) => index + 1);
  const hoveredEntries =
    hoverEvalIndex === null
      ? []
      : series
          .map((item, index) => {
            const point = item.points.find((candidate) => candidate.evalIndex === hoverEvalIndex);
            return point
              ? {
                  key: item.key,
                  point,
                  color: CHART_COLORS[index % CHART_COLORS.length],
                }
              : null;
          })
          .filter(
            (item): item is { key: string; point: EvalMetricChartPoint; color: string } => item !== null,
          );

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
    if (totalEvalCount <= 1) {
      setHoverEvalIndex(1);
      return;
    }
    const start = CHART_PADDING.left;
    const end = CHART_WIDTH - CHART_PADDING.right;
    const boundedX = Math.min(end, Math.max(start, svgX));
    const ratio = (boundedX - start) / (end - start);
    setHoverEvalIndex(Math.round(ratio * (totalEvalCount - 1)) + 1);
  }

  return (
    <article className="eval-line-chart">
      <div className="eval-line-chart__header">
        <strong>全部评估指标</strong>
        <span>{totalEvalCount} 次评估 · {series.length} 个指标</span>
      </div>
      <div className="eval-line-chart__legend">
        {series.map((item, index) => (
          <span key={item.key}>
            <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            {item.key}
          </span>
        ))}
      </div>
      <div className="eval-line-chart__canvas">
        <svg
          className="eval-line-chart__svg"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverEvalIndex(null)}
        >
          <title>评估指标趋势</title>
          {scale.ticks.map((tick, index) => {
            const y = getPointY(tick, scale.min, scale.max);
            return (
              <g key={`combined-y-${index}`}>
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
              <g key={`combined-x-${tick}`}>
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
          {series.map((item, index) => {
            const color = CHART_COLORS[index % CHART_COLORS.length];
            return (
              <g key={item.key}>
                {item.points.length > 1 ? (
                  <path
                    className="eval-line-chart__line"
                    d={buildPath(item, totalEvalCount, scale.min, scale.max)}
                    style={{ stroke: color }}
                  />
                ) : null}
                {item.points.map((point) => {
                  const isActive = hoverEvalIndex === point.evalIndex;
                  return (
                    <circle
                      key={`${item.key}-${point.evalIndex}-${point.rawValue}`}
                      className={isActive ? "eval-line-chart__point eval-line-chart__point--active" : "eval-line-chart__point"}
                      cx={getPointX(point.evalIndex, totalEvalCount)}
                      cy={getPointY(point.value, scale.min, scale.max)}
                      r={isActive ? 5.6 : 3.6}
                      style={{ fill: color }}
                    />
                  );
                })}
              </g>
            );
          })}
          {hoverEvalIndex ? (
            <line
              className="eval-line-chart__hover-line"
              x1={getPointX(hoverEvalIndex, totalEvalCount)}
              x2={getPointX(hoverEvalIndex, totalEvalCount)}
              y1={CHART_PADDING.top}
              y2={CHART_HEIGHT - CHART_PADDING.bottom}
            />
          ) : null}
          <rect
            className="eval-line-chart__hover-catcher"
            x={CHART_PADDING.left}
            y={CHART_PADDING.top}
            width={CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right}
            height={CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom}
          />
        </svg>
        {hoverEvalIndex && hoveredEntries.length > 0 ? (
          <div className="eval-line-chart__tooltip">
            <strong>评估 #{hoverEvalIndex}</strong>
            {hoveredEntries.map((entry) => {
              const trainingLabel =
                entry.point.trainingIndex && entry.point.trainingTotal
                  ? `第 ${entry.point.trainingIndex}/${entry.point.trainingTotal} 次训练`
                  : null;
              return (
                <div key={`${entry.key}-${entry.point.rawValue}`} className="eval-line-chart__tooltip-row">
                  <span>
                    <i style={{ background: entry.color }} />
                    {entry.key}
                  </span>
                  <strong>{entry.point.rawValue}</strong>
                  {trainingLabel ? <em>{trainingLabel}</em> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function EvalVisualizationPanel({ job, jobs }: { job: JobRecord | null; jobs: JobRecord[] }) {
  const [responses, setResponses] = useState<ChainEvalLogItem[]>([]);
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

  async function refreshEvalCharts(signal?: AbortSignal, silent = false, force = false) {
    if (!job || evalJobs.length === 0) {
      setResponses([]);
      return;
    }
    try {
      if (!silent) {
        setIsLoading(true);
      }
      const nextResponses = await getChainEvalLogs(evalJobs, { force, signal });
      if (signal?.aborted) {
        return;
      }
      setResponses(nextResponses);
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
      void refreshEvalCharts(controller.signal, true, false);
    }, EVAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job?.job_id, evalJobIds, isTrackable]);

  return (
    <SectionCard
      title="评估可视化"
      actions={
        <button className="ghost-button" onClick={() => void refreshEvalCharts(undefined, false, true)} disabled={!job || isLoading}>
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
          <CombinedEvalChart series={series} totalEvalCount={evalCards.length} />
        </div>
      ) : (
        <p className="muted-text">{job ? "暂未发现 latest_eval= 评估结果。" : "选择任务后显示评估折线图。"}</p>
      )}
    </SectionCard>
  );
}
