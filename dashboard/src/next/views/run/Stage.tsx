/** The stage on the right of Run & preview: the Output of whatever is selected
 *  (an action, a service's server log, the onboarding or provisioning agent),
 *  or the Preview — a live capsule service when one is selected, otherwise the
 *  project's own dev server / static site (classic "Live preview"). */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Camera } from "lucide-react";
import { api } from "../../../api.js";
import type { CapsuleView } from "../../../types.js";
import { useWarden } from "../../data.js";
import { ExternalLink, Monitor, RefreshCw, Terminal } from "../../icons.js";
import { Btn, Empty, Seg, Spinner } from "../../ui.js";
import { ConfirmBtn } from "../prs/ConfirmBtn.js";
import type { Cockpit } from "./useCapsule.js";
import type { Preview } from "./usePreview.js";

export type StageTab = "output" | "preview";
/** An action id, or one of the agent jobs. */
export type StageTarget = string | null;

/** A log that follows its tail while you're at the bottom, and stays put when you scroll up. */
function Log({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLPreElement | null>(null);
  const pinned = useRef(true);
  useEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [text]);
  return (
    <pre ref={ref} className="rn-log rn-stage-log" tabIndex={0} aria-label="Output"
      onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {text}
    </pre>
  );
}

function Frame({ url, title, children }: { url: string; title: string; children?: JSX.Element }): JSX.Element {
  const [key, setKey] = useState(0);
  return (
    <div className="rn-frame-wrap">
      <div className="row rn-framebar">
        <span className="mono rn-url" title={url}>{url}</span>
        <div className="spacer" />
        <Btn small kind="ghost" onClick={() => setKey((k) => k + 1)}><RefreshCw size={13} /> Refresh</Btn>
        {children}
        <Btn small kind="ghost" onClick={() => { window.open(url, "_blank"); }}><ExternalLink size={13} /> Open in tab</Btn>
      </div>
      <iframe key={key} className="rn-frame" src={url} title={title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  );
}

function ProjectPreview({ p }: { p: Preview }): JSX.Element {
  const w = useWarden();
  const [showLog, setShowLog] = useState(false);
  if (p.problem) return <div className="rn-stage-pad"><p className="rp-note">{p.problem}</p></div>;
  if (p.state === "ready" && p.url) {
    return (
      <>
        <Frame url={p.url} title="Live preview">
          <>
            <Btn small kind="ghost" onClick={() => { window.open(api("/api/preview/shot"), "_blank"); }}
              title="Capture a screenshot of the running app"><Camera size={13} /> Full shot</Btn>
            {p.output && <Btn small kind="ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide log" : "Server log"}</Btn>}
            <ConfirmBtn confirm="Stop the server?" onConfirm={p.stop}>Stop</ConfirmBtn>
          </>
        </Frame>
        {showLog && <Log text={p.output} />}
      </>
    );
  }
  if (p.state === "starting") {
    return (
      <div className="stack rn-stage-pad">
        <div className="row"><Spinner /><span>{p.kind === "static" ? "Serving the site…" : "Booting the dev server… the first start can take a moment."}</span></div>
        {p.output && <Log text={p.output} />}
      </div>
    );
  }
  if (p.kind === null) return <div className="rp-center"><Spinner /></div>;
  if (p.kind === "none") {
    return (
      <Empty icon={<Monitor size={22} />} title="Nothing to preview"
        action={<Btn onClick={() => w.go("repo")}>Browse the files</Btn>}>
        This isn't a web project Warden can serve — no dev/start script in package.json and no index.html.
      </Empty>
    );
  }
  return (
    <div className="stack rn-stage-pad">
      <Empty icon={<Monitor size={22} />} title={p.state === "error" ? "The preview couldn't start" : "Preview the app"}
        action={<Btn kind="fill" onClick={p.start}>{p.state === "error" ? "Try again" : "Start preview"}</Btn>}>
        {p.kind === "web"
          ? <>Runs <span className="mono">npm run {p.script || "dev"}</span> in the repository and shows the app here.</>
          : <>Serves the repository's static site and shows it here.</>}
      </Empty>
      {p.state === "error" && p.output && <Log text={p.output} />}
    </div>
  );
}

export function Stage({ c, view, preview, target, tab, setTab }: {
  c: Cockpit; view: CapsuleView | null; preview: Preview; target: StageTarget; tab: StageTab; setTab: (t: StageTab) => void;
}): JSX.Element {
  const action = target ? view?.capsule?.actions.find((a) => a.id === target) : undefined;
  const liveSvc = action?.service ? (c.svc[action.id] ?? view?.services[action.id]) : undefined;

  let title = "Output", sub = "", text = "";
  if (target === "__generate__") { title = "Onboarding agent"; text = c.gen?.output ?? ""; }
  else if (target === "__provision__") { title = "Provisioning agent"; text = c.prov?.output ?? ""; }
  else if (action) {
    title = action.label;
    sub = action.steps.map((s) => s.run).join("  &&  ");
    text = action.service ? c.svcOut[action.id] ?? "" : c.logs[action.id] ?? view?.runs[action.id]?.output ?? "";
  }

  return (
    <section className="card rn-stage" aria-label="Output and preview">
      <div className="row rn-stage-head">
        <b>{tab === "output" ? title : liveSvc?.url ? action?.label : "Live preview"}</b>
        {tab === "output" && sub && <span className="mono faint rn-cmd" title={sub}>{sub}</span>}
        <div className="spacer" />
        <Seg label="Stage" value={tab} onChange={setTab}
          options={[{ value: "output", label: <><Terminal size={13} /> Output</> }, { value: "preview", label: <><Monitor size={13} /> Preview</> }]} />
      </div>
      <div className="rn-stage-body">
        {tab === "preview"
          ? liveSvc?.state === "live" && liveSvc.url
            ? <Frame url={liveSvc.url} title={action?.label ?? "Service"} />
            : <ProjectPreview p={preview} />
          : text
            ? <Log text={text} />
            : <p className="hint rn-stage-pad">{target ? "No output yet — it appears here as it runs." : "Run an action on the left and its output streams here."}</p>}
      </div>
    </section>
  );
}
