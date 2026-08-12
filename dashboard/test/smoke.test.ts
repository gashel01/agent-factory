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

test("computeGraph assigns stable lanes and connects merges", async () => {
  const { computeGraph, BranchGraph } = await import("../src/repo-modal.js");
  // A tiny DAG (newest first, topo order): merge M has two parents A and B;
  // A and B both descend from root R.
  const commits = [
    { hash: "M", parents: ["A", "B"], refs: ["HEAD -> main"], author: "x", date: "now", subject: "merge", body: "" },
    { hash: "A", parents: ["R"], refs: [], author: "x", date: "now", subject: "a", body: "" },
    { hash: "B", parents: ["R"], refs: [], author: "x", date: "now", subject: "b", body: "" },
    { hash: "R", parents: [], refs: [], author: "x", date: "now", subject: "root", body: "" },
  ];
  const rows = computeGraph(commits);
  assert.equal(rows.length, 4, "one row per commit");
  assert.equal(rows[0].col, 0, "the merge sits on the primary lane");
  // B must open a second lane (the merge fans out to two parent columns).
  assert.ok(rows.some((r: { lanes: number }) => r.lanes >= 2), "a second lane opens for the merge");
  // The graph renders the railroad + a ref chip without throwing.
  const html = render(BranchGraph as unknown as ComponentType<Record<string, unknown>>, {
    commits, onPick: () => {}, active: null, compareFrom: null,
  });
  assert.match(html, /graph-rail/, "each row renders its SVG rail");
  assert.match(html, /graph-ref/, "branch refs render as chips");
});

test("DecisionModal renders options side by side with a sandboxed preview", async () => {
  const { DecisionModal } = await import("../src/decision-view.js");
  const html = render(DecisionModal as unknown as ComponentType<Record<string, unknown>>, {
    taskId: "042", title: "Header layout", question: "which header layout?",
    options: [
      { id: "a", label: "Sidebar left", detail: "nav in a left rail",
        preview_html: "<div>left</div>" },
      { id: "b", label: "Top bar", detail: "nav across the top" },
    ],
    onClose: () => {},
  });
  assert.match(html, /Sidebar left/, "each option's label renders");
  assert.match(html, /Top bar/, "the second option renders");
  // The visual option's preview is rendered in a locked-down (scriptless) iframe.
  assert.match(html, /decide-frame/, "a preview iframe renders for the visual option");
  assert.match(html, /sandbox=""/, "the preview iframe is sandboxed (no scripts)");
  // The option without preview shows the placeholder, not an empty frame.
  assert.match(html, /decide-noprev/, "the no-preview option shows a placeholder");
});

test("BoardModal renders the palette and an empty grid canvas", async () => {
  const { BoardModal } = await import("../src/board-canvas.js");
  const html = render(BoardModal as unknown as ComponentType<Record<string, unknown>>, {
    onClose: () => {},
  });
  assert.match(html, /bd-svg/, "the SVG canvas renders");
  assert.match(html, /bd-tool/, "the shape palette renders");
  assert.match(html, /Drop system map/, "the agent-layer drop action renders");
  assert.match(html, /bd-grid/, "the dotted grid backdrop renders");
});
