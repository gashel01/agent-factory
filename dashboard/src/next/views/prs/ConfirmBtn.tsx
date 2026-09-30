/** A two-step button for the irreversible actions (close a PR, delete a branch,
 *  stop a server, deploy): the first click turns it into "Sure?", the second —
 *  within a few seconds — does it. Same contract as the classic ConfirmButton,
 *  drawn with the new Btn. Also used by the Run page. */

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Btn } from "../../ui.js";
import type { ButtonKind } from "../../ui.js";

/** How long the armed state waits for the second click. */
const ARM_MS = 3500;

export function ConfirmBtn({ children, confirm, onConfirm, kind = "ghost", disabled, label }: {
  children: ReactNode; confirm: string; onConfirm: () => Promise<unknown> | void;
  kind?: ButtonKind; disabled?: boolean; label?: string;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Btn small kind={armed ? "danger" : kind} disabled={disabled} title={armed ? undefined : label}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        return onConfirm();
      }}>
      {armed ? confirm : children}
    </Btn>
  );
}
