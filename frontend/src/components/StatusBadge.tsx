import type { JobState } from "../types";

export function StatusBadge({ status }: { status: JobState }) {
  return <span className={`status-badge status-badge--${status.toLowerCase()}`}>{status}</span>;
}

