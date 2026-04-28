import { useEffect, useMemo, useState } from "react";

import { downloadOutputFile, getOutputTree } from "../api";
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
          <span className="output-summary__pill">文件 {files.length}</span>
          <span className={`output-summary__pill ${job.synced ? "output-summary__pill--success" : ""}`}>
            {job.synced ? "已同步" : "未同步"}
          </span>
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
              {job ? (
                <button className="ghost-button" onClick={() => void downloadOutputFile(job.job_id, file.path)}>
                  下载文件
                </button>
              ) : null}
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
