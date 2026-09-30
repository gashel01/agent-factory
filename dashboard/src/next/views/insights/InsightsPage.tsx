/** Insights: what the runs cost and why tickets failed (the classic "Cost &
 *  activity" analytics), and the ticket dependency graph (the classic
 *  "Ticket dependencies" modal) as a second tab. The tab lives in the URL
 *  (#/insights/deps) so a reload or a shared link keeps it. */

import type { JSX } from "react";
import { useWarden } from "../../data.js";
import { Topbar } from "../../shell/Topbar.js";
import { Seg } from "../../ui.js";
import { DepGraph } from "./DepGraph.js";
import { RunsTab } from "./RunsTab.js";

type Tab = "runs" | "deps";

export function InsightsPage(): JSX.Element {
  const w = useWarden();
  const tab: Tab = w.route.arg === "deps" ? "deps" : "runs";
  return (
    <>
      <Topbar title="Insights" sub={tab === "runs" ? "Every run — what it cost, what it used, what it shipped" : "What waits on what"}>
        <Seg label="Insights section" value={tab}
          options={[{ value: "runs", label: "Runs" }, { value: "deps", label: "Dependencies" }]}
          onChange={(v) => w.go("insights", v === "deps" ? "deps" : "")} />
      </Topbar>
      <div className="view">
        {tab === "runs" ? <RunsTab /> : <DepGraph />}
      </div>
    </>
  );
}
