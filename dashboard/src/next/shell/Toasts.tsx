/** Toasts, fed by the same toast() the shared layers already call (core.tsx),
 *  drawn in the new style. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toastList, toastSubs } from "../../core.js";
import type { Toast } from "../../core.js";

export function Toasts(): JSX.Element {
  const [items, setItems] = useState<Toast[]>(toastList);
  useEffect(() => {
    toastSubs.add(setItems);
    return () => { toastSubs.delete(setItems); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast-item${t.error ? " error" : ""}`}>{t.msg}</div>)}
    </div>
  );
}
