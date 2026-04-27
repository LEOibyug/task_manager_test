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
    getOutputTree(job.job_id)
      .then((response) => {
        setTree(response);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [job]);

  return (
    <SectionCard title="产出浏览器">
      {error ? <p className="error-text">{error}</p> : null}
      {job ? (
        <div className="output-summary">
          <p>
            当前任务产出文件数：<strong>{files.length}</strong>
          </p>
          <p>
            同步状态：
            <strong className={job.synced ? "success-text" : "muted-text"}>{job.synced ? " 主账户已检测到对应结果" : " 主账户尚未检测到完整结果"}</strong>
          </p>
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
        <p className="muted-text">请选择一个运行中或已完成的任务以查看产出目录。</p>
      )}
    </SectionCard>
  );
}
