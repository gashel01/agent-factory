import { useEffect, useState } from "react";
import type { PanelStyle } from "./appearance-types.js";
import { ATMOSPHERES, MAX_CUSTOM_BG, SCENES } from "./appearance-types.js";

export type ThemeMode = "system" | "light" | "dark";

export interface Appearance {
  dark: boolean;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
  accent: string;
  setAccent: (a: string) => void;
  density: string;
  setDensity: (d: string) => void;
  compactHeader: boolean;
  setCompactHeader: (v: boolean) => void;
  panelStyle: PanelStyle;
  setPanelStyle: (v: PanelStyle) => void;
  panelColor: string;                 // "" = theme default
  setPanelColor: (v: string) => void;
  background: string;                 // "" = none (theme --bg)
  setBackground: (v: string) => void;
  scene: string;                      // "" = none
  setScene: (v: string) => void;
  atmosphere: string;                 // "" = none
  setAtmosphere: (v: string) => void;
  customBgs: string[];                // data URLs, stored on this device
  addCustomBg: (dataUrl: string) => void;
  removeCustomBg: (i: number) => void;
  customBg: number;                   // index into customBgs, or -1
  setCustomBg: (i: number) => void;
  darkness: number;                   // 0..100 backdrop dimmer
  setDarkness: (v: number) => void;
}

export function readPref(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function readNum(key: string, fallback: number): number {
  const n = Number(readPref(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

function readList(key: string): string[] {
  try { const v = JSON.parse(readPref(key, "[]")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

export function useTheme(): Appearance {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const s = readPref("factory.theme", "system");
    return s === "dark" || s === "light" || s === "system" ? s : "system";
  });
  const [accent, setAccentState] = useState(() => readPref("factory.accent", "brass"));
  const [density, setDensityState] = useState(() => readPref("factory.density", "comfortable"));
  const [compactHeader, setCompactHeaderState] = useState(() => readPref("factory.headerCompact", "0") === "1");
  const [panelStyle, setPanelStyleState] = useState<PanelStyle>(() => {
    const s = readPref("factory.panelStyle", "max");
    return s === "solid" || s === "glass" ? s : "max";
  });
  const [panelColor, setPanelColorState] = useState(() => readPref("factory.panelColor", ""));
  const [background, setBackgroundState] = useState(() => readPref("factory.background", ""));
  const [scene, setSceneState] = useState(() => readPref("factory.scene", ""));
  const [atmosphere, setAtmosphereState] = useState(() => readPref("factory.atmosphere", ""));
  const [customBgs, setCustomBgsState] = useState<string[]>(() => readList("factory.customBgs"));
  const [customBg, setCustomBgState] = useState(() => readNum("factory.customBg", -1));
  const [darkness, setDarknessState] = useState(() => readNum("factory.darkness", 0));
  const [sysDark, setSysDark] = useState<boolean>(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => setSysDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark = mode === "dark" || (mode === "system" && sysDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-accent", accent);
    el.setAttribute("data-density", density);
    el.setAttribute("data-header", compactHeader ? "compact" : "full");
  }, [accent, density, compactHeader]);
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-panel", panelStyle);
    if (panelColor) el.setAttribute("data-panel-color", panelColor); else el.removeAttribute("data-panel-color");
    if (background) el.setAttribute("data-bg", background); else el.removeAttribute("data-bg");
    el.style.setProperty("--app-darkness", String(darkness));
    const custom = customBg >= 0 && customBg < customBgs.length ? customBgs[customBg] : null;
    const sceneImg = SCENES.find((s) => s.id === scene)?.image ?? null;
    const bgImage = custom ? `url("${custom}")` : sceneImg;
    if (bgImage) el.style.setProperty("--app-scene", bgImage); else el.style.removeProperty("--app-scene");
    const atmo = ATMOSPHERES.find((a) => a.id === atmosphere)?.overlay ?? null;
    if (atmo) el.style.setProperty("--app-atmo", atmo); else el.style.removeProperty("--app-atmo");
  }, [panelStyle, panelColor, background, scene, atmosphere, customBg, customBgs, darkness]);

  const persist = (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  };
  return {
    dark, mode, accent, density, compactHeader,
    panelStyle, panelColor, background, scene, atmosphere, customBgs, customBg, darkness,
    setMode: (m) => { setModeState(m); persist("factory.theme", m); },
    setAccent: (a) => { setAccentState(a); persist("factory.accent", a); },
    setDensity: (d) => { setDensityState(d); persist("factory.density", d); },
    setCompactHeader: (v) => { setCompactHeaderState(v); persist("factory.headerCompact", v ? "1" : "0"); },
    setPanelStyle: (v) => { setPanelStyleState(v); persist("factory.panelStyle", v); },
    setPanelColor: (v) => { setPanelColorState(v); persist("factory.panelColor", v); },
    setBackground: (v) => { setBackgroundState(v); persist("factory.background", v); },
    setScene: (v) => { setSceneState(v); persist("factory.scene", v); if (v) { setCustomBgState(-1); persist("factory.customBg", "-1"); } },
    setAtmosphere: (v) => { setAtmosphereState(v); persist("factory.atmosphere", v); },
    addCustomBg: (dataUrl) => {
      setCustomBgsState((prev) => {
        const next = [...prev, dataUrl].slice(-MAX_CUSTOM_BG);
        persist("factory.customBgs", JSON.stringify(next));
        const idx = next.length - 1;
        setCustomBgState(idx); persist("factory.customBg", String(idx));
        setSceneState(""); persist("factory.scene", "");
        return next;
      });
    },
    removeCustomBg: (i) => {
      setCustomBgsState((prev) => {
        const next = prev.filter((_, k) => k !== i);
        persist("factory.customBgs", JSON.stringify(next));
        setCustomBgState((cur) => { const nc = cur === i ? -1 : cur > i ? cur - 1 : cur; persist("factory.customBg", String(nc)); return nc; });
        return next;
      });
    },
    setCustomBg: (i) => { setCustomBgState(i); persist("factory.customBg", String(i)); if (i >= 0) { setSceneState(""); persist("factory.scene", ""); } },
    setDarkness: (v) => { setDarknessState(v); persist("factory.darkness", String(v)); },
    toggle: () => { const m = dark ? "light" : "dark"; setModeState(m); persist("factory.theme", m); },
  };
}
