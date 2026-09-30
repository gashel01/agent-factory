/** Command palette (Ctrl+K): every page, every run action, every ticket and
 *  project, reachable by typing. */

import { useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  BookOpen, GitBranch, GitPullRequest, Layers, Moon, Pause, Play, Plus, Rocket, Search, Settings2, Sparkles,
  Square, Sun, TrendingDown,
} from "../icons.js";
import { fuzzyMatch, sendControl } from "../../control.js";
import { useWarden } from "../data.js";
import { Dialog, StateTag } from "../ui.js";

interface Cmd { id: string; group: string; label: string; hint?: ReactNode; icon?: ReactNode; run: () => void }

export function Palette(): JSX.Element {
  const w = useWarden();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const commands = useMemo<Cmd[]>(() => {
    const act: Cmd[] = [
      { id: "new", group: "Actions", label: "New work", hint: <span className="kbd">N</span>, icon: <Plus size={17} />, run: () => w.open({ type: "newwork" }) },
    ];
    if (w.live) {
      act.push(w.model.manualPause || w.model.ratePause
        ? { id: "resume", group: "Actions", label: "Resume the run", icon: <Play size={17} />, run: () => void sendControl("resume") }
        : { id: "pause", group: "Actions", label: "Pause the run", icon: <Pause size={17} />, run: () => void sendControl("pause") });
      act.push({ id: "stop", group: "Actions", label: "Stop the run", icon: <Square size={17} />, run: () => void sendControl("stop") });
    } else if (w.willRun > 0) {
      act.push({ id: "run", group: "Actions", label: `${w.rerunnable ? "Run again" : "Run"} — ${w.willRun} ticket${w.willRun > 1 ? "s" : ""}`, hint: "estimate first", icon: <Play size={17} />, run: () => w.open({ type: "runestimate", tickets: w.willRun }) });
    }
    const pages: Cmd[] = [
      { id: "p-board", group: "Go to", label: "Board", icon: <Layers size={17} />, run: () => w.go("board") },
      { id: "p-prs", group: "Go to", label: "Pull requests", icon: <GitPullRequest size={17} />, run: () => w.go("prs") },
      { id: "p-auto", group: "Go to", label: "Autopilot", icon: <Rocket size={17} />, run: () => w.go("autopilot") },
      { id: "p-repo", group: "Go to", label: "Repository", icon: <GitBranch size={17} />, run: () => w.go("repo") },
      { id: "p-know", group: "Go to", label: "Knowledge", icon: <BookOpen size={17} />, run: () => w.go("knowledge") },
      { id: "p-run", group: "Go to", label: "Run & preview", icon: <Play size={17} />, run: () => w.go("run") },
      { id: "p-ins", group: "Go to", label: "Insights", icon: <TrendingDown size={17} />, run: () => w.go("insights") },
      { id: "p-mem", group: "Go to", label: "Memory", icon: <Sparkles size={17} />, run: () => w.go("memory") },
      { id: "p-proj", group: "Go to", label: "All projects", icon: <Layers size={17} />, run: () => w.go("projects") },
      { id: "p-set", group: "Go to", label: "Settings", icon: <Settings2 size={17} />, run: () => w.go("settings") },
    ];
    const toggles: Cmd[] = [
      { id: "sup", group: "Toggle", label: w.supervisorOpen ? "Close the supervisor" : "Open the supervisor", run: () => w.setSupervisorOpen(!w.supervisorOpen) },
      { id: "theme", group: "Toggle", label: w.resolvedTheme === "dark" ? "Light theme" : "Dark theme", icon: w.resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />, run: () => w.setTheme(w.resolvedTheme === "dark" ? "light" : "dark") },
      { id: "classic", group: "Toggle", label: "Classic interface", run: () => { location.href = "/"; } },
    ];
    const tickets: Cmd[] = w.visible.map((t) => ({
      id: `t-${t.id}`, group: "Tickets", label: `${t.id} ${t.title}`, hint: <StateTag state={t.state} />,
      run: () => w.open({ type: "ticket", taskId: t.id }),
    }));
    const projects: Cmd[] = w.workspaces.filter((p) => p.name !== w.ws).map((p) => ({
      id: `w-${p.name}`, group: "Switch project", label: p.name, icon: <Layers size={17} />, run: () => w.switchWs(p.name),
    }));
    return [...act, ...pages, ...toggles, ...tickets, ...projects];
  }, [w.live, w.willRun, w.rerunnable, w.model.manualPause, w.model.ratePause, w.supervisorOpen, w.resolvedTheme, w.visible, w.workspaces, w.ws]);

  const shown = q.trim() ? commands.filter((c) => fuzzyMatch(q, `${c.group} ${c.label}`)) : commands;
  const pick = (c: Cmd | undefined): void => { if (!c) return; w.close(); c.run(); };

  let lastGroup = "";
  return (
    <Dialog label="Command palette" onClose={w.close}>
      <div className="palette-input">
        <Search size={18} />
        <input aria-label="Command or search" placeholder="Type a command, a page, a ticket…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(shown[sel]); }
          }} />
      </div>
      <div className="palette-list" role="listbox" aria-label="Results">
        {shown.length === 0 && <p className="hint" style={{ padding: 16 }}>Nothing matches “{q}”.</p>}
        {shown.map((c, i) => {
          const head = c.group !== lastGroup ? <span className="label palette-group">{c.group}</span> : null;
          lastGroup = c.group;
          return (
            <div key={c.id}>
              {head}
              <button type="button" role="option" className="menu-item" aria-selected={i === sel}
                onMouseEnter={() => setSel(i)} onClick={() => pick(c)}>
                {c.icon ?? <span style={{ width: 17 }} />}{c.label}
                {c.hint && <span className="menu-item-hint">{c.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="palette-foot"><span>↑↓ navigate</span><span>↵ run</span><span>esc close</span></div>
    </Dialog>
  );
}
