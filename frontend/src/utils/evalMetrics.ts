import type { EvalLogEntry } from "../types";

export interface EvalMetric {
  key: string;
  value: string;
}

export interface EvalCardItem {
  id: string;
  lineNumber: number | null;
  rawLine: string;
  prefix: string | null;
  metrics: EvalMetric[];
  trainingIndex?: number;
  trainingTotal?: number;
}

export interface EvalMetricChartPoint {
  evalIndex: number;
  value: number;
  rawValue: string;
  label: string;
  trainingIndex?: number;
  trainingTotal?: number;
  lineNumber: number | null;
}

export interface EvalMetricSeries {
  key: string;
  points: EvalMetricChartPoint[];
}

const EVAL_PATTERN = /^(?<prefix>.*?)(?:\s+)?latest_eval=(?<metrics>.+)$/;
const FIRST_NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i;

export function parseEvalLogEntries(
  entries: EvalLogEntry[],
  options: { trainingIndex?: number; trainingTotal?: number; idPrefix?: string } = {},
): EvalCardItem[] {
  return entries
    .map((entry, index) => {
      const trimmed = entry.content.trim();
      const match = trimmed.match(EVAL_PATTERN);
      const metricsSource = match?.groups?.metrics ?? "";
      const metrics = metricsSource
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [key, ...valueParts] = part.split("=");
          return {
            key: key.trim(),
            value: valueParts.join("=").trim(),
          };
        })
        .filter((metric) => metric.key && metric.value);

      return {
        id: `${options.idPrefix ?? "eval"}-${entry.line_number ?? "no-line"}-${index}`,
        lineNumber: entry.line_number,
        rawLine: trimmed,
        prefix: match?.groups?.prefix?.trim() || null,
        metrics,
        trainingIndex: options.trainingIndex,
        trainingTotal: options.trainingTotal,
      };
    })
    .filter((item) => item.metrics.length > 0);
}

export function dedupeEvalCardsByContent(cards: EvalCardItem[]): EvalCardItem[] {
  const deduped = new Map<string, EvalCardItem>();
  for (const card of cards) {
    deduped.delete(card.rawLine);
    deduped.set(card.rawLine, card);
  }
  return Array.from(deduped.values());
}

function parseMetricValue(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  const match = normalized.match(FIRST_NUMBER_PATTERN);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildEvalMetricSeries(cards: EvalCardItem[]): EvalMetricSeries[] {
  const grouped = new Map<string, EvalMetricChartPoint[]>();
  cards.forEach((card, cardIndex) => {
    const evalIndex = cardIndex + 1;
    for (const metric of card.metrics) {
      const value = parseMetricValue(metric.value);
      if (value === null) {
        continue;
      }
      const points = grouped.get(metric.key) ?? [];
      points.push({
        evalIndex,
        value,
        rawValue: metric.value,
        label: `评估 #${evalIndex}`,
        trainingIndex: card.trainingIndex,
        trainingTotal: card.trainingTotal,
        lineNumber: card.lineNumber,
      });
      grouped.set(metric.key, points);
    }
  });

  return Array.from(grouped.entries())
    .map(([key, points]) => ({ key, points }))
    .filter((series) => series.points.length > 0);
}
