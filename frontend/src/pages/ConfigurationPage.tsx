import { useEffect, useState } from "react";

import { saveConfig, testConnection } from "../api";
import type { AppConfig, ConnectionCheckResult } from "../types";
import { SectionCard } from "../components/SectionCard";

interface ConfigurationPageProps {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}

function parseRepoPaths(value: string): Record<string, string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, line) => {
      const [user, ...pathParts] = line.split("=");
      if (user && pathParts.length > 0) {
        acc[user.trim()] = pathParts.join("=").trim();
      }
      return acc;
    }, {});
}

function formatRepoPaths(repoPaths: Record<string, string>): string {
  return Object.entries(repoPaths)
    .map(([user, path]) => `${user}=${path}`)
    .join("\n");
}

export function ConfigurationPage({ config, onConfigChange }: ConfigurationPageProps) {
  const [draft, setDraft] = useState<AppConfig>(config);
  const [checks, setChecks] = useState<ConnectionCheckResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  async function persistConfig() {
    const saved = await saveConfig(draft);
    onConfigChange(saved);
    setDraft(saved);
    setMessage("配置已保存。");
  }

  async function runConnectionCheck() {
    const response = await testConnection(draft);
    setChecks(response.checks);
  }

  function updateRepoPath(username: string, path: string) {
    setDraft((current) => ({
      ...current,
      repo_paths: {
        ...current.repo_paths,
        [username]: path,
      },
    }));
  }

  function handleSubUsersChange(value: string) {
    const nextSubUsers = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    setDraft((current) => {
      const nextRepoPaths: Record<string, string> = {};
      if (current.main_username && current.repo_paths[current.main_username]) {
        nextRepoPaths[current.main_username] = current.repo_paths[current.main_username];
      }
      nextSubUsers.forEach((username) => {
        nextRepoPaths[username] = current.repo_paths[username] ?? "";
      });
      return {
        ...current,
        sub_usernames: nextSubUsers,
        repo_paths: nextRepoPaths,
      };
    });
  }

  const accountRows = [
    ...(draft.main_username ? [{ username: draft.main_username, label: "主账户路径" }] : []),
    ...draft.sub_usernames.map((username, index) => ({
      username,
      label: `分账户路径 ${index + 1}`,
    })),
  ];

  return (
    <SectionCard
      title="连接与账户"
      actions={
        <div className="inline-controls">
          <button className="ghost-button" onClick={runConnectionCheck}>
            测试连接
          </button>
          <button onClick={persistConfig}>保存配置</button>
        </div>
      }
    >
      <div className="form-grid">
        <label>
          服务器 IP
          <input
            value={draft.server_ip}
            onChange={(event) => setDraft({ ...draft, server_ip: event.target.value })}
          />
        </label>
        <label>
          SSH 端口
          <input
            type="number"
            value={draft.server_port}
            onChange={(event) => setDraft({ ...draft, server_port: Number(event.target.value) })}
          />
        </label>
        <label>
          主账户
          <input
            value={draft.main_username}
            onChange={(event) =>
              setDraft((current) => {
                const nextMainUsername = event.target.value.trim();
                const nextRepoPaths = { ...current.repo_paths };
                if (current.main_username && current.main_username !== nextMainUsername) {
                  delete nextRepoPaths[current.main_username];
                }
                if (nextMainUsername) {
                  nextRepoPaths[nextMainUsername] = current.repo_paths[nextMainUsername] ?? "";
                }
                return {
                  ...current,
                  main_username: nextMainUsername,
                  repo_paths: nextRepoPaths,
                };
              })
            }
          />
        </label>
        <label>
          刷新间隔
          <input
            type="number"
            value={draft.refresh_interval}
            onChange={(event) => setDraft({ ...draft, refresh_interval: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="full-width">
        分账户
        <input
          value={draft.sub_usernames.join(", ")}
          onChange={(event) => handleSubUsersChange(event.target.value)}
        />
      </label>
      <div className="full-width repo-paths-panel">
        <p className="repo-paths-panel__title">各账户仓库路径</p>
        {accountRows.length > 0 ? (
          <div className="repo-paths-grid">
            {accountRows.map((account) => (
              <label key={account.username} className="repo-path-row">
                <span>{account.label}：`{account.username}`</span>
                <input
                  value={draft.repo_paths[account.username] ?? ""}
                  placeholder="/absolute/path/to/repo"
                  onChange={(event) => updateRepoPath(account.username, event.target.value)}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="muted-text">请先填写主账户和至少一个分账户，然后分别配置它们的仓库路径。</p>
        )}
      </div>
      {message ? <p className="success-text">{message}</p> : null}
      {checks.length > 0 ? (
        <div className="check-grid">
          {checks.map((check) => (
            <article key={check.username} className={check.reachable ? "check-card ok" : "check-card bad"}>
              <h3>{check.username}</h3>
              <p>{check.repo_path ?? "未配置仓库路径"}</p>
              <p>{check.message}</p>
            </article>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
