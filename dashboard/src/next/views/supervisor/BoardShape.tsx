/** One shape on the sketch board: a box, a database cylinder, a sticky note or
 *  an arrow. The human layer (what you drew) and the agent layer (nodes dropped
 *  from the world-model) share one surface and differ only in colour. */

import type { JSX, PointerEvent as RPointerEvent } from "react";
import type { Shape } from "./types.js";

export function BoardShape({ s, selected, editing, onDown, onEdit, onText, onBlur }: {
  s: Shape; selected: boolean; editing: boolean;
  onDown: (e: RPointerEvent) => void; onEdit: () => void;
  onText: (v: string) => void; onBlur: () => void;
}): JSX.Element {
  const cls = `sv-bd-shape sv-bd-${s.kind} layer-${s.layer}${selected ? " is-sel" : ""}`;
  if (s.kind === "arrow") {
    return (
      <g className={cls} onPointerDown={onDown}>
        {/* a fat invisible hit line so a thin arrow is easy to grab */}
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="sv-bd-hit" />
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="sv-bd-line" markerEnd="url(#sv-bd-arrow)" />
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
            <path className="sv-bd-fill"
              d={`M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry}`} />
            <ellipse className="sv-bd-fill" cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} />
          </>
        )
        : <rect className="sv-bd-fill" x={x} y={y} width={w} height={h} rx={s.kind === "sticky" ? 4 : 12} />}
      <foreignObject x={x} y={y} width={w} height={h}>
        {editing
          ? (
            <textarea className="sv-bd-edit" autoFocus defaultValue={s.text ?? ""} aria-label="Shape label"
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }}
              onChange={(e) => onText(e.target.value)} onBlur={onBlur} />
          )
          : <div className="sv-bd-text">{s.text}</div>}
      </foreignObject>
      {selected && <rect className="sv-bd-ring" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={14} />}
    </g>
  );
}
