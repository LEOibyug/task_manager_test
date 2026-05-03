import type { JobState } from "../types";

export function StatusBadge({ status }: { status: JobState }) {
  const labelMap: Record<JobState, string> = {
    RUNNING: "运行中",
    PENDING: "排队中",
    COMPLETED: "已完成",
    FAILED: "失败",
    TIMEOUT: "超时",
    CANCELLED: "已取消",
    UNKNOWN: "未知",
  };
  return <span className={`status-badge status-badge--${status.toLowerCase()}`}>{labelMap[status]}</span>;
}
