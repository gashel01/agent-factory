/** Primitives of the new interface. Every view builds from these, styled by
 *  public/next/01-ui.css and 02-shell.css. Plain components, no state beyond
 *  what each one needs to behave (focus, Escape). */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode, RefObject } from "react";
import { X } from "./icons.js";
import type { TaskState } from "../types.js";

/* ----------------------------------------------------------------- buttons */

export type ButtonKind = "default" | "fill" | "ghost" | "danger";

export function Btn({
  children, onClick, kind = "default", small, block, disabled, title, type = "button", busy,
}: {
  children: ReactNode; onClick?: () => void | Promise<unknown>; kind?: ButtonKind; small?: boolean;
  block?: boolean; disabled?: boolean; title?: string; type?: "button" | "submit"; busy?: boolean;
}): JSX.Element {
  // A click that returns a promise disables the button until it settles, so a
  // slow request can't be fired twice by an impatient second click.
  const [pending, setPending] = useState(false);
  const cls = ["btn", kind !== "default" ? kind : "", small ? "sm" : "", block ? "block" : ""].filter(Boolean).join(" ");
  const handle = (): void => {
    const r = onClick?.();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      setPending(true);
      void (r as Promise<unknown>).finally(() => setPending(false));
    }
  };
  const inert = disabled || pending || busy;
  return (
    <button type={type} className={cls} onClick={handle} disabled={inert} title={title} aria-busy={pending || busy || undefined}>
      {(pending || busy) && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function IconBtn({
  label, children, onClick, boxed, on, small,
}: { label: string; children: ReactNode; onClick?: () => void; boxed?: boolean; on?: boolean; small?: boolean }): JSX.Element {
  const cls = ["iconbtn", boxed ? "boxed" : "", on ? "on" : "", small ? "sm" : ""].filter(Boolean).join(" ");
  return <button type="button" className={cls} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

/* ------------------------------------------------------- choices & toggles */

export function Seg<T extends string>({
  value, options, onChange, label,
}: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; label: string }): JSX.Element {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Pills<T extends string>({
  value, options, onChange, label,
}: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; label: string }): JSX.Element {
  return (
    <div className="pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="pill" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/* -------------------------------------------------------------- state colour */

/** One colour per ticket state, shared by every surface (see 00-tokens.css). */
export const STATE_COLOR: Record<TaskState, string> = {
  QUEUED: "var(--st-queued)",
  RUNNING: "var(--st-working)",
  VERIFYING: "var(--st-checking)",
  REVIEWING: "var(--st-checking)",
  AWAITING_APPROVAL: "var(--st-review)",
  MERGE_QUEUED: "var(--st-merged)",
  MERGING: "var(--st-merged)",
  DONE: "var(--st-merged)",
  FAILED: "var(--st-needs)",
  BLOCKED: "var(--st-needs)",
};

export const STATE_LABEL: Record<TaskState, string> = {
  QUEUED: "Up next",
  RUNNING: "Working",
  VERIFYING: "Checking",
  REVIEWING: "Reviewing",
  AWAITING_APPROVAL: "To review",
  MERGE_QUEUED: "Merging",
  MERGING: "Merging",
  DONE: "Merged",
  FAILED: "Failed",
  BLOCKED: "Needs you",
};

export function Tag({ children, color, dot }: { children: ReactNode; color?: string; dot?: boolean }): JSX.Element {
  return (
    <span className="tag" style={color ? ({ "--c": color } as CSSProperties) : undefined}>
      {dot && <span className="tag-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StateTag({ state }: { state: TaskState }): JSX.Element {
  return <Tag color={STATE_COLOR[state]} dot>{STATE_LABEL[state]}</Tag>;
}

/* ------------------------------------------------------------ containers */

export function Card({ children, tight, style, className }: { children: ReactNode; tight?: boolean; style?: CSSProperties; className?: string }): JSX.Element {
  return <section className={["card", tight ? "tight" : "", className ?? ""].filter(Boolean).join(" ")} style={style}>{children}</section>;
}

export function Stat({ value, label, color }: { value: ReactNode; label: ReactNode; color?: string }): JSX.Element {
  return (
    <div className="stat">
      <span className="stat-value" style={color ? { color } : undefined}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function Bar({ segments, height }: { segments: Array<{ pct: number; color: string; label?: string }>; height?: number }): JSX.Element {
  return (
    <div className="bar" style={height ? { height } : undefined} role="img"
      aria-label={segments.map((s) => `${s.label ?? ""} ${Math.round(s.pct)}%`).join(", ")}>
      {segments.filter((s) => s.pct > 0).map((s, i) => (
        <span key={i} className="bar-seg" style={{ width: `${s.pct}%`, background: s.color }} />
      ))}
    </div>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
      <p className="empty-state-title">{title}</p>
      {children && <p className="hint" style={{ maxWidth: 420 }}>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner(): JSX.Element {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

/* --------------------------------------------------------------- overlays */

/** Close on Escape and move focus into the overlay; give it back on close. */
function useOverlay(onClose: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])");
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, []);
  return ref;
}

/** A side sheet: anything tied to one ticket or one object opens here, so the
 *  board stays visible behind it. */
export function Sheet({
  title, eyebrow, onClose, children, footer, wide, headExtra,
}: {
  title: ReactNode; eyebrow?: ReactNode; onClose: () => void; children: ReactNode;
  footer?: ReactNode; wide?: boolean; headExtra?: ReactNode;
}): JSX.Element {
  const ref = useOverlay(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className={`sheet${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="sheet-head">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>{eyebrow}</div>
            <IconBtn label="Close" onClick={onClose}><X size={18} /></IconBtn>
          </div>
          <h2 className="sheet-title">{title}</h2>
          {headExtra}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

/** A centred dialog for short, blocking choices (confirmations, the palette). */
export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }): JSX.Element {
  const ref = useOverlay(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </>
  );
}
