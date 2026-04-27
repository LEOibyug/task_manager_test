import type { CommandLogEventPayload } from "../types";
import { SectionCard } from "./SectionCard";

interface OperationLogEntry {
  payload: CommandLogEventPayload;
  timestamp: string;
}

export function OperationConsole({
  entries,
  onClear,
}: {
  entries: OperationLogEntry[];
  onClear: () => void;
}) {
  return (
    <SectionCard
      title="操作控制台"
      actions={
        <button className="ghost-button" onClick={onClear}>
          清空日志
        </button>
      }
    >
      <div className="operation-console">
        {entries.length === 0 ? (
          <p className="muted-text">执行提交、刷新、同步或连接测试等操作后，这里会实时显示命令日志。</p>
        ) : (
          entries.map((entry, index) => (
            <pre key={`${entry.timestamp}-${index}`} className={`operation-line operation-line--${entry.payload.stage}`}>
              <span className="operation-meta">
                [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.payload.action}
                {entry.payload.username ? `@${entry.payload.username}` : ""}
              </span>{" "}
              {entry.payload.message ?? ""}
            </pre>
          ))
        )}
      </div>
    </SectionCard>
  );
}
