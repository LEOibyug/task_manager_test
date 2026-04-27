import { useEffect, useState } from "react";

import { getExperimentDetail, listExperiments, submitJob } from "../api";
import { SectionCard } from "../components/SectionCard";
import type { AppConfig, ExperimentDetail, ExperimentFile, ExperimentSummary } from "../types";

interface ExperimentsPageProps {
  config: AppConfig;
}

export function ExperimentsPage({ config }: ExperimentsPageProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selected, setSelected] = useState<ExperimentSummary | null>(null);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [account, setAccount] = useState(config.sub_usernames[0] ?? "");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    listExperiments().then(setExperiments).catch(() => setExperiments([]));
  }, []);

  useEffect(() => {
    setAccount(config.sub_usernames[0] ?? "");
  }, [config.sub_usernames]);

  async function loadDetail(experiment: ExperimentSummary) {
    setSelected(experiment);
    const next = await getExperimentDetail(experiment.name);
    setDetail(next);
  }

  async function publishScript(file: ExperimentFile) {
    if (!selected || !account) {
      return;
    }
    const response = await submitJob({
      experiment_name: selected.name,
      script_path: file.path,
      account,
    });
    setMessage(response.message);
  }

  return (
    <SectionCard title="Experiments">
      <div className="split-layout">
        <div className="list-panel">
          {experiments.map((experiment) => (
            <button
              key={experiment.name}
              className={`list-item ${selected?.name === experiment.name ? "active" : ""}`}
              onClick={() => loadDetail(experiment)}
            >
              {experiment.name}
            </button>
          ))}
        </div>
        <div className="detail-panel">
          <div className="inline-controls">
            <select value={account} onChange={(event) => setAccount(event.target.value)}>
              {config.sub_usernames.map((username) => (
                <option key={username} value={username}>
                  {username}
                </option>
              ))}
            </select>
            <span className="muted-text">Submit target account</span>
          </div>
          {message ? <p className="success-text">{message}</p> : null}
          {detail ? (
            <div className="file-grid">
              {detail.files.map((file) => (
                <article key={file.path} className="file-card">
                  <h3>{file.name}</h3>
                  <p>{file.kind}</p>
                  <p className="mono">{file.path}</p>
                  {file.kind === "sbatch" ? (
                    <button onClick={() => publishScript(file)}>Publish to {account || "account"}</button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-text">Select an experiment to inspect scripts and files.</p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

