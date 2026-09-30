/** Insights → Dependencies: which ticket waits on which, laid out in execution
 *  order (leftmost runs first), each node coloured by its live state.
 *
 *  While a run is live the graph is the FROZEN plan the scheduler enforces
 *  (each task's depends_on from the run's run_start event), not a re-read of
 *  the backlog folder, which drifts as the loop regenerates tickets and merged
 *  ones are archived. Off-run it is the workspace backlog merged with the
 *  active autopilot loop's own backlog — the classic graph's exact sources.
 *  Nodes are buttons: a run ticket opens its sheet, a backlog draft its editor. */

import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { layerNodes, parseTicketDeps } from "../../../board-model.js";
import type { DepNode } from "../../../board-model.js";
import { GitBranch } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Empty, STATE_COLOR, STATE_LABEL, Spinner } from "../../ui.js";

const COL = 230, ROW = 92, NW = 184, NH = 62, PAD = 20;

export function DepGraph(): JSX.Element {
  const w = useWarden();
  const liveNodes: DepNode[] | null = w.live ? w.tasks.map((t) => ({ id: t.id, title: t.title, deps: t.deps })) : null;
  const useLive = Boolean(liveNodes && liveNodes.length > 0);
  const [fetched, setFetched] = useState<DepNode[] | null>(null);

  useEffect(() => {
    if (useLive) { setFetched(null); return; }
    let alive = true;
    const pull = (p: string): Promise<Array<{ content: string }>> =>
      fetchJSON<{ tickets: Array<{ content: string }> }>(p).then((r) => r.tickets).catch(() => []);
    void Promise.all([pull("/api/backlog"), pull("/api/loop/backlog")]).then(([a, b]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const merged: DepNode[] = [];
      for (const t of [...a, ...b]) {
        const n = parseTicketDeps(t.content);
        if (!seen.has(n.id)) { seen.add(n.id); merged.push(n); }
      }
      setFetched(merged);
    });
    return () => { alive = false; };
  }, [useLive, w.ws]);

  const nodes = useLive ? liveNodes! : fetched;
  if (nodes === null) return <div className="in-loading"><Spinner /></div>;
  if (nodes.length === 0) {
    return (
      <Empty icon={<GitBranch size={22} />} title="No pending tickets">
        The graph shows the current backlog — merged tickets are archived.
      </Empty>
    );
  }

  const layers = layerNodes(nodes);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, ci) => layer.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * COL, y: PAD + ri * ROW })));
  const width = PAD * 2 + Math.max(1, layers.length) * COL - (COL - NW);
  const height = PAD * 2 + Math.max(1, ...layers.map((l) => l.length)) * ROW - (ROW - NH);
  const edges = nodes.flatMap((n) => n.deps.map((d) => ({ from: n.id, to: d }))).filter((e) => pos.has(e.from) && pos.has(e.to));

  const openNode = (id: string): (() => void) | undefined => {
    if (w.model.tasks.has(id)) return () => w.open({ type: "ticket", taskId: id });
    const bt = w.boardTickets.find((b) => b.id === id);
    return bt ? () => w.open({ type: "editticket", ticket: bt }) : undefined;
  };

  return (
    <>
      <p className="hint">
        Arrows point from a ticket to what it depends on. Columns are the execution order — the leftmost run first.
        {useLive ? " Showing the plan the running scheduler enforces; it won’t shift while this run is live." : ""}
      </p>
      <div className="card in-graph-wrap">
        <div className="in-graph" style={{ width, height }}>
          <svg className="in-graph-edges" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <defs>
              <marker id="in-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="in-arrowhead" />
              </marker>
            </defs>
            {edges.map(({ from, to }) => {
              const a = pos.get(from)!, b = pos.get(to)!;
              const x1 = a.x, y1 = a.y + NH / 2, x2 = b.x + NW, y2 = b.y + NH / 2;
              const mx = (x1 + x2) / 2;
              return <path key={`${from}-${to}`} className="in-edge" markerEnd="url(#in-arrow)"
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
            })}
          </svg>
          <ol className="in-nodes" aria-label="Tickets in execution order">
            {nodes.map((n) => {
              const p = pos.get(n.id)!;
              const st = w.model.tasks.get(n.id)?.state;
              const onClick = openNode(n.id);
              const style = { left: p.x, top: p.y, width: NW, height: NH, "--c": st ? STATE_COLOR[st] : "var(--st-queued)" } as CSSProperties;
              const deps = n.deps.length ? `, depends on ${n.deps.join(", ")}` : "";
              const label = `${n.id}: ${n.title}. ${st ? STATE_LABEL[st] : "Not started"}${deps}`;
              const body = (
                <>
                  <span className="in-node-id">{n.id}{st && <span className="in-node-state">{STATE_LABEL[st]}</span>}</span>
                  <span className="in-node-title">{n.title}</span>
                </>
              );
              return (
                <li key={n.id}>
                  {onClick
                    ? <button type="button" className="in-node" style={style} aria-label={label} title={n.title} onClick={onClick}>{body}</button>
                    : <div className="in-node" style={style} aria-label={label} title={n.title} role="group">{body}</div>}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </>
  );
}
