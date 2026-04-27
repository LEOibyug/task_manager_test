import { useEffect, useMemo, useState } from "react";

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
  const [search, setSearch] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const availableAccounts = useMemo(() => {
    const accounts = [config.main_username, ...config.sub_usernames].filter(Boolean);
    return Array.from(new Set(accounts));
  }, [config.main_username, config.sub_usernames]);

  useEffect(() => {
    listExperiments().then(setExperiments).catch(() => setExperiments([]));
  }, []);

  async function loadDetail(experiment: ExperimentSummary) {
    setSelected(experiment);
    const next = await getExperimentDetail(experiment.name);
    setDetail(next);
  }

  async function publishScript(file: ExperimentFile) {
    if (!selected) {
      return;
    }
    const targetAccount = selectedAccounts[file.path] ?? availableAccounts[0] ?? "";
    if (!targetAccount) {
      setMessage("请先选择目标账户。");
      return;
    }
    const response = await submitJob({
      experiment_name: selected.name,
      script_path: file.path,
      account: targetAccount,
    });
    setMessage(response.message);
  }

  const filteredExperiments = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
      return experiments;
    }
    return experiments.filter((experiment) => experiment.name.toLowerCase().includes(keyword));
  }, [experiments, search]);

  return (
    <SectionCard title="实验列表">
      <div className="experiments-layout">
        <aside className="list-panel experiments-sidebar">
          <div className="experiments-sidebar__toolbar">
            <input
              value={search}
              placeholder="搜索实验名称"
              onChange={(event) => setSearch(event.target.value)}
            />
            <p className="muted-text">仅展示主账户 `experiments/` 目录下的实验。</p>
          </div>
          <div className="experiments-list-scroll">
            {filteredExperiments.map((experiment) => (
              <button
                key={experiment.name}
                className={`list-item ${selected?.name === experiment.name ? "active" : ""}`}
                onClick={() => loadDetail(experiment)}
              >
                {experiment.name}
              </button>
            ))}
          </div>
        </aside>
        <section className="detail-panel experiments-detail">
          {message ? <p className="success-text">{message}</p> : null}
          {detail ? (
            <div className="file-grid">
              {detail.files.map((file) => (
                <article key={file.path} className="file-card">
                  <h3>{file.name}</h3>
                  <p>{file.kind}</p>
                  <p className="mono break-text">{file.path}</p>
                  {file.kind === "sbatch" ? (
                    <div className="file-card__actions">
                      <select
                        value={selectedAccounts[file.path] ?? availableAccounts[0] ?? ""}
                        onChange={(event) =>
                          setSelectedAccounts((current) => ({
                            ...current,
                            [file.path]: event.target.value,
                          }))
                        }
                      >
                        {availableAccounts.map((username) => (
                          <option key={username} value={username}>
                            {username}
                          </option>
                        ))}
                      </select>
                      <button onClick={() => publishScript(file)}>
                        发布到 {(selectedAccounts[file.path] ?? availableAccounts[0] ?? "目标账户")}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-text">请选择一个实验以查看脚本和文件。</p>
          )}
        </section>
      </div>
    </SectionCard>
  );
}
