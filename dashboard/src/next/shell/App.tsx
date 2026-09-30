/** The new interface's frame: rail | page | supervisor, with at most one
 *  overlay above. Pages and overlays are plain components from views/. */

import { useEffect } from "react";
import type { JSX } from "react";
import { ErrorBoundary } from "../../error-boundary.js";
import { useWarden } from "../data.js";
import type { Page } from "../routes.js";
import { AutopilotPage } from "../views/autopilot/AutopilotPage.js";
import { BoardPage } from "../views/board/BoardPage.js";
import { InsightsPage } from "../views/insights/InsightsPage.js";
import { KnowledgePage } from "../views/knowledge/KnowledgePage.js";
import { LessonSheet } from "../views/memory/LessonSheet.js";
import { MemoryPage } from "../views/memory/MemoryPage.js";
import { EditTicketSheet } from "../views/newwork/EditTicketSheet.js";
import { NewWorkSheet } from "../views/newwork/NewWorkSheet.js";
import { RunEstimateSheet } from "../views/newwork/RunEstimateSheet.js";
import { ProjectEditSheet } from "../views/projects/ProjectEditSheet.js";
import { ProjectsPage } from "../views/projects/ProjectsPage.js";
import { PullRequestsPage } from "../views/prs/PullRequestsPage.js";
import { RepoPage } from "../views/repo/RepoPage.js";
import { RunPage } from "../views/run/RunPage.js";
import { SettingsPage } from "../views/settings/SettingsPage.js";
import { SupervisorPanel } from "../views/supervisor/SupervisorPanel.js";
import { AnswerSheet } from "../views/ticket/AnswerSheet.js";
import { DecisionSheet } from "../views/ticket/DecisionSheet.js";
import { DiffPage } from "../views/ticket/DiffPage.js";
import { TicketSheet } from "../views/ticket/TicketSheet.js";
import { ModePopover } from "./ModePopover.js";
import { Palette } from "./Palette.js";
import { Rail } from "./Rail.js";
import { Toasts } from "./Toasts.js";

function PageView({ page, arg }: { page: Page; arg: string }): JSX.Element {
  switch (page) {
    case "projects": return <ProjectsPage />;
    case "board": return <BoardPage />;
    case "diff": return <DiffPage taskId={arg} />;
    case "prs": return <PullRequestsPage />;
    case "autopilot": return <AutopilotPage />;
    case "repo": return <RepoPage path={arg} />;
    case "knowledge": return <KnowledgePage />;
    case "run": return <RunPage />;
    case "insights": return <InsightsPage />;
    case "memory": return <MemoryPage />;
    case "settings": return <SettingsPage section={arg} />;
  }
}

function OverlayView(): JSX.Element | null {
  const { overlay: o } = useWarden();
  if (!o) return null;
  switch (o.type) {
    case "ticket": return <TicketSheet taskId={o.taskId} />;
    case "answer": return <AnswerSheet taskId={o.taskId} title={o.title} question={o.question} context={o.context} />;
    case "decision": return <DecisionSheet taskId={o.taskId} title={o.title} question={o.question} options={o.options} />;
    case "newwork": return <NewWorkSheet tab={o.tab} goal={o.goal} autostart={o.autostart} />;
    case "editticket": return <EditTicketSheet ticket={o.ticket} />;
    case "lesson": return <LessonSheet text={o.text} ticketId={o.ticketId} />;
    case "projectedit": return <ProjectEditSheet name={o.name} />;
    case "runestimate": return <RunEstimateSheet tickets={o.tickets} />;
    case "palette": return <Palette />;
    case "mode": return <ModePopover from={o.from ?? "rail"} />;
  }
}

/** Ctrl/Cmd+K anywhere; N for new work when nothing is open and no field has focus. */
function useShortcuts(): void {
  const w = useWarden();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        w.open(w.overlay?.type === "palette" ? null : { type: "palette" });
        return;
      }
      if (w.overlay || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "n") { e.preventDefault(); w.open({ type: "newwork" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [w.overlay]);
}

export function App(): JSX.Element {
  const w = useWarden();
  useShortcuts();
  const { page, arg } = w.route;
  return (
    <div className="rx app" data-theme={w.resolvedTheme}>
      <Rail />
      <main className="main">
        {!w.connected && (
          <div className="conn-lost" role="status">Connection lost — is the Warden server still running? Reconnecting…</div>
        )}
        <div className="main-body">
          <div className="main" style={{ minWidth: 0 }}>
            <ErrorBoundary name={page} resetKey={`${page}/${arg}/${w.ws}`}>
              {/* Keyed by project: switching remounts the page, so no view keeps
                  another project's data it loaded once on mount. */}
              <PageView key={w.ws} page={page} arg={arg} />
            </ErrorBoundary>
          </div>
          {w.supervisorOpen && (
            <ErrorBoundary name="Supervisor" onClose={() => w.setSupervisorOpen(false)}>
              <SupervisorPanel key={w.ws} />
            </ErrorBoundary>
          )}
        </div>
      </main>
      <ErrorBoundary name="This window" resetKey={w.overlay?.type} overlay onClose={w.close}>
        <OverlayView />
      </ErrorBoundary>
      <Toasts />
    </div>
  );
}
