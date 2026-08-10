/* Deterministic cross-file wiring check: a component-style className used in the
 * TSX that has NO matching rule anywhere in the CSS is almost always a mismatch
 * (the bug where JSX rendered `.rail-resize` but the CSS styled `.companion-resize`,
 * both compiled, and the feature was silently dead). typecheck/build can't see it.
 *
 * Scope, kept deliberately narrow to avoid false positives:
 *  - only hyphenated tokens (component/element names like `companion-resize`),
 *    never state words (`on`, `warn`, `open`) which are styled via compound rules;
 *  - only STATIC string-literal classNames (template-interpolated ones are skipped);
 *  - "has a rule" = the substring `.<token>` appears anywhere in the CSS (so
 *    compound selectors like `.a .token` and `.token.x` still count).
 * Exits non-zero with the offenders listed. */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (dir, ext) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? read(join(dir, d.name), ext) : d.name.endsWith(ext) ? [join(dir, d.name)] : []));

const css = read(join(root, "public", "css"), ".css").map((f) => readFileSync(f, "utf-8")).join("\n");
const tsxFiles = read(join(root, "src"), ".tsx");

// Ratchet baseline: component classNames that legitimately have no CSS rule today
// (JS hooks, default/neutral states styled only via compound rules). The check
// fails on any NEW orphan, so a fresh mismatch like `rail-resize` is caught while
// this known-good set doesn't block every ticket. Prune as these get styled/removed.
const IGNORE = new Set([
  "sr-only",
  "proj-picker", "tone-neutral", "ds-files", "docs-item-main", "raw-body",
]);

const orphans = new Map(); // token -> Set<file>
for (const file of tsxFiles) {
  const src = readFileSync(file, "utf-8");
  // Static className string literals only: className="a b" / className={"a b"}.
  for (const m of src.matchAll(/className=\{?["']([^"'{}]+)["']\}?/g)) {
    for (const tok of m[1].split(/\s+/)) {
      if (!tok.includes("-") || IGNORE.has(tok)) continue; // component-style names only
      if (!css.includes(`.${tok}`)) {
        if (!orphans.has(tok)) orphans.set(tok, new Set());
        orphans.get(tok).add(file.slice(root.length + 1).replaceAll("\\", "/"));
      }
    }
  }
}

if (orphans.size === 0) {
  console.log("check-styles: OK — every component className has a CSS rule.");
  process.exit(0);
}
console.error("check-styles: classNames with NO matching CSS rule (likely a mismatch):");
for (const [tok, files] of orphans) console.error(`  .${tok}  ← ${[...files].join(", ")}`);
process.exit(1);
