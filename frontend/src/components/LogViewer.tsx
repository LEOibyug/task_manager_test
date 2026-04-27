import { useEffect, useState } from "react";

import { getJobLog } from "../api";
import type { JobRecord, LogResponse } from "../types";
import { SectionCard } from "./SectionCard";

export function LogViewer({ job }: { job: JobRecord | null }) {
  const [log, setLog] = useState<LogResponse | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job) {
      setLog(null);
      return;
    }
    getJobLog(job.job_id, { tail: true })
      .then(setLog)
      .catch((err: Error) => setError(err.message));
  }, [job]);

  async function refreshLog(tail: boolean) {
    if (!job) {
      return;
    }
    try {
      const next = await getJobLog(job.job_id, {
        tail,
        offset: tail ? undefined : log?.next_offset ?? 0,
        search: search || undefined,
      });
      setLog(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SectionCard
      title="Sbatch Log"
      actions={
        <div className="inline-controls">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search keyword"
          />
          <button className="ghost-button" onClick={() => refreshLog(false)} disabled={!job}>
            Search
          </button>
          <button className="ghost-button" onClick={() => refreshLog(true)} disabled={!job}>
            Jump to tail
          </button>
        </div>
      }
    >
      {error ? <p className="error-text">{error}</p> : null}
      <pre className="log-viewer">{log?.content ?? "Select a job to inspect its sbatch log."}</pre>
    </SectionCard>
  );
}

