import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { repoGet, repoPath, postJSON } from "./api.js";
import { langFromPath, tokenizeLine } from "./highlight.js";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GitBranch } from "./icons.js";
import { toast } from "./core.js";
import { Modal, Select } from "./widgets.js";
import { Diff } from "./diff-view.js";

export interface TreeNode { name: string; path: string; isFile: boolean; children: Map<string, TreeNode> }

/** Fold flat repo paths ("src/components/Nav.tsx") into a nested folder tree. */
export function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), isFile, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Folders first, then files; alphabetical within each. */
export function sortedEntries(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1);
}

export function TreeFolder(
  { node, depth, onOpen, activePath }:
  { node: TreeNode; depth: number; onOpen: (p: string) => void; activePath: string | null },
): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button className="tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tree-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="tree-ic" aria-hidden="true">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open && sortedEntries(node).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={depth + 1} onOpen={onOpen} activePath={activePath} />)}
    </>
  );
}

/** The repo files as a collapsible folder tree. */
export function FileTree({ paths, onOpen, activePath }: { paths: string[]; onOpen: (p: string) => void; activePath: string | null }): JSX.Element {
  const root = buildFileTree(paths);
  return (
    <div className="tree">
      {sortedEntries(root).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={0} onOpen={onOpen} activePath={activePath} />)}
    </div>
  );
}

/** One source line rendered as coloured tokens (syntax highlighting). */
export function CodeLine({ code, lang }: { code: string; lang: string }): JSX.Element {
  const toks = tokenizeLine(code, lang);
  return <>{toks.map((t, i) => <span key={i} className={t.cls || undefined}>{t.text}</span>)}</>;
}

/** A whole file preview with line numbers and syntax highlighting. */
export function CodeBlock({ content, path }: { content: string; path: string }): JSX.Element {
  const lang = langFromPath(path);
  return (
    <pre className="code-pre">
      {content.split("\n").map((ln, i) => (
        <div key={i} className="code-line">
          <span className="code-gutter">{i + 1}</span>
          <span className="code-text"><CodeLine code={ln} lang={lang} /></span>
        </div>
      ))}
    </pre>
  );
}

/** An operator's note pinned to one diff line (the pépite: it loops back to the
 *  agent as "changes" feedback). */
export interface ReviewComment { id: number; file: string; key: string; line: number | null; snippet: string; text: string }

export interface Commit { hash: string; date: string; author: string; subject: string; body: string; parents: string[]; refs: string[] }

const LANE_W = 15;
const ROW_H = 40;
const DOT_R = 4.5;
// A calm palette that reads on both themes; lanes cycle through it by column.
const LANE_COLORS = ["#5b9dff", "#39c5a6", "#e0b341", "#e8776f", "#c07ae0", "#5fb0e8", "#e08b4a", "#57c46f"];
const laneColor = (i: number): string => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]!;

interface GraphSeg { x1: number; y1: number; x2: number; y2: number; color: string }
interface GraphRow { commit: Commit; col: number; lanes: number; segs: GraphSeg[]; dotColor: string }

/** Assign each commit a stable lane (column) and pre-compute the railroad
 *  connectors row-by-row. Commits arrive newest-first in topo order, so a lane
 *  "holds" a hash from the child that opened it until its parent is reached. */
export function computeGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = []; // hash each lane is currently waiting for
  const cx = (col: number): number => col * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const incoming = lanes.slice();
    let col = incoming.findIndex((h) => h === commit.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) { col = lanes.length; lanes.push(null); }
    }
    // Every lane that was waiting for this commit has now reached it — free them;
    // the chosen col is reused below for the first parent's continuing line.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.hash) lanes[i] = null;

    const parentCols: number[] = [];
    commit.parents.forEach((ph, p) => {
      let pc: number;
      if (p === 0) { pc = col; }
      else { pc = lanes.indexOf(ph); if (pc === -1) { pc = lanes.indexOf(null); if (pc === -1) { pc = lanes.length; lanes.push(null); } } }
      lanes[pc] = ph;
      parentCols.push(pc);
    });
    if (commit.parents.length === 0) lanes[col] = null; // root commit closes its lane

    const outgoing = lanes.slice();
    const segs: GraphSeg[] = [];
    // Top half: incoming lanes flow down into their column, bending into `col`
    // when they were waiting for this very commit (a child meeting its parent).
    incoming.forEach((h, L) => {
      if (h == null) return;
      if (h === commit.hash) segs.push({ x1: cx(L), y1: 0, x2: cx(col), y2: mid, color: laneColor(L) });
      else segs.push({ x1: cx(L), y1: 0, x2: cx(L), y2: mid, color: laneColor(L) });
    });
    // Bottom half: parent edges fan out from this commit; other lanes pass straight.
    outgoing.forEach((h, L) => {
      if (h == null) return;
      if (parentCols.includes(L)) segs.push({ x1: cx(col), y1: mid, x2: cx(L), y2: ROW_H, color: laneColor(L) });
      else segs.push({ x1: cx(L), y1: mid, x2: cx(L), y2: ROW_H, color: laneColor(L) });
    });

    rows.push({ commit, col, lanes: Math.max(incoming.length, outgoing.length, col + 1, 1), segs, dotColor: laneColor(col) });
  }
  return rows;
}

/** Clean a git ref decoration into a short label + kind (branch/tag/head). */
function refLabel(ref: string): { text: string; kind: string } | null {
  if (ref === "HEAD") return { text: "HEAD", kind: "head" };
  if (ref.startsWith("HEAD -> ")) return { text: ref.slice(8), kind: "head" };
  if (ref.startsWith("tag: ")) return { text: ref.slice(5), kind: "tag" };
  if (ref.startsWith("origin/") || ref.startsWith("remotes/")) return null; // hide remote dupes — keep it calm
  return { text: ref, kind: "branch" };
}

/** The branch timeline: a coloured railroad of commits across every branch.
 *  `compareFrom` (when set) marks the anchor commit while the operator picks a
 *  second one to diff against — the arming step of a range compare. */
export function BranchGraph(
  { commits, onPick, active, compareFrom }:
  { commits: Commit[]; onPick: (hash: string) => void; active: string | null; compareFrom: string | null },
): JSX.Element {
  if (commits.length === 0) return <p className="hint">No commits yet.</p>;
  const rows = computeGraph(commits);
  const maxLanes = Math.max(...rows.map((r) => r.lanes), 1);
  const gw = maxLanes * LANE_W;
  return (
    <div className="graph">
      {rows.map((r) => {
        const c = r.commit;
        // Hover reveals the full (often truncated) subject + body + provenance.
        const tip = [c.subject, c.body, `${c.hash} · ${c.author} · ${c.date}`].filter(Boolean).join("\n\n");
        const cls = `graph-row${active === c.hash ? " on" : ""}${compareFrom === c.hash ? " anchor" : ""}`;
        return (
          <button key={c.hash} className={cls} onClick={() => onPick(c.hash)} title={tip}>
            <svg className="graph-rail" width={gw} height={ROW_H} viewBox={`0 0 ${gw} ${ROW_H}`} aria-hidden="true">
              {r.segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={2} strokeLinecap="round" />)}
              <circle cx={r.col * LANE_W + LANE_W / 2} cy={ROW_H / 2} r={DOT_R} fill="var(--surface)" stroke={r.dotColor} strokeWidth={2.5} />
            </svg>
            <span className="graph-text">
              <span className="graph-subject">
                {c.refs.map(refLabel).filter(Boolean).map((rl, i) => (
                  <span key={i} className={`graph-ref ${rl!.kind}`}>{rl!.text}</span>
                ))}
                {c.subject}
              </span>
              <span className="graph-meta">{c.hash} · {c.author} · {c.date}</span>
            </span>
            {compareFrom === c.hash && <span className="graph-anchor-tag">base</span>}
          </button>
        );
      })}
    </div>
  );
}

export function RepoModal(
  { onClose, initialFile }: { onClose: () => void; initialFile?: string },
): JSX.Element {
  const repo = repoPath();
  const [tab, setTab] = useState<"files" | "history">("files");
  const [files, setFiles] = useState<string[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [activeCommit, setActiveCommit] = useState<string | null>(null);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [scope, setScope] = useState<string>(""); // "" = all branches, else a single ref
  const [compareFrom, setCompareFrom] = useState<string | null>(null); // armed compare anchor
  const [mainView, setMainView] = useState<ReactNode>(<p className="hint">Pick a file to preview it, or a commit to see its diff.</p>);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void repoGet<{ branches: string[]; current: string }>("branches").then(setBranches).catch(() => {});
    void repoGet<{ files: string[] }>("tree").then((r) => setFiles(r.files)).catch(() => {});
    // Opened from a hotspot row (or any deep link): preview that file straight away.
    if (initialFile) void openFile(initialFile);
  }, []);
  useEffect(() => {
    // No scope → all=1 spans every branch (real topology); a scope shows that ref's line.
    if (tab !== "history") return;
    const params: Record<string, string> = scope ? { ref: scope } : { all: "1" };
    void repoGet<{ commits: Commit[] }>("log", params).then((r) => setCommits(r.commits)).catch(() => {});
  }, [tab, scope]);

  if (!repo) return <Modal title="Repo" onClose={onClose}><p className="hint">Set a repository path in the New work panel first.</p></Modal>;

  const openFile = async (path: string): Promise<void> => {
    setActivePath(path);
    try {
      const { content } = await repoGet<{ content: string }>("file", { path });
      setMainView(
        <>
          <div className="repo-file-bar"><span className="card-title">{path}</span>
            <button className="btn ghost" onClick={() => { window.location.href = `vscode://file/${repo.replace(/\\/g, "/")}/${path}`; }}>Open in IDE</button></div>
          <CodeBlock content={content} path={path} />
        </>,
      );
    } catch (err) { toast(String(err), true); }
  };
  const openDiff = async (hash: string): Promise<void> => {
    setActiveCommit(hash);
    try {
      const { diff } = await repoGet<{ diff: string }>("diff", { commit: hash });
      setMainView(
        <>
          <div className="repo-file-bar"><span>Commit {hash}</span>
            <button className="btn ghost" onClick={() => { setCompareFrom(hash); toast("Now pick a second commit to compare against."); }}>Compare from here</button>
          </div>
          <Diff text={diff} />
        </>,
      );
    } catch (err) { toast(String(err), true); }
  };
  const openRange = async (from: string, to: string): Promise<void> => {
    setCompareFrom(null);
    setActiveCommit(to);
    try {
      const { diff } = await repoGet<{ diff: string }>("diff", { from, to });
      setMainView(<><div className="repo-file-bar">Comparing {from} → {to}</div><Diff text={diff} /></>);
    } catch (err) { toast(String(err), true); }
  };
  // A click either arms/completes a compare, or shows that one commit's diff.
  const pickCommit = (hash: string): void => {
    if (compareFrom && compareFrom !== hash) void openRange(compareFrom, hash);
    else void openDiff(hash);
  };

  return (
    <Modal title={`Repo — ${repo.split(/[\\/]/).pop()}`} onClose={onClose} wide>
      <div className="repo-toolbar">
        <Select value={branches.current} ariaLabel="Branch" minWidth={160}
          options={branches.branches.map((b) => ({ value: b, label: b }))}
          onChange={async (v) => {
            try { await postJSON("/api/repo/switch", { path: repo, branch: v }); toast(`Now on ${v}.`);
              const r = await repoGet<{ branches: string[]; current: string }>("branches"); setBranches(r); }
            catch (err) { toast(String(err), true); }
          }} />
        <div className="repo-tabs">
          <button className={`btn link${tab === "files" ? " on" : ""}`} onClick={() => setTab("files")}>Files</button>
          <button className={`btn link${tab === "history" ? " on" : ""}`} onClick={() => setTab("history")}>History</button>
        </div>
        {tab === "history" && (
          <label className="repo-scope">
            <span className="repo-scope-ic" aria-hidden="true"><GitBranch size={13} /></span>
            <Select value={scope} ariaLabel="Timeline scope" minWidth={150}
              options={[{ value: "", label: "All branches" }, ...branches.branches.map((b) => ({ value: b, label: b }))]}
              onChange={setScope} />
          </label>
        )}
      </div>
      {tab === "history" && compareFrom && (
        <div className="compare-strip">
          <span>Comparing from <span className="mono">{compareFrom}</span> — pick a target commit in the timeline.</span>
          <button className="btn link" onClick={() => setCompareFrom(null)}>Cancel</button>
        </div>
      )}
      <div className={`repo-body${tab === "history" ? " history" : ""}`}>
        <div className="repo-side">
          {tab === "files"
            ? <FileTree paths={files} onOpen={(p) => void openFile(p)} activePath={activePath} />
            : <BranchGraph commits={commits} onPick={pickCommit} active={activeCommit} compareFrom={compareFrom} />}
        </div>
        <div className="repo-main">{mainView}</div>
      </div>
    </Modal>
  );
}
