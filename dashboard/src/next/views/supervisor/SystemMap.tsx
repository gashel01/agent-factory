/** The system map: a dependency diagram of the codebase, derived live from the
 *  repo (/api/architecture → graph). Nodes are source files classified by role,
 *  placed in left-to-right layers by import depth; edges are "imports". Wheel
 *  zooms around the cursor, dragging the empty canvas pans, clicking a node
 *  isolates its flow (everything it depends on and everything depending on it).
 *
 *  Same layout algorithm as the classic ArchDiagram (bounded longest-path
 *  relaxation, so an import cycle can't spin), re-drawn in the new style. */

import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent, WheelEvent as RWheelEvent } from "react";
import type { ArchGraph, ArchNode } from "./types.js";

const KIND_LABEL: Record<string, string> = { entry: "Entry", ui: "UI", server: "Server", data: "Data", core: "Core" };
const KIND_ORDER = ["entry", "ui", "server", "core", "data"];

// Node/edge geometry (SVG units).
const NW = 168, NH = 40, HGAP = 60, VGAP = 16, PAD = 16, MAX_LAYER = 11;

function layout(graph: ArchGraph): { pos: Map<string, { x: number; y: number }>; edges: ArchGraph["edges"] } {
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const edges = graph.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < Math.min(ids.length, 24); pass++) {
    let moved = false;
    for (const e of edges) {
      const nl = Math.min((layer.get(e.from) ?? 0) + 1, MAX_LAYER);
      if (nl > (layer.get(e.to) ?? 0)) { layer.set(e.to, nl); moved = true; }
    }
    if (!moved) break;
  }
  const cols = new Map<number, ArchNode[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const l of [...cols.keys()].sort((a, b) => a - b)) {
    const col = cols.get(l)!.sort((a, b) =>
      (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || a.label.localeCompare(b.label));
    col.forEach((n, i) => pos.set(n.id, { x: PAD + l * (NW + HGAP), y: PAD + i * (NH + VGAP) }));
  }
  return { pos, edges };
}

/** Every node reachable from `start` following `adj`, start included. */
function reach(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    for (const m of adj.get(q.shift()!) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m); }
  }
  return seen;
}

export function SystemMap({ graph, big }: { graph: ArchGraph; big?: boolean }): JSX.Element {
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState({ k: big ? 1 : 0.7, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const empty = graph.nodes.length === 0;
  // React's wheel listener is passive: stop the panel from scrolling while the
  // wheel zooms the map with a native, non-passive one.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const hold = (e: WheelEvent): void => e.preventDefault();
    el.addEventListener("wheel", hold, { passive: false });
    return () => el.removeEventListener("wheel", hold);
  }, [empty]);
  if (empty) {
    return <p className="hint">No import graph yet — add source files and it draws itself.</p>;
  }
  const { pos, edges } = layout(graph);
  const home = { k: big ? 1 : 0.7, x: 0, y: 0 };

  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const onWheel = (e: RWheelEvent): void => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k2 = clamp(view.k * Math.exp(-e.deltaY * 0.0015), 0.25, 3);
    const wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
    setView({ k: k2, x: mx - wx * k2, y: my - wy * k2 });
  };
  const onDown = (e: RPointerEvent): void => {
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent): void => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.sx, dy = e.clientY - p.sy;
    if (!p.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    p.moved = true;
    setView((v) => ({ ...v, x: p.ox + dx, y: p.oy + dy }));
  };
  const onUp = (): void => {
    const p = pan.current;
    pan.current = null;
    if (p && !p.moved) setSel(null); // a click on the empty canvas clears the flow
  };

  const ids = graph.nodes.map((n) => n.id);
  const fwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  const bwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) { fwd.get(e.from)!.push(e.to); bwd.get(e.to)!.push(e.from); }
  const down = sel ? reach(sel, fwd) : null;
  const up = sel ? reach(sel, bwd) : null;
  const lit = (id: string): boolean => !sel || down!.has(id) || up!.has(id);
  const edgeLit = (e: { from: string; to: string }): boolean =>
    !sel || (down!.has(e.from) && down!.has(e.to)) || (up!.has(e.from) && up!.has(e.to));
  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
    const sx = a.x + NW, sy = a.y + NH / 2, tx = b.x, ty = b.y + NH / 2, mx = (sx + tx) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
  };
  const toggle = (id: string): void => setSel((s) => (s === id ? null : id));
  const onKey = (e: RKeyboardEvent, id: string): void => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(id); }
  };
  const moved = view.k !== home.k || view.x !== 0 || view.y !== 0;

  return (
    <div className={`sv-map${big ? " big" : ""}`}>
      <div className="sv-map-legend">
        {KIND_ORDER.map((k) => <span key={k} className={`sv-key kind-${k}`}><i aria-hidden="true" />{KIND_LABEL[k]}</span>)}
        {moved && <button type="button" className="sv-link" onClick={() => setView(home)}>Reset view</button>}
      </div>
      <p className="sv-map-note">
        {sel ? "Select the node again (or click the canvas) to clear." : "Select a node to isolate its flow · scroll to zoom, drag to pan."}
        {graph.truncated && ` Showing the ${graph.nodes.length} most-connected of ${graph.total} files.`}
      </p>
      <div className="sv-map-canvas">
        <svg ref={svgRef} width="100%" height="100%" className={`sv-map-svg${sel ? " has-sel" : ""}`}
          onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          <defs>
            <marker id={big ? "sv-ah-big" : "sv-ah"} markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" className="sv-map-ah" />
            </marker>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e, i) => (
              <path key={i} className={`sv-map-edge${sel ? (edgeLit(e) ? " is-lit" : " is-dim") : ""}`}
                d={edgePath(pos.get(e.from)!, pos.get(e.to)!)} markerEnd={`url(#${big ? "sv-ah-big" : "sv-ah"})`} />
            ))}
            {graph.nodes.map((n) => {
              const p = pos.get(n.id)!;
              const cls = `sv-map-node kind-${n.kind}${sel ? (lit(n.id) ? " is-lit" : " is-dim") : ""}${sel === n.id ? " is-sel" : ""}`;
              return (
                <g key={n.id} className={cls} transform={`translate(${p.x},${p.y})`} role="button" tabIndex={0}
                  aria-pressed={sel === n.id} aria-label={`${n.label} — ${sel === n.id ? "clear the highlighted flow" : "highlight its flow"}`}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); toggle(n.id); }} onKeyDown={(ev) => onKey(ev, n.id)}>
                  <title>{n.id}</title>
                  <rect width={NW} height={NH} rx={10} />
                  <rect className="sv-map-bar" width={4} height={NH} />
                  <text x={14} y={NH / 2} dominantBaseline="central" className="sv-map-label">
                    {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
