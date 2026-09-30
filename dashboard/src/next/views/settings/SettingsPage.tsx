/** Settings: the active project's factory.yaml as a form, plus the new
 *  interface's own appearance. One section at a time, addressed by the URL
 *  (#/settings/safety) so the rail's mode popover — or anyone — can deep-link.
 *
 *  Edits are kept across section switches and written in one go by Save; "Test
 *  these settings" saves, then runs the doctor (a tiny real agent) and shows its
 *  report. Appearance is a device preference and applies instantly. */

import type { JSX } from "react";
import { FlaskConical, ShieldCheck } from "../../icons.js";
import { useWarden } from "../../data.js";
import { hashFor } from "../../routes.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Card, Empty } from "../../ui.js";
import { AdvancedSection } from "./AdvancedSection.js";
import { AppearanceSection } from "./AppearanceSection.js";
import { GeneralSection } from "./GeneralSection.js";
import { ProjectSection } from "./ProjectSection.js";
import { SafetySection } from "./SafetySection.js";
import { TrustSection } from "./TrustSection.js";
import { useProjectSettings } from "./useProjectSettings.js";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "trust", label: "Trust & checks" },
  { id: "safety", label: "Execution & safety" },
  { id: "project", label: "Project" },
  { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** Accept the classic panel's ids too ("set-safety"), and fall back to General. */
function sectionOf(arg: string): SectionId {
  const id = arg.replace(/^set-/, "");
  return SECTIONS.some((s) => s.id === id) ? (id as SectionId) : "general";
}

function Skeleton(): JSX.Element {
  return (
    <Card className="st-group">
      {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton st-skeleton-row" />)}
    </Card>
  );
}

export function SettingsPage({ section }: { section: string }): JSX.Element {
  const w = useWarden();
  const current = sectionOf(section);
  const ps = useProjectSettings(w.ws);
  const { s } = ps;
  const appearance = current === "appearance";

  const body = (): JSX.Element => {
    if (appearance) return <AppearanceSection />;
    if (ps.error) {
      return <Empty title="Settings unavailable" action={<Btn onClick={ps.reload}>Try again</Btn>}>{ps.error}</Empty>;
    }
    if (!s) return <Skeleton />;
    switch (current) {
      case "general": return <GeneralSection s={s} set={ps.set} />;
      case "trust": return <TrustSection s={s} set={ps.set} />;
      case "safety": return <SafetySection s={s} set={ps.set} />;
      case "project": return <ProjectSection s={s} set={ps.set} onKnowledge={ps.setKnowledge} />;
      case "advanced": return <AdvancedSection s={s} set={ps.set} />;
    }
  };

  const sub = appearance
    ? "Appearance · applies on every project"
    : ps.dirty ? "Unsaved changes" : w.ws ? `${w.ws} only — each project keeps its own` : undefined;

  return (
    <>
      <Topbar title="Settings" sub={sub}>
        {!appearance && s && (
          <>
            <Btn kind="ghost" disabled={ps.testing} busy={ps.testing} onClick={ps.test}
              title="Saves, then one tiny agent tries the web and your commands for real (~30s)">
              <FlaskConical size={15} /> Test these settings
            </Btn>
            <Btn kind="fill" disabled={!ps.dirty} onClick={ps.save}>Save</Btn>
          </>
        )}
      </Topbar>
      <div className="view">
        <div className="st-layout">
          <nav className="st-nav" aria-label="Settings sections">
            {SECTIONS.map((x) => (
              <a key={x.id} className="st-nav-item" href={hashFor({ page: "settings", arg: x.id })}
                aria-current={x.id === current ? "page" : undefined}>{x.label}</a>
            ))}
          </nav>
          <div className="st-panes">
            {!appearance && s && current === "general" && (
              <p className="hint">Sensible defaults are already set — you can run without changing a thing. Tweak these only if you want to.</p>
            )}
            {!appearance && w.ws && (
              <p className="st-scope"><ShieldCheck size={14} /> These apply to <b>{w.ws}</b> only — each project keeps its own settings.</p>
            )}
            {body()}
            {!appearance && ps.testOut !== null && (
              <Card className="st-doctor-card">
                <h2 className="card-title">Settings test</h2>
                <pre className="st-doctor" aria-live="polite">{ps.testOut}</pre>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
