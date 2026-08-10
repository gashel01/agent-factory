import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "./icons.js";
import { repoGet, repoPath, postJSON } from "./api.js";
import { parseDiff } from "./model.js";
import { langFromPath, tokenizeLine } from "./highlight.js";
import { toast } from "./core.js";
import { Modal, Select } from "./widgets.js";

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

interface ReviewProps {
  comments: ReviewComment[];
  composingKey: string | null;
  onStart: (file: string, key: string, line: number | null, snippet: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onRemove: (id: number) => void;
}

function Diff({ text, review }: { text: string; review?: ReviewProps }): JSX.Element {
  const { files } = useMemo(() => parseDiff(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string): void =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  if (files.length === 0) return <pre className="diff-pre">{text}</pre>;
  const jump = (path: string): void =>
    document.getElementById(`df-${path}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  const pending = review?.comments.length ?? 0;
  return (
    <div className="diff-view">
      <div className="diff-summary">
        <span className="ds-files">Edited {files.length} {files.length === 1 ? "file" : "files"}</span>
        <span className="chip-add">+{totalAdds}</span><span className="chip-del">−{totalDels}</span>
        {review && (
          <span className="ds-review">
            {pending > 0
              ? `${pending} comment${pending > 1 ? "s" : ""} to send back`
              : "Comment on any line to review"}
          </span>
        )}
      </div>
      {files.length > 1 && (
        <div className="diff-filebar">
          {files.map((f) => (
            <button key={f.path} className="diff-filechip" onClick={() => jump(f.path)}>
              <span className="chip-path">{f.path.split("/").pop()}</span>
              <span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span>
            </button>
          ))}
        </div>
      )}
      {files.map((f) => {
        const lang = langFromPath(f.path);
        const shut = collapsed.has(f.path);
        return (
          <section key={f.path} id={`df-${f.path}`} className="diff-file">
            <button className="diff-filehead" onClick={() => toggle(f.path)}>
              <span className={`chev${shut ? " closed" : ""}`}><ChevronDown size={14} /></span>
              <span className="dfh-path">{f.path}</span>
              <span className="dfh-counts"><span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span></span>
            </button>
            {!shut && (
              <pre className="diff-pre">
                {f.lines.map((l, i) => {
                  if (l.kind === "hunk") return <div key={i} className="diff-line diff-hunk">{l.text}</div>;
                  const lineKey = `${f.path}#${i}`;
                  const threads = review ? review.comments.filter((c) => c.key === lineKey) : [];
                  return (
                    <div key={i}>
                      <div className={`diff-line diff-${l.kind}${review ? " commentable" : ""}`}>
                        <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                        <span className="diff-code"><CodeLine code={l.text} lang={lang} /></span>
                      </div>
                      {threads.map((c) => (
                        <div key={c.id} className="diff-comment">
                          <span className="dc-text">{c.text}</span>
                          <button className="dc-del" title="Remove" onClick={() => review!.onRemove(c.id)}>×</button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </pre>
            )}
          </section>
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
  const [commits, setCommits] = useState<Array<{ hash: string; date: string; author: string; subject: string }>>([]);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [mainView, setMainView] = useState<ReactNode>(<p className="hint">Pick a file to preview it, or a commit to see its diff.</p>);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void repoGet<{ branches: string[]; current: string }>("branches").then(setBranches).catch(() => {});
    void repoGet<{ files: string[] }>("tree").then((r) => setFiles(r.files)).catch(() => {});
    if (initialFile) void openFile(initialFile);
  }, []);
  useEffect(() => {
    if (tab === "history") void repoGet<{ commits: typeof commits }>("log").then((r) => setCommits(r.commits)).catch(() => {});
  }, [tab]);

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
    const { diff } = await repoGet<{ diff: string }>("diff", { commit: hash });
    setMainView(<><div className="repo-file-bar">Commit {hash}</div><Diff text={diff} /></>);
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
      </div>
      <div className="repo-body">
        <div className="repo-side">
          {tab === "files"
            ? <FileTree paths={files} onOpen={(p) => void openFile(p)} activePath={activePath} />
            : commits.map((c) => (
              <button key={c.hash} className="commit-row" onClick={() => void openDiff(c.hash)}>
                <div className="commit-subject">{c.subject}</div>
                <div className="commit-meta">{c.hash} · {c.author} · {c.date}</div>
              </button>
            ))}
        </div>
        <div className="repo-main">{mainView}</div>
      </div>
    </Modal>
  );
}
