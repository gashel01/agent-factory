/** The repository's files as a folder tree, plus a filter that flattens it to
 *  matching paths. Folders start closed except the ones leading to the open
 *  file, so a large repo reads as its top level first. Tree building is the
 *  classic buildFileTree / sortedEntries. */

import { useState } from "react";
import type { JSX } from "react";
import { buildFileTree, sortedEntries } from "../../../repo-model.js";
import type { TreeNode } from "../../../repo-model.js";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Search } from "../../icons.js";

/** Filter results past this are cut (the list stays a list, not a dump). */
const MAX_MATCHES = 300;
const INDENT = 14;

function TreeFolder({ node, depth, active, onOpen }: {
  node: TreeNode; depth: number; active: string; onOpen: (p: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(() => active.startsWith(node.path + "/"));
  return (
    <>
      <button type="button" className="rp-tree-item" style={{ paddingLeft: 10 + depth * INDENT }}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="rp-tree-chev" aria-hidden="true">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="rp-tree-ic" aria-hidden="true">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
        <span className="rp-tree-name">{node.name}</span>
      </button>
      {open && <Entries node={node} depth={depth + 1} active={active} onOpen={onOpen} />}
    </>
  );
}

function Entries({ node, depth, active, onOpen }: {
  node: TreeNode; depth: number; active: string; onOpen: (p: string) => void;
}): JSX.Element {
  return (
    <>
      {sortedEntries(node).map((e) => e.isFile
        ? (
          <button key={e.path} type="button" className="rp-tree-item rp-tree-file" style={{ paddingLeft: 10 + depth * INDENT + 17 }}
            aria-current={active === e.path ? "true" : undefined} onClick={() => onOpen(e.path)}>
            <span className="rp-tree-ic" aria-hidden="true"><FileText size={14} /></span>
            <span className="rp-tree-name">{e.name}</span>
          </button>
        )
        : <TreeFolder key={e.path} node={e} depth={depth} active={active} onOpen={onOpen} />)}
    </>
  );
}

export function FileTree({ files, active, onOpen }: { files: string[]; active: string; onOpen: (p: string) => void }): JSX.Element {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = needle ? files.filter((f) => f.toLowerCase().includes(needle)) : [];
  return (
    <nav className="card rp-tree" aria-label="Files">
      <label className="search-field rp-tree-search">
        <Search size={14} />
        <input value={q} placeholder={`Filter ${files.length.toLocaleString()} files`} aria-label="Filter files"
          onChange={(e) => setQ(e.currentTarget.value)} />
      </label>
      <div className="rp-tree-list">
        {needle ? (
          matches.length === 0 ? <p className="hint rp-tree-none">No file matches “{q.trim()}”.</p> : (
            <>
              {matches.slice(0, MAX_MATCHES).map((f) => (
                <button key={f} type="button" className="rp-tree-item rp-tree-file" aria-current={active === f ? "true" : undefined}
                  onClick={() => onOpen(f)} title={f}>
                  <span className="rp-tree-ic" aria-hidden="true"><FileText size={14} /></span>
                  <span className="rp-tree-name mono">{f}</span>
                </button>
              ))}
              {matches.length > MAX_MATCHES && <p className="hint rp-tree-none">{matches.length - MAX_MATCHES} more — narrow the filter.</p>}
            </>
          )
        ) : <Entries node={buildFileTree(files)} depth={0} active={active} onOpen={onOpen} />}
      </div>
    </nav>
  );
}
