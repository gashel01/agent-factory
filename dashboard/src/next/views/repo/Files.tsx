/** The Files tab: the tree on the left, the open file on the right. The open
 *  file lives in the URL (#/repo/<path>), so a hotspot link, a reload or the
 *  phone lands on the same file. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toast } from "../../../core.js";
import { FileCode } from "../../icons.js";
import { Btn, Empty, Spinner } from "../../ui.js";
import { CodeFile } from "./Code.js";
import { FileTree } from "./FileTree.js";
import { plainError } from "./errors.js";
import { repoFetch } from "./project-repo.js";

/** Open a file in the local editor — VS Code's URL handler, as the classic modal did. */
function ideUrl(repo: string, path: string): string {
  return `vscode://file/${repo.replace(/\\/g, "/")}/${path}`;
}

export function Files({ repo, path, files, onOpen, branch }: {
  repo: string; path: string; files: string[]; onOpen: (p: string) => void; branch: string;
}): JSX.Element {
  const [file, setFile] = useState<{ content: string; error: string } | null>(null);

  useEffect(() => {
    if (!path) { setFile(null); return; }
    let alive = true;
    setFile(null);
    repoFetch<{ content: string }>(repo, "file", { path })
      .then((r) => { if (alive) setFile({ content: r.content, error: "" }); })
      .catch((e) => { if (alive) setFile({ content: "", error: plainError(e, "Couldn't open this file.").text }); });
    return () => { alive = false; };
  }, [repo, path, branch]);

  const lines = file && !file.error ? file.content.split("\n").length : 0;
  return (
    <div className="rp-split">
      <FileTree files={files} active={path} onOpen={onOpen} />
      <section className="stack rp-main">
        {!path ? (
          <Empty icon={<FileCode size={22} />} title="Pick a file">
            Files are read from the checked-out branch{branch ? <> (<span className="mono">{branch}</span>)</> : null}, as committed.
          </Empty>
        ) : (
          <>
            <div className="rp-filebar">
              <span className="mono rp-filebar-path" title={path}>{path}</span>
              {lines > 0 && <span className="faint rp-small">{lines.toLocaleString()} lines</span>}
              <div className="spacer" />
              <Btn small kind="ghost" onClick={() => navigator.clipboard.writeText(path).then(() => toast("Path copied."), () => toast("Couldn't copy — select the path instead.", true))}>Copy path</Btn>
              <Btn small onClick={() => { window.location.href = ideUrl(repo, path); }}>Open in IDE</Btn>
            </div>
            {file === null ? <div className="rp-center"><Spinner /></div>
              : file.error ? <p className="rp-note">{file.error}</p>
                : <CodeFile content={file.content} path={path} />}
          </>
        )}
      </section>
    </div>
  );
}
