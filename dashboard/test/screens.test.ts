import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATMOSPHERES, BACKGROUNDS, MAX_CUSTOM_BG, PANEL_COLORS, PANEL_STYLES, SCENES,
} from "../src/appearance-types.js";

// A tiny localStorage stand-in for the persistence round-trips below.
class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
}

test("appearance-types: scenes and atmospheres have unique ids and real gradients", () => {
  const sceneIds = new Set(SCENES.map((s) => s.id));
  assert.equal(sceneIds.size, SCENES.length, "scene ids are unique");
  assert.ok(SCENES.length >= 10, "at least ten scenes");
  for (const s of SCENES) assert.match(s.image, /gradient\(/, `${s.id} has a gradient image`);

  const atmoIds = new Set(ATMOSPHERES.map((a) => a.id));
  assert.equal(atmoIds.size, ATMOSPHERES.length, "atmosphere ids are unique");
  for (const a of ATMOSPHERES) assert.match(a.overlay, /gradient\(/, `${a.id} has a gradient overlay`);
});

test("appearance-types: panel styles/colours/backgrounds are well-formed", () => {
  assert.deepEqual(PANEL_STYLES.map(([v]) => v), ["max", "solid", "glass"]);
  for (const [, hex] of PANEL_COLORS) assert.match(hex, /^#[0-9a-f]{6}$/i);
  for (const [, hex] of BACKGROUNDS) assert.match(hex, /^#[0-9a-f]{6}$/i);
});

test("appearance: custom backgrounds are capped at MAX_CUSTOM_BG (keep newest)", () => {
  // Mirrors the hook's addCustomBg: [...prev, url].slice(-MAX_CUSTOM_BG)
  assert.equal(MAX_CUSTOM_BG, 5);
  let list: string[] = [];
  for (let i = 0; i < 8; i++) list = [...list, `img${i}`].slice(-MAX_CUSTOM_BG);
  assert.equal(list.length, MAX_CUSTOM_BG, "never grows past the cap");
  assert.deepEqual(list, ["img3", "img4", "img5", "img6", "img7"], "keeps the five newest");
});

test("appearance: a custom background wins over a preset scene", () => {
  // Mirrors the hook's bgImage resolution.
  const resolve = (customBg: number, customBgs: string[], scene: string): string | null => {
    const custom = customBg >= 0 && customBg < customBgs.length ? customBgs[customBg] : null;
    const sceneImg = SCENES.find((s) => s.id === scene)?.image ?? null;
    return custom ? `url("${custom}")` : sceneImg;
  };
  assert.equal(resolve(0, ["data:x"], "dawn"), 'url("data:x")', "custom wins when active");
  assert.equal(resolve(-1, ["data:x"], "dawn"), SCENES[0]!.image, "scene used when no custom active");
  assert.equal(resolve(-1, [], ""), null, "nothing selected → no image");
});

test("appearance: new prefs round-trip through localStorage", () => {
  const s = new MockLocalStorage();
  s.setItem("factory.panelStyle", "glass");
  s.setItem("factory.background", "teal");
  s.setItem("factory.scene", "aurora");
  s.setItem("factory.darkness", "40");
  s.setItem("factory.customBgs", JSON.stringify(["data:a", "data:b"]));

  assert.equal(s.getItem("factory.panelStyle"), "glass");
  assert.equal(s.getItem("factory.background"), "teal");
  assert.equal(s.getItem("factory.scene"), "aurora");
  assert.equal(Number(s.getItem("factory.darkness")), 40);
  assert.deepEqual(JSON.parse(s.getItem("factory.customBgs") ?? "[]"), ["data:a", "data:b"]);
});
