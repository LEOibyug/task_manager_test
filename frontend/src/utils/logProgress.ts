export interface LogProgressItem {
  name: string;
  percent: number;
  current: number;
  total: number;
  elapsed: string | null;
  remaining: string | null;
  rate: string | null;
  metrics: string[];
  rawLine: string;
}

const TQDM_PROGRESS_PATTERN =
  /^(?<name>[^:\n][^:]*)\s*:\s*(?<percent>\d{1,3})%\|(?<bar>[^|]*)\|\s*(?<current>\d+)\/(?<total>\d+)\s*\[(?<details>[^\]]*)\]\s*$/;

export function extractProgressFromLog(renderedLog: string): LogProgressItem[] {
  const latestByName = new Map<string, LogProgressItem>();

  for (const line of renderedLog.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const matched = trimmed.match(TQDM_PROGRESS_PATTERN);
    if (!matched?.groups) {
      continue;
    }

    const percent = Number.parseInt(matched.groups.percent, 10);
    const current = Number.parseInt(matched.groups.current, 10);
    const total = Number.parseInt(matched.groups.total, 10);
    if (!Number.isFinite(percent) || !Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
      continue;
    }

    const detailParts = matched.groups.details
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    let elapsed: string | null = null;
    let remaining: string | null = null;
    let rate: string | null = null;
    const metrics: string[] = [];

    if (detailParts.length > 0) {
      const [firstPart, ...restParts] = detailParts;
      if (firstPart.includes("<")) {
        const [elapsedPart, remainingPart] = firstPart.split("<", 2).map((part) => part.trim());
        elapsed = elapsedPart || null;
        remaining = remainingPart || null;
      } else {
        metrics.push(firstPart);
      }

      if (restParts.length > 0) {
        rate = restParts[0] || null;
        metrics.push(...restParts.slice(1));
      }
    }

    const item: LogProgressItem = {
      name: matched.groups.name.trim(),
      percent: Math.max(0, Math.min(100, percent)),
      current,
      total,
      elapsed,
      remaining,
      rate,
      metrics,
      rawLine: trimmed,
    };

    if (latestByName.has(item.name)) {
      latestByName.delete(item.name);
    }
    latestByName.set(item.name, item);
  }

  return Array.from(latestByName.values());
}
