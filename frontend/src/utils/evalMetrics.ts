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

const EVAL_PATTERN = /^(?<prefix>.*?)(?:\s+)?latest_eval=(?<metrics>.+)$/;

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
