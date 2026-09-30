/** The board's "Removed" segment: tickets the operator took off the board.
 *  Only hidden — their run history and files are untouched — and each one can
 *  be restored (an AI draft also leaves hold) or, when it ran, its history read. */

import type { JSX } from "react";
import { fmtUsd } from "../../../model.js";
import { useWarden } from "../../data.js";
import { RotateCw, Trash2 } from "../../icons.js";
import { Btn, Card, Empty, StateTag, Tag } from "../../ui.js";
import type { TicketActions } from "./actions.js";

export function RemovedList({ act }: { act: TicketActions }): JSX.Element {
  const w = useWarden();
  if (w.removed.length === 0) {
    return <Empty icon={<Trash2 size={22} />} title="Nothing removed">Tickets you remove from the board land here, ready to restore.</Empty>;
  }
  return (
    <div className="bd-removed">
      <p className="hint">Removed tickets leave the board but keep their run history and files. Restore one to put it back where it was.</p>
      {w.removed.map((r) => {
        const t = w.tasks.find((x) => x.id === r.id);
        return (
          <Card key={r.id} tight className="bd-removed-row">
            <div className="stack bd-removed-text">
              <div className="row"><span className="mono faint">{r.id}</span><b>{r.title}</b></div>
              <div className="row bd-removed-meta">
                {t ? <StateTag state={t.state} /> : <Tag dot>Never run</Tag>}
                {t && t.retries > 0 && <span className="faint">{t.retries + 1} attempts</span>}
                {t && t.costUsd > 0 && <span className="faint">{fmtUsd(t.costUsd)}</span>}
              </div>
            </div>
            <div className="row bd-removed-actions">
              {t && <Btn kind="ghost" small onClick={() => act.open(t.id)}>History</Btn>}
              <Btn small onClick={() => w.restoreTicket(r.id)}><RotateCw size={13} /> Restore</Btn>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
