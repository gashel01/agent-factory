// Render smoke tests: prove key components actually RENDER (not just compile) and
// produce the element structure the CSS/behaviour depend on. typecheck + build pass
// even when a component renders the wrong class or crashes on mount — this catches
// that class (e.g. the supervisor rail rendering `.rail-resize` when the CSS styles
// `.companion-resize`, which shipped "green" but dead).
//
// renderToString runs the render body (not effects), server-side, no DOM. Minimal
// browser-global stubs cover the values a render body may read.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import type { ComponentType } from "react";

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.location ??= { search: "", href: "http://localhost/", reload: () => {} };
g.matchMedia ??= () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
class FakeES { close(): void {} addEventListener(): void {} }
g.EventSource ??= FakeES;

const render = (C: ComponentType<Record<string, unknown>>, props: Record<string, unknown>): string =>
  renderToString(h(C, props));

test("CompanionRail renders the resize handle and drives --companion-width", async () => {
  const { CompanionRail } = await import("../src/work.js");
  const html = render(CompanionRail as unknown as ComponentType<Record<string, unknown>>, {
    obs: [], feed: [], needsYou: [], now: 0, currentRun: "", live: false, railWidth: 340,
    onClose: () => {}, onAnswer: () => {}, onReview: () => {}, onPlan: () => {}, onRailWidth: () => {},
  });
  // The bug that shipped green: handle class must match the CSS, width must flow
  // through the CSS variable the stylesheet sizes the panel with.
  assert.match(html, /companion-resize/, "resize handle must render with the CSS class");
  assert.match(html, /--companion-width/, "panel width must be driven by --companion-width");
  assert.match(html, /Supervisor/, "the rail must render its header");
});
