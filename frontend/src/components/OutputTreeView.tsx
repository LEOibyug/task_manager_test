import { useEffect, useMemo, useState } from "react";

import { getOutputTree } from "../api";
import type { JobRecord, OutputFileItem, OutputNode, OutputTreeResponse } from "../types";
import { SectionCard } from "./SectionCard";

function NodeItem({ node }: { node: OutputNode }) {
  return (
    <li>
      <span className={node.is_dir ? "tree-node tree-node--dir" : "tree-node"}>{node.name}</span>
      {node.children.length > 0 ? (
        <ul className="tree-list">
          {node.children.map((child) => (
            <NodeItem key={child.path} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OutputTreeView({ job }: { job: JobRecord | null }) {
  const [tree, setTree] = useState<OutputTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeJobId = job?.job_id ?? null;
  const sbatchLogFile = useMemo<OutputFileItem | null>(() => {
    if (!job?.log_path) {
      return null;
    }
    const parts = job.log_path.split("/");
    return {
      name: parts[parts.length - 1] || job.log_path,
      path: job.log_path,
      is_dir: false,
    };
  }, [job?.log_path]);

  const files = useMemo(() => {
    const result: OutputFileItem[] = [];
    function walk(node: OutputNode) {
      if (!node.is_dir) {
        result.push({ name: node.name, path: node.path, is_dir: false });
        return;
      }
      node.children.forEach(walk);
    }
    if (tree) {
      walk(tree.root);
    }
    return result;
  }, [tree]);
  const totalFileCount = files.length + (sbatchLogFile ? 1 : 0);

  useEffect(() => {
    if (!job) {
      setTree(null);
      return;
    }
    const controller = new AbortController();
    getOutputTree(job.job_id, controller.signal)
      .then((response) => {
        setTree(response);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") {
          return;
        }
        setError(err.message);
      });
    return () => controller.abort();
  }, [activeJobId]);

  return (
    <SectionCard title="产出">
      {error ? <p className="error-text">{error}</p> : null}
      {job ? (
        <div className="output-summary">
          <span className="output-summary__pill">文件 {totalFileCount}</span>
          <span className={`output-summary__pill ${job.synced ? "output-summary__pill--success" : ""}`}>
            {job.synced ? "已同步" : "未同步"}
          </span>
        </div>
      ) : null}
      {sbatchLogFile ? (
        <div className="output-file-list">
          <article className="output-file-card">
            <div className="output-file-card__meta">
              <strong>sbatch 输出</strong>
              <p>{sbatchLogFile.name}</p>
              <p className="mono break-text">{sbatchLogFile.path}</p>
            </div>
          </article>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="output-file-list">
          {files.map((file) => (
            <article key={file.path} className="output-file-card">
              <div className="output-file-card__meta">
                <strong>{file.name}</strong>
                <p className="mono break-text">{file.path}</p>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {tree ? (
        <ul className="tree-list">
          <NodeItem node={tree.root} />
        </ul>
      ) : (
        <p className="muted-text">选择任务后显示产出目录</p>
      )}
    </SectionCard>
  );
}
