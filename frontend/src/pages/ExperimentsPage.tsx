import { useEffect, useMemo, useState } from "react";

import { getExperimentDetail, listExperiments, submitJob } from "../api";
import { SectionCard } from "../components/SectionCard";
import type { AppConfig, ExperimentDetail, ExperimentFile, ExperimentSummary } from "../types";

interface ExperimentsPageProps {
  config: AppConfig;
  experiments: ExperimentSummary[] | null;
  onExperimentsChange: (experiments: ExperimentSummary[]) => void;
  onOperationStart: (label: string, detail: string) => string;
  onOperationEnd: (id: string) => void;
}

export function ExperimentsPage({
  config,
  experiments,
  onExperimentsChange,
  onOperationStart,
  onOperationEnd,
}: ExperimentsPageProps) {
  const gpuOptions = ["gpu1", "gpu2", "gpu3"] as const;
  const [selected, setSelected] = useState<ExperimentSummary | null>(null);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [search, setSearch] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});
  const [gpuNodeEnabled, setGpuNodeEnabled] = useState<Record<string, boolean>>({});
  const [selectedGpuNodes, setSelectedGpuNodes] = useState<Record<string, (typeof gpuOptions)[number]>>({});
  const [autoRetryEnabled, setAutoRetryEnabled] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [submittingKeys, setSubmittingKeys] = useState<string[]>([]);

  const availableAccounts = useMemo(() => {
    const accounts = [config.main_username, ...config.sub_usernames].filter(Boolean);
    return Array.from(new Set(accounts));
  }, [config.main_username, config.sub_usernames]);

  useEffect(() => {
    if (experiments !== null) {
      return;
    }
    void refreshExperiments();
  }, [experiments]);

  async function refreshExperiments() {
    const operationId = onOperationStart("刷新实验列表", "实验列表刷新请求已发送，等待主账户扫描 experiments 目录。");
    setIsRefreshing(true);
    try {
      const next = await listExperiments();
      onExperimentsChange(next);
      if (selected && !next.find((item) => item.name === selected.name)) {
        setSelected(null);
        setDetail(null);
      }
    } catch {
      onExperimentsChange([]);
    } finally {
      setIsRefreshing(false);
      onOperationEnd(operationId);
    }
  }

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
    const submitKey = `${file.path}:${targetAccount}`;
    const useGpuNode = gpuNodeEnabled[file.path] ?? false;
    const preferredGpuNode = useGpuNode ? selectedGpuNodes[file.path] ?? "gpu1" : null;
    const useAutoRetry = autoRetryEnabled[file.path] ?? false;
    const operationId = onOperationStart("提交任务", `提交请求已发送，将向账户 ${targetAccount} 发布脚本 ${file.name}。`);
    setSubmittingKeys((current) => Array.from(new Set([...current, submitKey])));
    try {
      const response = await submitJob({
        experiment_name: selected.name,
        script_path: file.path,
        account: targetAccount,
        preferred_gpu_node: preferredGpuNode,
        auto_retry_enabled: useAutoRetry,
      });
      setMessage(response.message);
    } finally {
      setSubmittingKeys((current) => current.filter((item) => item !== submitKey));
      onOperationEnd(operationId);
    }
  }

  const filteredExperiments = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
      return experiments ?? [];
    }
    return (experiments ?? []).filter((experiment) => experiment.name.toLowerCase().includes(keyword));
  }, [experiments, search]);

  return (
    <SectionCard
      title="实验列表"
      actions={
        <button className="ghost-button" onClick={() => void refreshExperiments()} disabled={isRefreshing}>
          {isRefreshing ? "刷新中..." : "手动刷新"}
        </button>
      }
    >
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
              {detail.files.map((file) => {
                const targetAccount = selectedAccounts[file.path] ?? availableAccounts[0] ?? "";
                const submitKey = `${file.path}:${targetAccount}`;
                const isSubmitting = submittingKeys.includes(submitKey);
                const useGpuNode = gpuNodeEnabled[file.path] ?? false;
                const selectedGpuNode = selectedGpuNodes[file.path] ?? "gpu1";
                const useAutoRetry = autoRetryEnabled[file.path] ?? false;
                return (
                <article key={file.path} className="file-card">
                  <h3>{file.name}</h3>
                  <p>{file.kind}</p>
                  <p className="mono break-text">{file.path}</p>
                  {file.kind === "sbatch" ? (
                    <div className="file-card__actions">
                      <select
                        value={targetAccount}
                        disabled={isSubmitting}
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
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={useGpuNode}
                          disabled={isSubmitting}
                          onChange={(event) =>
                            setGpuNodeEnabled((current) => ({
                              ...current,
                              [file.path]: event.target.checked,
                            }))
                          }
                        />
                        <span>指定节点</span>
                      </label>
                      {useGpuNode ? (
                        <select
                          value={selectedGpuNode}
                          disabled={isSubmitting}
                          onChange={(event) =>
                            setSelectedGpuNodes((current) => ({
                              ...current,
                              [file.path]: event.target.value as (typeof gpuOptions)[number],
                            }))
                          }
                        >
                          {gpuOptions.map((gpu) => (
                            <option key={gpu} value={gpu}>
                              {gpu}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={useAutoRetry}
                          disabled={isSubmitting}
                          onChange={(event) =>
                            setAutoRetryEnabled((current) => ({
                              ...current,
                              [file.path]: event.target.checked,
                            }))
                          }
                        />
                        <span>超时后自动续训</span>
                      </label>
                      <button onClick={() => void publishScript(file)} disabled={isSubmitting}>
                        {isSubmitting ? "提交中..." : `发布到 ${targetAccount || "目标账户"}`}
                      </button>
                    </div>
                  ) : null}
                </article>
                );
              })}
            </div>
          ) : (
            <p className="muted-text">请选择一个实验以查看脚本和文件。</p>
          )}
        </section>
      </div>
    </SectionCard>
  );
}
