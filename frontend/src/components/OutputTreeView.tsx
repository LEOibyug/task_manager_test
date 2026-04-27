import { useEffect, useState } from "react";

import { getOutputTree } from "../api";
import type { JobRecord, OutputNode, OutputTreeResponse } from "../types";
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
