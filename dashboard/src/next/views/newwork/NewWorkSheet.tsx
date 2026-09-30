/** New work: the single surface for creating work. One fork up top — write one
 *  ticket by hand (optionally fleshed out by AI) or describe a goal and let the
 *  planner draft several — then both feed the same backlog, reviewed and
 *  launched below. Both tabs stay mounted in state, so switching loses nothing.
 *
 *  Opened with a `goal` (from the supervisor), it lands on "From a goal" and
 *  starts drafting at once, as the classic modal does. */

import { useState } from "react";
import type { JSX } from "react";
import { useWarden } from "../../data.js";
import { Seg, Sheet } from "../../ui.js";
import { DraftsReview } from "./DraftsReview.js";
import { FromGoalBody, FromGoalFoot } from "./FromGoal.js";
import { OneTicketBody, OneTicketFoot, useOneTicket } from "./OneTicket.js";
import { RepoRow, useNoProject } from "./RepoRow.js";
import { usePlanner } from "./usePlanner.js";

export function NewWorkSheet({ tab: initialTab, goal, autostart }: {
  tab?: "one" | "goal"; goal?: string; autostart?: boolean;
}): JSX.Element {
  const w = useWarden();
  const [tab, setTab] = useState<"one" | "goal">(goal ? "goal" : initialTab ?? "one");
  const one = useOneTicket();
  const planner = usePlanner(goal, autostart ?? true);
  const noProject = useNoProject();

  return (
    <Sheet title="New work" onClose={w.close}
      headExtra={!noProject && (
        <div className="nw-tabs">
          <Seg label="How to create the work" value={tab} onChange={setTab} options={[
            { value: "one", label: "One ticket" },
            { value: "goal", label: "From a goal — AI drafts several" },
          ]} />
        </div>
      )}
      footer={noProject ? undefined : tab === "one" ? <OneTicketFoot st={one} /> : <FromGoalFoot p={planner} />}>
      <RepoRow />
      {!noProject && (
        <>
          {tab === "one" ? <OneTicketBody st={one} /> : <FromGoalBody p={planner} />}
          <DraftsReview />
        </>
      )}
    </Sheet>
  );
}
