/** A large overlay for the surfaces too big for a 360px panel (the system map,
 *  the sketch board). Built here rather than as a shell overlay so opening it
 *  keeps the panel — and whatever the operator was reading — in place. Escape
 *  closes it; focus moves in on open and goes back where it was on close. */

import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { X } from "../../icons.js";
import { IconBtn } from "../../ui.js";

export function Expand({ title, sub, onClose, tools, children }: {
  title: string; sub?: ReactNode; onClose: () => void; tools?: ReactNode; children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      // A label being edited on the board owns Escape (it just ends the edit).
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      e.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, []);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="sv-expand" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sv-expand-head">
          <div className="sv-expand-titles">
            <h2 className="sv-expand-title">{title}</h2>
            {sub && <p className="hint">{sub}</p>}
          </div>
          <div className="spacer" />
          {tools}
          <IconBtn label="Close" onClick={onClose}><X size={18} /></IconBtn>
        </header>
        <div className="sv-expand-body">{children}</div>
      </div>
    </>
  );
}
