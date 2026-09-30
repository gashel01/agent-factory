/** The shared sketch board: a spatial canvas where you draw boxes, databases,
 *  sticky notes and arrows to sketch the system, and drop the symbols your
 *  agents maintain as movable nodes. Plain SVG + pointer events, persisted
 *  whole to /api/board (debounced), same contract as the classic BoardModal.
 *  Rendered in the large overlay — a 360px panel is too small to draw in. */

import { useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as RPointerEvent } from "react";
import { ArrowUpRight, Database, Layers, MousePointer2, Square, StickyNote, Trash2 } from "../../icons.js";
import { fetchJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { Btn, Spinner } from "../../ui.js";
import { BoardShape } from "./BoardShape.js";
import { Expand } from "./Expand.js";
import { isBox } from "./types.js";
import type { BoxShape, Shape } from "./types.js";

type Tool = "select" | "rect" | "db" | "sticky" | "arrow";

const CANVAS_W = 2400, CANVAS_H = 1600;
const MIN_SIZE = 14; // below this a drag is a click, not a new shape
const SAVE_DEBOUNCE_MS = 500;

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Square }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "rect", label: "Box", icon: Square },
  { id: "db", label: "Database", icon: Database },
  { id: "sticky", label: "Sticky note", icon: StickyNote },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
];

const uid = (): string => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

interface Drag { mode: "create" | "move"; id: string; ox: number; oy: number; orig: Shape }

export function SketchBoard({ onClose }: { onClose: () => void }): JSX.Element {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    void fetchJSON<{ shapes: Shape[] }>("/api/board")
      .then((d) => setShapes(Array.isArray(d.shapes) ? d.shapes : []))
      .catch(() => toast("Couldn't load the board — starting from an empty canvas.", true))
      .finally(() => setLoaded(true));
  }, []);

  // Persist after the first load, never echoing the initial GET back.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      void fetchJSON("/api/board", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ shapes }),
      }).catch(() => toast("Couldn't save the board — your last change may be lost.", true));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [shapes, loaded]);

  const at = (e: RPointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDownCanvas = (e: RPointerEvent): void => {
    if (editing) return;
    const { x, y } = at(e);
    if (tool === "select") { setSelected(null); return; }
    const id = uid();
    const shape: Shape = tool === "arrow"
      ? { id, kind: "arrow", layer: "human", x1: x, y1: y, x2: x, y2: y }
      : { id, kind: tool, layer: "human", x, y, w: 0, h: 0, text: tool === "sticky" ? "" : undefined };
    drag.current = { mode: "create", id, ox: x, oy: y, orig: shape };
    setShapes((s) => [...s, shape]);
    setSelected(id);
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  const onDownShape = (e: RPointerEvent, s: Shape): void => {
    if (tool !== "select" || editing) return;
    e.stopPropagation();
    const { x, y } = at(e);
    drag.current = { mode: "move", id: s.id, ox: x, oy: y, orig: s };
    setSelected(s.id);
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  const onMove = (e: RPointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = at(e);
    setShapes((list) => list.map((s) => {
      if (s.id !== d.id) return s;
      if (d.mode === "create") {
        if (s.kind === "arrow") return { ...s, x2: x, y2: y };
        return { ...s, x: Math.min(d.ox, x), y: Math.min(d.oy, y), w: Math.abs(x - d.ox), h: Math.abs(y - d.oy) };
      }
      const dx = x - d.ox, dy = y - d.oy;
      if (s.kind === "arrow" && d.orig.kind === "arrow") {
        return { ...s, x1: d.orig.x1 + dx, y1: d.orig.y1 + dy, x2: d.orig.x2 + dx, y2: d.orig.y2 + dy };
      }
      if (isBox(s) && isBox(d.orig)) return { ...s, x: d.orig.x + dx, y: d.orig.y + dy };
      return s;
    }));
  };

  const onUp = (): void => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.mode !== "create") return;
    // Drop a shape too small to be intentional; give boxes room for a label.
    setShapes((list) => list.filter((s) => {
      if (s.id !== d.id) return true;
      if (s.kind === "arrow") return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= MIN_SIZE;
      return s.w >= MIN_SIZE && s.h >= MIN_SIZE;
    }).map((s) => (s.id === d.id && isBox(s) ? { ...s, w: Math.max(s.w, 120), h: Math.max(s.h, 56) } : s)));
    setTool("select");
  };

  const remove = (id: string): void => {
    setShapes((s) => s.filter((x) => x.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
  };
  const setText = (id: string, text: string): void =>
    setShapes((s) => s.map((x) => (x.id === id && isBox(x) ? { ...x, text } : x)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (editing || !selected) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editing]);

  const dropSystemMap = async (): Promise<void> => {
    try {
      const d = await fetchJSON<{ map: { symbols: Array<{ name: string; file: string }> } }>("/api/architecture");
      const syms = d.map?.symbols ?? [];
      const have = new Set(shapes.filter((s): s is BoxShape => s.layer === "agent" && isBox(s)).map((s) => s.text));
      const fresh = syms.filter((s) => !have.has(s.name));
      if (fresh.length === 0) { toast("No new system nodes to drop — the map is already here or empty."); return; }
      const nodes: Shape[] = fresh.map((s, i) => ({
        id: uid(), kind: "rect", layer: "agent",
        x: 60 + (i % 5) * 230, y: 60 + Math.floor(i / 5) * 110, w: 200, h: 70, text: s.name,
      }));
      setShapes((prev) => [...prev, ...nodes]);
      toast(`Dropped ${nodes.length} system node${nodes.length === 1 ? "" : "s"} — arrange and annotate them.`);
    } catch (err) { toast(String(err), true); }
  };

  const tools = (
    <>
      <div className="seg" role="group" aria-label="Drawing tool">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tool === t.id} aria-label={t.label} title={t.label} onClick={() => setTool(t.id)}>
            <t.icon size={15} />
          </button>
        ))}
      </div>
      <Btn small onClick={dropSystemMap} title="Place the symbols your agents maintain onto the canvas, as movable nodes">
        <Layers size={14} /> Drop system map
      </Btn>
      {selected && <Btn small kind="danger" onClick={() => remove(selected)} title="Delete the selected shape (Del)"><Trash2 size={14} /> Delete</Btn>}
    </>
  );

  return (
    <Expand title="Sketch board" onClose={onClose} tools={tools}
      sub="Pick a shape, drag to draw. Double-click a box to label it. Everything persists — reopen and it's here.">
      {!loaded
        ? <div className="sv-center"><Spinner /></div>
        : (
          <div className="sv-bd-scroll">
            <svg ref={svgRef} className="sv-bd-svg" width={CANVAS_W} height={CANVAS_H}
              onPointerDown={onDownCanvas} onPointerMove={onMove} onPointerUp={onUp}>
              <defs>
                <marker id="sv-bd-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L8,3 L0,6 Z" className="sv-bd-head" />
                </marker>
                <pattern id="sv-bd-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" className="sv-bd-dot" />
                </pattern>
              </defs>
              <rect width={CANVAS_W} height={CANVAS_H} fill="url(#sv-bd-grid)" />
              {shapes.map((s) => (
                <BoardShape key={s.id} s={s} selected={selected === s.id} editing={editing === s.id}
                  onDown={(e) => onDownShape(e, s)}
                  onEdit={() => { if (isBox(s)) { setTool("select"); setSelected(s.id); setEditing(s.id); } }}
                  onText={(v) => setText(s.id, v)} onBlur={() => setEditing(null)} />
              ))}
            </svg>
          </div>
        )}
    </Expand>
  );
}
