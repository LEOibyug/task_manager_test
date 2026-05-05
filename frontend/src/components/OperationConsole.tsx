import { useMemo, useState } from "react";

import type { CommandLogEventPayload } from "../types";
import { SectionCard } from "./SectionCard";

interface OperationLogEntry {
  payload: CommandLogEventPayload;
  timestamp: string;
}

function formatAction(action: string): string {
  const mapping: Record<string, string> = {
    "connection-test": "连接测试",
    "job-submit": "任务提交",
    "job-retry": "续训任务",
    "job-proactive-retry": "主动续训",
    "job-cancel": "取消任务",
    "job-sync": "同步结果",
    "jobs-refresh": "刷新任务",
  };
  return mapping[action] ?? action;
}

function formatStage(stage: CommandLogEventPayload["stage"]): string {
  const mapping: Record<CommandLogEventPayload["stage"], string> = {
    operation_start: "开始",
    command_start: "命令",
    stdout: "输出",
    stderr: "错误",
    command_end: "结束",
    operation_end: "完成",
    operation_error: "失败",
  };
  return mapping[stage];
}

export function OperationConsole({
  entries,
  activeOperationCount,
  pendingRequests,
  onClear,
}: {
  entries: OperationLogEntry[];
  activeOperationCount: number;
  pendingRequests: Array<{ id: string; label: string; detail: string }>;
  onClear: () => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const operations = useMemo(() => {
    const grouped = new Map<
      string,
      {
        operationId: string;
        action: string;
        username?: string;
        entries: OperationLogEntry[];
      }
    >();
    entries.forEach((entry) => {
      const current = grouped.get(entry.payload.operation_id);
      if (current) {
        current.entries.push(entry);
        if (!current.username && entry.payload.username) {
          current.username = entry.payload.username;
        }
        return;
      }
      grouped.set(entry.payload.operation_id, {
        operationId: entry.payload.operation_id,
        action: entry.payload.action,
        username: entry.payload.username,
        entries: [entry],
      });
    });
    return Array.from(grouped.values()).reverse();
  }, [entries]);

  const pendingCount = pendingRequests.length;
  const totalBadgeCount = activeOperationCount + pendingCount;

  if (isCollapsed) {
    return (
      <div className="operation-dock operation-dock--collapsed">
        <button className="operation-dock__toggle" onClick={() => setIsCollapsed(false)}>
          <span className="operation-dock__toggle-title">后台反馈</span>
          <span className="operation-dock__toggle-meta">
            <span>进行中 {activeOperationCount}</span>
            <span>待响应 {pendingCount}</span>
          </span>
          {totalBadgeCount > 0 ? <span className="operation-dock__count">{totalBadgeCount}</span> : null}
        </button>
      </div>
    );
  }

  return (
    <div className="operation-dock">
      <SectionCard
        title="后台操作反馈"
        actions={
          <div className="inline-controls">
            <button className="ghost-button" onClick={() => setIsCollapsed(true)}>
              收起
            </button>
            <button className="ghost-button" onClick={onClear} disabled={operations.length === 0 && pendingRequests.length === 0}>
              清空
            </button>
          </div>
        }
      >
        <div className="operation-feedback-strip">
          <span className="operation-feedback-badge">
            进行中：{activeOperationCount}
          </span>
          <span className="operation-feedback-badge">
            等待后端响应：{pendingRequests.length}
          </span>
        </div>
        {pendingRequests.length > 0 ? (
          <div className="pending-request-list">
            {pendingRequests.map((request) => (
              <article key={request.id} className="pending-request-card">
                <strong>{request.label}</strong>
                <p>{request.detail}</p>
              </article>
            ))}
          </div>
        ) : null}
        <div className="operation-console operation-console--compact">
          {operations.length === 0 ? (
            <p className="muted-text">点击任一操作按钮后，这里会先显示请求已发出，再持续显示后端步骤和实时输出。</p>
          ) : (
            operations.slice(0, 4).map((operation) => {
              const lastEntry = operation.entries[operation.entries.length - 1];
              const statusClass =
                lastEntry.payload.stage === "operation_error"
                  ? "operation-card--error"
                  : lastEntry.payload.stage === "operation_end"
                    ? "operation-card--success"
                    : "operation-card--running";
              return (
                <article key={operation.operationId} className={`operation-card ${statusClass}`}>
                  <header className="operation-card__header">
                    <div className="operation-card__title">
                      <strong>
                        {formatAction(operation.action)}
                        {operation.username ? ` @${operation.username}` : ""}
                      </strong>
                      <span className="muted-text">
                        {new Date(operation.entries[0].timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <span className={`operation-pill operation-pill--${lastEntry.payload.stage}`}>
                      {formatStage(lastEntry.payload.stage)}
                    </span>
                  </header>
                  <div className="operation-card__timeline">
                    {operation.entries.slice(-6).map((entry, index) => (
                      <div key={`${entry.timestamp}-${index}`} className={`operation-event operation-event--${entry.payload.stage}`}>
                        <div className="operation-event__meta">
                          <span>
                            [{new Date(entry.timestamp).toLocaleTimeString()}] {formatStage(entry.payload.stage)}
                          </span>
                          {entry.payload.username ? <span>@{entry.payload.username}</span> : null}
                        </div>
                        {entry.payload.command ? <pre className="operation-command break-text">{entry.payload.command}</pre> : null}
                        {entry.payload.message ? <pre className="operation-line break-text">{entry.payload.message}</pre> : null}
                      </div>
                    ))}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </SectionCard>
    </div>
  );
}
