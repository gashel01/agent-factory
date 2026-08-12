import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "./api.js";
import { FileText, Sparkles } from "./icons.js";
import { Skeleton, toast, Button } from "./core.js";
import { Modal } from "./widgets.js";

interface ArchGraphNode { id: string; label: string; kind: string; }
interface ArchGraphT {
  nodes: ArchGraphNode[];
  edges: Array<{ from: string; to: string }>;
  truncated: boolean;
  total: number;
}

interface ArchData {
  map: {
    symbols: Array<{ name: string; file: string }>;
    decisions: Array<{ key: string; value: string; ticket: string }>;
    files: Array<{ file: string; ticket: string }>;
  };
  notes: string;
  graph?: ArchGraphT;
}

const KIND_LABEL: Record<string, string> = {
  entry: "Entry", ui: "UI", server: "Server", data: "Data", core: "Core",
};
const KIND_ORDER = ["entry", "ui", "server", "core", "data"];

// Node/edge geometry for the layered diagram (all in SVG units).
const NW = 168, NH = 40, HGAP = 60, VGAP = 16, PAD = 16;

/** A dependency diagram of the codebase: nodes are source files (classified by
 *  role — entry / UI / server / core / data), placed in left-to-right layers by
 *  how deep in the import graph they sit, edges are "imports". Derived live from
 *  the repo, so it IS the architecture, not a drawing of it. Zero-dependency:
 *  the layering is a bounded longest-path relaxation, rendered as plain SVG. */
export function ArchDiagram({ graph }: { graph: ArchGraphT }): JSX.Element {
  const [sel, setSel] = useState<string | null>(null);
  if (graph.nodes.length === 0) {
    return <p className="hint">No import graph yet — add source files and it draws itself.</p>;
  }
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const edges = graph.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));

  // Layer = longest dependency depth. Relaxation, bounded so cycles can't spin.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const MAXL = 11;
  for (let pass = 0; pass < Math.min(ids.length, 24); pass++) {
    let moved = false;
    for (const e of edges) {
      const nl = Math.min((layer.get(e.from) ?? 0) + 1, MAXL);
      if (nl > (layer.get(e.to) ?? 0)) { layer.set(e.to, nl); moved = true; }
    }
    if (!moved) break;
  }

  // Group by layer, order each column by kind then name for a calm read.
  const cols = new Map<number, ArchGraphNode[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  const layers = [...cols.keys()].sort((a, b) => a - b);
  for (const l of layers) {
    const col = cols.get(l)!.sort((a, b) =>
      (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || a.label.localeCompare(b.label));
    col.forEach((n, i) => pos.set(n.id, { x: PAD + l * (NW + HGAP), y: PAD + i * (NH + VGAP) }));
    maxRows = Math.max(maxRows, col.length);
  }
  const width = PAD * 2 + (layers.length ? (Math.max(...layers) + 1) * (NW + HGAP) - HGAP : NW);
  const height = PAD * 2 + maxRows * (NH + VGAP) - VGAP;

  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
    const sx = a.x + NW, sy = a.y + NH / 2, tx = b.x, ty = b.y + NH / 2;
    const mx = (sx + tx) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
  };

  // Click a node to isolate its flow: everything it depends on (downstream) and
  // everything that depends on it (upstream), both transitively. Nodes and edges
  // off that flow dim away so the path stands out. Click it again — or the empty
  // canvas — to clear.
  const fwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  const bwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) { fwd.get(e.from)!.push(e.to); bwd.get(e.to)!.push(e.from); }
  const reach = (start: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const n = q.shift()!;
      for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m); }
    }
    return seen;
  };
  const down = sel ? reach(sel, fwd) : null;
  const up = sel ? reach(sel, bwd) : null;
  const flow = sel ? new Set([...down!, ...up!]) : null;
  const edgeLit = (e: { from: string; to: string }): boolean =>
    !sel || (down!.has(e.from) && down!.has(e.to)) || (up!.has(e.from) && up!.has(e.to));

  return (
    <div className="arch-diagram">
      <div className="arch-legend">
        {KIND_ORDER.map((k) => (
          <span key={k} className={`arch-key kind-${k}`}><i /> {KIND_LABEL[k]}</span>
        ))}
        <span className="arch-key-note">{sel ? "click the node again (or the canvas) to clear" : "click a node to isolate its flow"}</span>
        {graph.truncated && <span className="arch-key-note">· {graph.nodes.length} most-connected of {graph.total} files</span>}
      </div>
      <div className="arch-canvas">
        <svg width={width} height={height} className={`arch-svg${sel ? " has-sel" : ""}`}
          onClick={() => setSel(null)}>
          <defs>
            <marker id="arch-ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" className="arch-ah" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const lit = edgeLit(e);
            return <path key={i} className={`arch-edge${sel ? (lit ? " is-lit" : " is-dim") : ""}`}
              d={edgePath(a, b)} markerEnd="url(#arch-ah)" />;
          })}
          {graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const lit = !sel || flow!.has(n.id);
            const cls = `arch-node kind-${n.kind}${sel ? (lit ? " is-lit" : " is-dim") : ""}${sel === n.id ? " is-sel" : ""}`;
            return (
              <g key={n.id} className={cls} transform={`translate(${p.x},${p.y})`}
                onClick={(ev) => { ev.stopPropagation(); setSel((s) => (s === n.id ? null : n.id)); }}>
                <rect width={NW} height={NH} rx={9} />
                <rect className="arch-node-bar" width={4} height={NH} />
                <foreignObject x={10} y={0} width={NW - 16} height={NH}>
                  <div className="arch-node-label" title={n.id}>{n.label}</div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** The living architecture: the world-model your agents maintain (folded from
 *  every run — which symbol lives where, the decisions taken, which ticket owns
 *  each file) next to the notes YOU keep. The shared source of truth both sides
 *  reference, and it survives runs. */
export function ArchitectureModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<ArchData | null>(null);
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void fetchJSON<ArchData>("/api/architecture")
      .then((d) => { setData(d); setNotes(d.notes); })
      .catch(() => {});
  }, []);

  const save = async (): Promise<void> => {
    try {
      await fetchJSON("/api/architecture", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      setDirty(false);
      toast("Architecture notes saved.");
    } catch (err) { toast(String(err), true); }
  };

  const map = data?.map;
  const emptyMap = map && map.symbols.length === 0 && map.decisions.length === 0 && map.files.length === 0;

  return (
    <Modal title="Architecture — the shared source of truth" onClose={onClose} wide>
      {!data
        ? <div className="panel-body"><Skeleton lines={6} /></div>
        : (
          <div className="arch-wrap">
          {data.graph && (
            <section className="arch-map-panel">
              <h4 className="arch-h">System map <span className="arch-h-sub">files &amp; imports, by role — derived from the code</span></h4>
              <ArchDiagram graph={data.graph} />
            </section>
          )}
          <div className="arch">
            <section className="arch-map">
              <p className="arch-lead"><Sparkles size={13} /> Maintained by your agents from what they land — grows every run.</p>
              {emptyMap
                ? <p className="hint">Nothing mapped yet. As agents land work, the symbols they publish, the
                    decisions they record, and the files they own show up here automatically.</p>
                : (
                  <>
                    {map!.decisions.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Decisions</h4>
                        <ul className="arch-list">
                          {map!.decisions.map((d) => (
                            <li key={d.key}><b>{d.key}</b>: {d.value} <span className="arch-by">#{d.ticket}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {map!.symbols.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Symbols</h4>
                        <ul className="arch-list">
                          {map!.symbols.map((s) => (
                            <li key={`${s.name}@${s.file}`}><b>{s.name}</b> <span className="arch-arrow">→</span> <span className="mono">{s.file}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {map!.files.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Files &amp; who last touched them</h4>
                        <ul className="arch-files">
                          {map!.files.map((f) => (
                            <li key={f.file}><FileText size={12} /> <span className="mono arch-file-nm">{f.file}</span> <span className="arch-by">#{f.ticket}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
            </section>

            <section className="arch-notes">
              <div className="arch-notes-head">
                <h4 className="arch-h">Your notes</h4>
                <Button kind="btn" variant="primary" onClick={() => void save()} disabled={!dirty}>Save</Button>
              </div>
              <p className="arch-lead">The architecture as you see it — conventions, intent, the “why”. Agents read this for context.</p>
              <textarea className="input arch-textarea" value={notes}
                placeholder={"# Architecture\n\n- The header nav lives in ProjectSwitcher…\n- Modals are extracted into *-modal.tsx, re-exported from modals.tsx…"}
                onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
            </section>
          </div>
          </div>
        )}
    </Modal>
  );
}
