import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Appearance } from "./screens-theme.js";
import { AppearanceButton } from "./screens-appearance.js";
import { MessageCircle, ArrowUp, Bot } from "./icons.js";
import { fetchJSON, postJSON } from "./api.js";
import { AttachStrip, toast, useAttachments } from "./core.js";

/** The slim sticky bar shared by the Projects and Memory screens. */
export function AppBar(
  { active, factCount, narrow, newLabel, theme, onProjects, onMemory, onNew, onAppearance }:
  {
    active: "projects" | "memory"; factCount?: number; narrow?: boolean; newLabel: string;
    theme: Appearance;
    onProjects: () => void; onMemory: () => void; onNew: () => void; onAppearance: () => void;
  },
): JSX.Element {
  return (
    <header className="appbar">
      <div className={`appbar-inner${narrow ? " narrow" : ""}`}>
        <div className="brand">
          <div className="brand-logo"><i /></div>
          <div className="brand-txt">
            <span className="brand-name">Warden</span>
            <span className="brand-sub">Local execution</span>
          </div>
        </div>
        <div className="nav-pills">
          <button className={`nav-pill${active === "projects" ? " on" : ""}`} onClick={onProjects}>Projects</button>
          <button className={`nav-pill${active === "memory" ? " on" : ""}`} onClick={onMemory}>
            Memory{factCount !== undefined && <span className="nav-count">{factCount}</span>}
          </button>
        </div>
        <div className="spacer" />
        <AppearanceButton onOpen={onAppearance} />
        <button className="hbtn accent" onClick={onNew}><span className="plus">+</span> {newLabel}</button>
      </div>
    </header>
  );
}

/** Persistent steering composer docked at the board's edge when the supervisor
 *  rail is closed — the always-on channel to direct the run, surfaced instead of
 *  hidden behind an icon. Sends to the supervisor and opens the rail so the
 *  streamed reply (and its one-click suggestions) is immediately in view. */
export function SupervisorDock({ onExpand }: { onExpand: () => void }): JSX.Element {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const att = useAttachments();
  const send = async (): Promise<void> => {
    const text = msg.trim();
    if ((!text && !att.items.length) || busy) return;
    setBusy(true);
    try {
      await postJSON("/api/chat", { message: text + att.refs() });
      setMsg("");
      att.clear();
      onExpand();
    } catch (err) {
      toast(String(err), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sup-dock-wrap" onDrop={att.drop} onDragOver={(e) => e.preventDefault()}>
      <AttachStrip items={att.items} onRemove={att.remove} />
      <div className="sup-dock">
        <button className="sup-dock-open" title="Open the supervisor" aria-label="Open the supervisor" onClick={onExpand}>
          <MessageCircle size={16} />
        </button>
        <input className="sup-dock-input" value={msg} placeholder="Tell the supervisor (paste an image too)…"
          onChange={(e) => setMsg(e.target.value)} onPaste={att.paste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="sup-dock-send" disabled={(!msg.trim() && !att.items.length) || busy} onClick={() => void send()} aria-label="Send to the supervisor">
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

/** Which coding-agent CLI the cockpit is driving, probed server-side once. Stays
 *  hidden when the CLI isn't on PATH (nothing to show, no error noise). */
export function AgentVersionChip(): JSX.Element | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    fetchJSON<{ agentVersion?: string | null }>("/api/status")
      .then((s) => setV(s.agentVersion ?? null)).catch(() => setV(null));
  }, []);
  if (!v) return null;
  const label = v.replace(/^v/, "");
  return (
    <span className="agent-ver mono" title="The coding-agent CLI this cockpit drives">
      <Bot size={12} /> Claude Code v{label}
    </span>
  );
}
