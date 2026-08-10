import { useRef } from "react";
import type { JSX } from "react";
import { Appearance, ThemeMode } from "./screens-theme.js";
import { Modal } from "./widgets.js";
import { toast } from "./core.js";
import {
  ACCENTS, ATMOSPHERES, BACKGROUNDS, MAX_CUSTOM_BG, PANEL_COLORS, PANEL_STYLES, SCENES,
} from "./appearance-types.js";
import { Palette, Upload, X } from "./icons.js";

export function AppearanceButton({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <button className="hbtn icon-btn" aria-label="Appearance settings" title="Appearance — theme, accent, density" onClick={onOpen}><Palette size={16} /></button>
  );
}

/** The full appearance panel: theme, panels, background, scenes, atmospheres,
 *  custom backgrounds, accent and a darkness dimmer. Global UI prefs. */
export function AppearanceModal({ theme, onClose }: { theme: Appearance; onClose: () => void }): JSX.Element {
  const modes: Array<[ThemeMode, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  const densities: Array<[string, string]> = [["comfortable", "Comfortable"], ["compact", "Compact"]];
  const fileRef = useRef<HTMLInputElement>(null);
  const full = theme.customBgs.length >= MAX_CUSTOM_BG;

  // Read the picked file, downscale it (cap the longest edge at 1600px, JPEG
  // 0.82) so five backgrounds stay well within the localStorage quota, then
  // hand the data URL to the hook. Read via the ref so we need no React event.
  const onPickFile = (): void => {
    const input = fileRef.current;
    const file = input?.files?.[0] ?? null;
    if (input) input.value = "";
    if (!file || full) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { theme.addCustomBg(String(reader.result)); return; }
        ctx.drawImage(img, 0, 0, w, h);
        try { theme.addCustomBg(canvas.toDataURL("image/jpeg", 0.82)); }
        catch { toast("Couldn't store that image — try a smaller one.", true); }
      };
      img.onerror = () => toast("Couldn't read that image.", true);
      img.src = String(reader.result);
    };
    reader.onerror = () => toast("Couldn't read that file.", true);
    reader.readAsDataURL(file);
  };

  const noScene = !theme.scene && theme.customBg < 0;
  return (
    <Modal title="Appearance" onClose={onClose}>
      <div className="appearance-form">
        <div className="appearance-group">
          <span className="appearance-label">Mode</span>
          <div className="seg-choice">
            {modes.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.mode === v ? " on" : ""}`} onClick={() => theme.setMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Panel style</span>
          <div className="seg-choice">
            {PANEL_STYLES.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.panelStyle === v ? " on" : ""}`} onClick={() => theme.setPanelStyle(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Panel color</span>
          <div className="swatches">
            <button className={`swatch none${!theme.panelColor ? " on" : ""}`} title="Default" aria-label="Default panel colour" onClick={() => theme.setPanelColor("")} />
            {PANEL_COLORS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.panelColor === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setPanelColor(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Background</span>
          <div className="swatches">
            <button className={`swatch none${!theme.background ? " on" : ""}`} title="Default" aria-label="Default background" onClick={() => theme.setBackground("")} />
            {BACKGROUNDS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.background === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setBackground(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Atmospheres</span>
          <div className="atmo-grid">
            <button className={`atmo-tile none${!theme.atmosphere ? " on" : ""}`} title="None" aria-label="No atmosphere" onClick={() => theme.setAtmosphere("")} />
            {ATMOSPHERES.map((a) => (
              <button key={a.id} className={`atmo-tile${theme.atmosphere === a.id ? " on" : ""}`}
                style={{ backgroundImage: a.overlay }} title={a.name} aria-label={a.name} onClick={() => theme.setAtmosphere(a.id)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Scenes</span>
          <div className="scene-grid">
            <button className={`scene-tile none${noScene ? " on" : ""}`} title="None" aria-label="No scene" onClick={() => { theme.setScene(""); theme.setCustomBg(-1); }} />
            {SCENES.map((s) => (
              <button key={s.id} className={`scene-tile${theme.scene === s.id ? " on" : ""}`}
                style={{ backgroundImage: s.image }} title={s.name} aria-label={s.name} onClick={() => theme.setScene(s.id)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <div className="appearance-row">
            <span className="appearance-label">Custom background</span>
            <span className="appearance-count">{theme.customBgs.length}/{MAX_CUSTOM_BG}</span>
          </div>
          {theme.customBgs.length > 0 && (
            <div className="scene-grid">
              {theme.customBgs.map((url, i) => (
                <div key={i} className={`scene-tile custom${theme.customBg === i ? " on" : ""}`} style={{ backgroundImage: `url("${url}")` }}>
                  <button className="scene-pick" aria-label={`Use custom background ${i + 1}`} onClick={() => theme.setCustomBg(i)} />
                  <button className="scene-del" aria-label="Remove background" onClick={() => theme.removeCustomBg(i)}><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          <button className="upload-bg" disabled={full} onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Upload background
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={onPickFile} />
          <span className="appearance-hint">Static JPG, PNG, WebP, or AVIF · stored on this device</span>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Accent</span>
          <div className="swatches">
            {ACCENTS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.accent === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setAccent(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <div className="appearance-row">
            <span className="appearance-label">Darkness</span>
            <span className="appearance-count">{theme.darkness}%</span>
          </div>
          <input type="range" className="appearance-range" min={0} max={100} step={1} value={theme.darkness}
            onChange={(e) => theme.setDarkness(Number(e.target.value))} aria-label="Darkness" />
          <span className="appearance-hint">Dims the backdrop behind the panels.</span>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Density</span>
          <div className="seg-choice">
            {densities.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.density === v ? " on" : ""}`} onClick={() => theme.setDensity(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Header</span>
          <div className="seg-choice">
            <button className={`seg-opt${!theme.compactHeader ? " on" : ""}`} onClick={() => theme.setCompactHeader(false)}>Full</button>
            <button className={`seg-opt${theme.compactHeader ? " on" : ""}`} onClick={() => theme.setCompactHeader(true)}>Compact</button>
          </div>
          <span className="appearance-hint">Compact hides the progress bar and usage panel so the board gets more room.</span>
        </div>
      </div>
    </Modal>
  );
}
