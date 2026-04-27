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
    setMessage("Configuration saved.");
  }

  async function runConnectionCheck() {
    const response = await testConnection(draft);
    setChecks(response.checks);
  }

  return (
    <SectionCard
      title="Connection & Accounts"
      actions={
        <div className="inline-controls">
          <button className="ghost-button" onClick={runConnectionCheck}>
            Test connection
          </button>
          <button onClick={persistConfig}>Save config</button>
        </div>
      }
    >
      <div className="form-grid">
        <label>
          Server IP
          <input
            value={draft.server_ip}
            onChange={(event) => setDraft({ ...draft, server_ip: event.target.value })}
          />
        </label>
        <label>
          SSH Port
          <input
            type="number"
            value={draft.server_port}
            onChange={(event) => setDraft({ ...draft, server_port: Number(event.target.value) })}
          />
        </label>
        <label>
          Main account
          <input
            value={draft.main_username}
            onChange={(event) => setDraft({ ...draft, main_username: event.target.value })}
          />
        </label>
        <label>
          Refresh interval
          <input
            type="number"
            value={draft.refresh_interval}
            onChange={(event) => setDraft({ ...draft, refresh_interval: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="full-width">
        Sub accounts
        <input
          value={draft.sub_usernames.join(", ")}
          onChange={(event) =>
            setDraft({
              ...draft,
              sub_usernames: event.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label className="full-width">
        Repo paths (`username=/absolute/path`)
        <textarea
          rows={6}
          value={Object.entries(draft.repo_paths)
            .map(([user, path]) => `${user}=${path}`)
            .join("\n")}
          onChange={(event) => setDraft({ ...draft, repo_paths: parseRepoPaths(event.target.value) })}
        />
      </label>
      {message ? <p className="success-text">{message}</p> : null}
      {checks.length > 0 ? (
        <div className="check-grid">
          {checks.map((check) => (
            <article key={check.username} className={check.reachable ? "check-card ok" : "check-card bad"}>
              <h3>{check.username}</h3>
              <p>{check.repo_path ?? "No repo path"}</p>
              <p>{check.message}</p>
            </article>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
