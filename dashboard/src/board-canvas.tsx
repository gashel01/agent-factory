import { useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as RPointerEvent } from "react";
import { fetchJSON } from "./api.js";
import { toast } from "./core.js";
import { Modal } from "./widgets.js";
import {
  Database, Layers, MousePointer2, Square, StickyNote, ArrowUpRight, Trash2,
} from "./icons.js";

/** The shared sketch board — piece 3 of the collaborative supervisor. A spatial
 *  canvas with two layers on one surface: the HUMAN layer (freehand shapes you
 *  draw to sketch architecture or annotate) and the AGENT layer (system nodes you
 *  drop from the world-model the agents maintain). Zero-dependency: plain SVG +
 *  pointer events, persisted whole to <workspace>/board.json. */

type Tool = "select" | "rect" | "db" | "sticky" | "arrow";
type Layer = "human" | "agent";

interface BoxShape {
  id: string; kind: "rect" | "db" | "sticky"; layer: Layer;
  x: number; y: number; w: number; h: number; text?: string;
}
interface ArrowShape {
  id: string; kind: "arrow"; layer: Layer;
  x1: number; y1: number; x2: number; y2: number;
}
type Shape = BoxShape | ArrowShape;

const CANVAS_W = 2400;
const CANVAS_H = 1600;
const MIN_SIZE = 14;  // below this a drag is treated as a click, not a new shape

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Square }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "rect", label: "Box", icon: Square },
  { id: "db", label: "Database", icon: Database },
  { id: "sticky", label: "Sticky note", icon: StickyNote },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
];

const uid = (): string => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const isBox = (s: Shape): s is BoxShape => s.kind !== "arrow";

interface Drag {
  mode: "create" | "move";
  id: string;
  ox: number; oy: number;              // pointer origin
  orig: Shape;                         // shape at drag start
}

export function BoardModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<Drag | null>(null);

  // Load once.
  useEffect(() => {
    void fetchJSON<{ shapes: Shape[] }>("/api/board")
      .then((d) => setShapes(Array.isArray(d.shapes) ? d.shapes : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Persist (debounced) after the first load, never echoing the initial GET back.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      void fetchJSON("/api/board", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ shapes }),
      }).catch(() => {});
    }, 500);
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
      : { id, kind: tool, layer: "human", x, y, w: 0, h: 0,
          text: tool === "sticky" ? "" : undefined };
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
        const nx = Math.min(d.ox, x), ny = Math.min(d.oy, y);
        return { ...s, x: nx, y: ny, w: Math.abs(x - d.ox), h: Math.abs(y - d.oy) };
      }
      // move
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
    if (!d) return;
    if (d.mode === "create") {
      // Discard a shape too small to be intentional (a click, not a drag).
      setShapes((list) => list.filter((s) => {
        if (s.id !== d.id) return true;
        if (s.kind === "arrow") return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= MIN_SIZE;
        return s.w >= MIN_SIZE && s.h >= MIN_SIZE;
      }).map((s) => {
        // Give boxes a sensible minimum so text fits.
        if (s.id === d.id && isBox(s)) return { ...s, w: Math.max(s.w, 120), h: Math.max(s.h, 56) };
        return s;
      }));
      setTool("select");
    }
  };

  const remove = (id: string): void => {
    setShapes((s) => s.filter((x) => x.id !== id));
    if (selected === id) setSelected(null);
  };

  const setText = (id: string, text: string): void =>
    setShapes((s) => s.map((x) => (x.id === id && isBox(x) ? { ...x, text } : x)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (editing) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault(); remove(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editing]);

  const dropSystemMap = async (): Promise<void> => {
    try {
      const d = await fetchJSON<{ map: { symbols: Array<{ name: string; file: string }> } }>("/api/architecture");
      const syms = d.map?.symbols ?? [];
      const have = new Set(shapes.filter((s) => s.layer === "agent" && isBox(s)).map((s) => (s as BoxShape).text));
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

  return (
    <Modal title="Board — sketch the system together" onClose={onClose} wide>
      <div className="bd">
        <div className="bd-toolbar">
          <div className="bd-tools">
            {TOOLS.map((t) => (
              <button key={t.id} type="button" title={t.label} aria-label={t.label}
                className={`bd-tool${tool === t.id ? " is-on" : ""}`} onClick={() => setTool(t.id)}>
                <t.icon size={15} />
              </button>
            ))}
          </div>
          <div className="bd-spacer" />
          <button type="button" className="bd-drop" onClick={() => void dropSystemMap()}
            title="Place the symbols your agents maintain onto the canvas, as movable nodes">
            <Layers size={14} /> Drop system map
          </button>
          {selected && (
            <button type="button" className="bd-del" onClick={() => remove(selected)} title="Delete selected (Del)">
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>

        <div className="bd-scroll">
          <svg ref={svgRef} className="bd-svg" width={CANVAS_W} height={CANVAS_H}
            onPointerDown={onDownCanvas} onPointerMove={onMove} onPointerUp={onUp}>
            <defs>
              <marker id="bd-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3"
                orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,3 L0,6 Z" className="bd-arrowhead" />
              </marker>
              <pattern id="bd-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" className="bd-dot" />
              </pattern>
            </defs>
            <rect width={CANVAS_W} height={CANVAS_H} fill="url(#bd-grid)" />
            {shapes.map((s) => (
              <ShapeView key={s.id} s={s} selected={selected === s.id} editing={editing === s.id}
                onDown={(e) => onDownShape(e, s)}
                onEdit={() => { if (isBox(s)) { setTool("select"); setSelected(s.id); setEditing(s.id); } }}
                onText={(v) => setText(s.id, v)} onBlur={() => setEditing(null)} />
            ))}
          </svg>
        </div>

        <p className="bd-hint">
          Pick a shape, drag to draw. Double-click a box to label it. Your sketch and the system
          nodes both persist — reopen and they're here.
        </p>
      </div>
    </Modal>
  );
}

function ShapeView(
  { s, selected, editing, onDown, onEdit, onText, onBlur }:
  { s: Shape; selected: boolean; editing: boolean;
    onDown: (e: RPointerEvent) => void; onEdit: () => void;
    onText: (v: string) => void; onBlur: () => void },
): JSX.Element {
  const cls = `bd-shape bd-${s.kind} layer-${s.layer}${selected ? " is-sel" : ""}`;
  if (s.kind === "arrow") {
    return (
      <g className={cls} onPointerDown={onDown}>
        {/* fat invisible hit line so a thin arrow is easy to grab */}
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="bd-hit" />
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="bd-arrow-line" markerEnd="url(#bd-arrow)" />
      </g>
    );
  }
  const { x, y, w, h } = s;
  const ry = Math.min(h * 0.16, 14);
  return (
    <g className={cls} onPointerDown={onDown} onDoubleClick={onEdit}>
      {s.kind === "db"
        ? (
          <>
            <path className="bd-fill"
              d={`M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry}`} />
            <ellipse className="bd-fill bd-rim" cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} />
          </>
        )
        : <rect className="bd-fill" x={x} y={y} width={w} height={h} rx={s.kind === "sticky" ? 3 : 9} />}
      <foreignObject x={x} y={y} width={w} height={h}>
        {editing
          ? (
            <textarea className="bd-edit" autoFocus defaultValue={s.text ?? ""}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => onText(e.target.value)} onBlur={onBlur} />
          )
          : <div className="bd-text">{s.text}</div>}
      </foreignObject>
      {selected && <rect className="bd-sel-ring" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={11} />}
    </g>
  );
}
