/** Every run in view, newest first: when, what it cost, the tokens it used,
 *  its failures, and what it shipped or left waiting on you. */

import type { JSX } from "react";
import { fmtTokens, fmtUsd } from "../../../model.js";
import { Card } from "../../ui.js";
import { runErrorTotal, runLabel } from "./analytics.js";
import type { RunPoint } from "./analytics.js";

export function RunTable({ runs }: { runs: RunPoint[] }): JSX.Element {
  return (
    <Card>
      <h2 className="card-title">Runs</h2>
      <div className="in-table-wrap">
        <table className="in-table">
          <thead>
            <tr><th scope="col">Run</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Failures</th><th scope="col">Result</th></tr>
          </thead>
          <tbody>
            {[...runs].reverse().map((r) => {
              const errs = runErrorTotal(r);
              return (
                <tr key={r.run}>
                  <th scope="row">{runLabel(r)}</th>
                  <td className="mono">{fmtUsd(r.spend)}</td>
                  <td className="mono">{fmtTokens(r.tokens)}</td>
                  <td className={errs ? "in-bad" : "faint"}>{errs ? `${errs} failure${errs > 1 ? "s" : ""}` : "none"}</td>
                  <td>
                    {r.merged > 0 ? <span className="in-good">{r.merged} shipped</span> : <span className="faint">nothing shipped</span>}
                    {r.needs > 0 && <span className="in-warn"> · {r.needs} need you</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
