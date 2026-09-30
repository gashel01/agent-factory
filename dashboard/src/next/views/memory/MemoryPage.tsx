/** Memory: the lessons Warden learned — each one written from a ticket and
 *  handed to the next agents that need it, so the same mistake isn't made
 *  twice. Search, filter by where a lesson applies, add, edit, delete. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useWarden } from "../../data.js";
import { Brain, Plus, Search } from "../../icons.js";
import { Btn, Empty, Seg } from "../../ui.js";
import { Topbar } from "../../shell/Topbar.js";
import { LessonCard } from "./LessonCard.js";
import { LessonEditor } from "./LessonEditor.js";
import { useFacts } from "./facts.js";
import type { Fact } from "./facts.js";

type Filter = "all" | "global" | "project";

export function MemoryPage(): JSX.Element {
  const w = useWarden();
  const { facts, reload } = useFacts(w.ws);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Filter>("all");
  const [editing, setEditing] = useState<Fact | "new" | null>(null);

  // A lesson may be added through the overlay (from a ticket, the palette):
  // pick it up when that closes.
  useEffect(() => { if (w.overlay === null) reload(); }, [w.overlay]);

  const all = facts ?? [];
  const needle = q.trim().toLowerCase();
  const filtered = all.filter((f) => {
    if (scope !== "all" && f.scope !== scope) return false;
    if (needle && !(f.text.toLowerCase().includes(needle) || (f.ticketId ?? "").toLowerCase().includes(needle))) return false;
    return true;
  });
  const globalCount = all.filter((f) => f.scope === "global").length;
  const usedTotal = all.reduce((s, f) => s + (f.applied ?? 0), 0);
  const sub = facts === null ? undefined
    : `${all.length} lesson${all.length === 1 ? "" : "s"} · ${globalCount} global`
      + (usedTotal > 0 ? ` · applied ${usedTotal}× to later tickets` : "");

  return (
    <>
      <Topbar title="Memory" sub={sub}>
        <Btn kind="fill" onClick={() => setEditing("new")}><Plus size={15} /> New lesson</Btn>
      </Topbar>
      <div className="view narrow">
        <p className="hint mem-lead">
          Each lesson is learned from a ticket and handed to the next agents that need it — so the same mistake
          isn’t made twice.
        </p>
        <div className="row mem-toolbar">
          <label className="search-field mem-search">
            <Search size={15} />
            <input placeholder="Search a lesson or a ticket…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lessons" />
          </label>
          <Seg label="Where lessons apply" value={scope} onChange={setScope}
            options={[{ value: "all", label: "All" }, { value: "global", label: "Global" }, { value: "project", label: "This project" }]} />
        </div>

        {facts === null ? (
          <div className="stack" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton mem-skeleton" />)}
          </div>
        ) : filtered.length === 0 ? (
          all.length === 0 ? (
            <Empty icon={<Brain size={22} />} title="No lessons yet"
              action={<Btn onClick={() => setEditing("new")}><Plus size={15} /> Add the first lesson</Btn>}>
              When an agent hits a wall, record the fix here so it never happens twice.
            </Empty>
          ) : (
            <Empty title="No lessons match this filter" />
          )
        ) : (
          <div className="stack mem-list">
            {filtered.map((f) => <LessonCard key={f.id} f={f} onEdit={() => setEditing(f)} />)}
          </div>
        )}
      </div>
      {editing && (
        <LessonEditor fact={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />
      )}
    </>
  );
}
