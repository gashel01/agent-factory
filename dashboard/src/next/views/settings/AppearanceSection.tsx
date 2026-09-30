/** Settings › Appearance: the new interface's own theme — dark, light, or
 *  follow the system. A device preference (stored in this browser), not a
 *  project setting, so it applies at once and needs no Save.
 *
 *  Each preview is a tiny nested `.rx` scope with its own data-theme, so it is
 *  painted with the real tokens of the theme it shows, whatever is active. */

import type { JSX } from "react";
import { Check } from "../../icons.js";
import { useWarden } from "../../data.js";
import type { ThemeChoice } from "../../data.js";
import { Group } from "./parts.js";

function Preview({ theme }: { theme: "dark" | "light" }): JSX.Element {
  return (
    <span className="rx st-theme-mini" data-theme={theme} aria-hidden="true">
      <i className="st-theme-mini-rail" />
      <i className="st-theme-mini-main"><i className="st-theme-mini-card" /><i className="st-theme-mini-card" /></i>
    </span>
  );
}

const CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Follow the system" },
];

export function AppearanceSection(): JSX.Element {
  const w = useWarden();
  return (
    <>
      <Group title="Theme" sub="Stored on this device — it applies to every project.">
        <div className="st-themes" role="radiogroup" aria-label="Theme">
          {CHOICES.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={w.theme === c.value}
              className="st-theme" onClick={() => w.setTheme(c.value)}>
              {c.value === "system" ? (
                <span className="st-theme-split"><Preview theme="dark" /><Preview theme="light" /></span>
              ) : <Preview theme={c.value} />}
              <span className="row st-theme-label">
                {c.label}
                {w.theme === c.value && <Check size={15} />}
              </span>
            </button>
          ))}
        </div>
        {w.theme === "system" && <p className="hint">Right now your system asks for {w.resolvedTheme}.</p>}
      </Group>
      <Group title="Colours">
        <p className="hint">
          State colours stay fixed — blue is working, purple checking, orange waiting on your review, green merged,
          red needs you — so the accent only ever colours actions.
        </p>
      </Group>
    </>
  );
}
