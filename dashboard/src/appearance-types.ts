// Appearance system — the data behind the Appearance panel's rich controls.
// Gradients live here (single source of truth); the hook sets them as inline
// CSS variables and the CSS in 08-appearance-polish.css consumes them, so no
// per-value CSS rules are generated.

export type PanelStyle = "max" | "solid" | "glass";

/** [id, swatch-hex] — panel style / colour / background pickers key off these. */
export const PANEL_STYLES: Array<[PanelStyle, string]> = [
  ["max", "Max"] as [PanelStyle, string],
  ["solid", "Solid"] as [PanelStyle, string],
  ["glass", "Glass"] as [PanelStyle, string],
];

// Panel colours tint the surface of every panel. The swatch hex is only for the
// picker dot; the real light/dark surface values are in the CSS.
export const PANEL_COLORS: Array<[string, string]> = [
  ["slate", "#64748b"], ["gray", "#6b7280"], ["neutral", "#78716c"], ["stone", "#a8a29e"],
  ["blue", "#3b82f6"], ["indigo", "#6366f1"], ["violet", "#8b5cf6"], ["snow", "#e5e7eb"],
];

// Background colours paint the page backdrop behind the panels.
export const BACKGROUNDS: Array<[string, string]> = [
  ["zinc", "#18181b"], ["black", "#0a0a0a"], ["blue", "#16233f"], ["violet", "#2a1a45"],
  ["teal", "#103733"], ["rose", "#3a1526"], ["green", "#123322"], ["slate", "#172033"],
  ["indigo", "#1c1a44"],
];

export interface Scene { id: string; name: string; image: string; }

// Scenes are full-bleed CSS gradients (zero-dep, offline) evoking a time/place.
export const SCENES: Scene[] = [
  { id: "dawn",     name: "Dawn",     image: "linear-gradient(165deg,#2b2140 0%,#7c4a6e 42%,#e79c6d 78%,#f6d59a 100%)" },
  { id: "dusk",     name: "Dusk",     image: "linear-gradient(160deg,#1a1430 0%,#4a2a5e 45%,#b0506a 80%,#f0955e 100%)" },
  { id: "midnight", name: "Midnight", image: "radial-gradient(120% 90% at 30% 8%,#1b2452 0%,#0b0f24 60%,#05060f 100%)" },
  { id: "noon",     name: "Noon",     image: "linear-gradient(180deg,#3f7fc4 0%,#8fbde6 55%,#dcefff 100%)" },
  { id: "twilight", name: "Twilight", image: "linear-gradient(170deg,#241a45 0%,#5b3a7e 45%,#c56a8a 85%,#f2b48a 100%)" },
  { id: "aurora",   name: "Aurora",   image: "linear-gradient(160deg,#04121f 0%,#0b3a4a 32%,#1f8f7a 58%,#7ce0a6 82%,#0a1b2a 100%)" },
  { id: "lunar",    name: "Lunar",    image: "radial-gradient(90% 70% at 70% 18%,#3a4152 0%,#1a1d28 55%,#0a0c12 100%)" },
  { id: "forest",   name: "Forest",   image: "linear-gradient(165deg,#0c2a1e 0%,#1f5a3a 50%,#4e8f5a 85%,#93c07a 100%)" },
  { id: "ocean",    name: "Ocean",    image: "linear-gradient(170deg,#04223a 0%,#0a5a7a 50%,#2a9fb0 85%,#7fd6d0 100%)" },
  { id: "desert",   name: "Desert",   image: "linear-gradient(165deg,#2e1d12 0%,#9c5f32 45%,#e0a45c 80%,#f5d79a 100%)" },
];

export interface Atmosphere { id: string; name: string; overlay: string; }

// Atmospheres are subtle translucent overlays laid over the current background —
// a soft wash of light, not a full scene.
export const ATMOSPHERES: Atmosphere[] = [
  { id: "warm",   name: "Warm",   overlay: "radial-gradient(80% 60% at 50% 0%, rgb(255 180 120 / .18), transparent 70%)" },
  { id: "cool",   name: "Cool",   overlay: "radial-gradient(80% 60% at 50% 0%, rgb(120 170 255 / .18), transparent 70%)" },
  { id: "violet", name: "Violet", overlay: "radial-gradient(90% 70% at 20% 8%, rgb(160 120 255 / .20), transparent 70%)" },
  { id: "teal",   name: "Teal",   overlay: "radial-gradient(90% 70% at 82% 8%, rgb(60 200 190 / .18), transparent 70%)" },
  { id: "rose",   name: "Rose",   overlay: "radial-gradient(90% 70% at 50% 100%, rgb(255 120 160 / .18), transparent 70%)" },
  { id: "forest", name: "Forest", overlay: "radial-gradient(100% 80% at 50% 120%, rgb(80 200 120 / .16), transparent 70%)" },
  { id: "night",  name: "Night",  overlay: "radial-gradient(120% 100% at 50% 0%, rgb(40 60 120 / .28), transparent 75%)" },
  { id: "ember",  name: "Ember",  overlay: "radial-gradient(90% 70% at 50% 110%, rgb(255 90 40 / .18), transparent 70%)" },
];

export const ACCENTS: Array<[string, string]> = [
  ["brass", "#cf9f3e"], ["indigo", "#6366f1"], ["teal", "#0d9488"], ["orange", "#ea580c"], ["violet", "#7c3aed"],
];

export const MAX_CUSTOM_BG = 5;
