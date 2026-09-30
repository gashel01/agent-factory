/** The supervisor panel: the right-hand side panel every page's top bar toggles.
 *  Three tabs — Chat (talk to the supervisor, what needs you, the narrated run
 *  history), Map (the living architecture: system map, sketch board, the
 *  agents' world-model, your notes) and Shared (how the agents coordinate).
 *
 *  The chat state and the observation feed live here, not in the Chat tab, so
 *  switching to Map mid-answer doesn't drop the "thinking" indicator or refetch
 *  the thread. The left edge drags to resize (or arrow keys on the handle); the
 *  width is remembered per browser, like the classic rail's. */

import { useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent } from "react";
import { useCompanion } from "../../../core.js";
import { useWarden } from "../../data.js";
import { X } from "../../icons.js";
import { IconBtn, Seg } from "../../ui.js";
import { ChatTab } from "./ChatTab.js";
import { MapTab } from "./MapTab.js";
import { SharedTab } from "./SharedTab.js";
import { useSupervisorChat } from "./useSupervisorChat.js";

type Tab = "chat" | "map" | "shared";

const TAB_KEY = "warden.next.supervisor.tab";
const WIDTH_KEY = "warden.next.supervisor.width";
const MIN_W = 320, MAX_W = 760, KEY_STEP = 24;

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "map" || v === "shared" ? v : "chat";
  } catch { return "chat"; }
}
function readWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= MIN_W && v <= MAX_W ? v : null;
  } catch { return null; }
}
const clampW = (v: number): number => Math.round(Math.max(MIN_W, Math.min(MAX_W, v, window.innerWidth - 120)));

export function SupervisorPanel(): JSX.Element {
  const w = useWarden();
  const companion = useCompanion(w.ws);
  const chat = useSupervisorChat(w.ws);
  const [tab, setTabState] = useState<Tab>(readTab);
  const [width, setWidthState] = useState<number | null>(readWidth);

  const setTab = (t: Tab): void => {
    setTabState(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ }
  };
  const setWidth = (v: number): void => {
    const next = clampW(v);
    setWidthState(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* private mode */ }
  };

  // Drag the left edge: the panel sits on the right, so moving left widens it.
  const onResizeDown = (e: RPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget.parentElement?.getBoundingClientRect().width) ?? 360;
    const onMove = (ev: PointerEvent): void => setWidth(startW - (ev.clientX - startX));
    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
  };
  const onResizeKey = (e: RKeyboardEvent<HTMLDivElement>): void => {
    const cur = width ?? e.currentTarget.parentElement?.getBoundingClientRect().width ?? 360;
    if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(cur + KEY_STEP); }
    if (e.key === "ArrowRight") { e.preventDefault(); setWidth(cur - KEY_STEP); }
  };

  return (
    <aside className="supervisor-panel sv-panel" aria-label="Supervisor"
      style={width ? ({ "--panel": `${width}px` } as CSSProperties) : undefined}>
      <div className="sv-resize" role="separator" aria-orientation="vertical" aria-label="Resize the supervisor panel"
        aria-valuemin={MIN_W} aria-valuemax={MAX_W} aria-valuenow={width ?? undefined} tabIndex={0}
        onPointerDown={onResizeDown} onKeyDown={onResizeKey} onDoubleClick={() => { setWidthState(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* ok */ } }} />
      <header className="sv-head">
        <h2 className="sv-title">Supervisor</h2>
        <Seg label="Supervisor view" value={tab} onChange={setTab}
          options={[{ value: "chat", label: "Chat" }, { value: "map", label: "Map" }, { value: "shared", label: "Shared" }]} />
        <IconBtn label="Close the supervisor" small onClick={() => w.setSupervisorOpen(false)}><X size={16} /></IconBtn>
      </header>
      <div className="sv-body" hidden={tab !== "chat"}><ChatTab obs={companion.obs} chat={chat} /></div>
      {tab === "map" && <div className="sv-body"><MapTab /></div>}
      {tab === "shared" && <div className="sv-body"><SharedTab /></div>}
    </aside>
  );
}
