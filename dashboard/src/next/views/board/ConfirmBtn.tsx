/** A two-step button for destructive run controls (Stop all, Discard, Cancel):
 *  the first click arms it and changes its label, the second — within three
 *  seconds — fires. Same behaviour as the classic ConfirmButton, new style. */

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Btn } from "../../ui.js";
import type { ButtonKind } from "../../ui.js";

export function ConfirmBtn({
  label, confirm, onConfirm, kind = "default", small,
}: {
  label: ReactNode; confirm: string; onConfirm: () => void | Promise<unknown>; kind?: ButtonKind; small?: boolean;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <Btn kind={armed ? "danger" : kind} small={small}
      onClick={() => { if (armed) { setArmed(false); return onConfirm(); } setArmed(true); }}>
      {armed ? confirm : label}
    </Btn>
  );
}
