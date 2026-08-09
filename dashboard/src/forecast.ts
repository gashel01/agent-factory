/** Pure cost-forecast core: what will this backlog cost *before* we launch it,
 *  and — afterwards — how good was the guess?
 *
 *  Deliberately pure and total: no Node builtin import, no I/O, no DOM, no clock and
 *  no module-level mutable state, so the fs/HTTP layer and the pre-launch dialog
 *  can both import it and every branch stays unit-testable.
 *
 *  Totality contract, enforced by the tests: nothing here throws, and no field
 *  of any returned object is ever NaN, Infinity or undefined — for empty
 *  backlogs, zero-token runs, negative or absurd inputs, or unknown models.
 *  Every division is guarded at the point of use, via `safeDiv` or an explicit
 *  `> 0` check on the denominator.
 *
 *  Money convention: USD is rounded to cents at the boundary — each per-ticket
 *  figure is rounded, and run totals are the sum of those *already rounded*
 *  figures, so the per-ticket rows always add up to the total on screen.
 */

// ---------------------------------------------------------------------------
// Numeric guards — the single choke point that keeps NaN/Infinity out.
// ---------------------------------------------------------------------------

/** Coerce to a finite number, or fall back. Everything numeric goes through this. */
function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  const n = num(value, lo);
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  // `+ 0` normalises -0 to 0: the strict assert module compares with Object.is, and a
  // stray -0 would fail an otherwise-correct `assert.equal(x, 0)`.
  return Math.round(num(value) * f) / f + 0;
}

/** Money, rounded to cents. */
function usd(value: number): number {
  return round(value, 2);
}

/** A whole, non-negative count (tokens). */
function whole(value: number): number {
  return Math.max(0, Math.round(num(value)));
}

/** Division that can never produce NaN or Infinity. */
function safeDiv(a: number, b: number, fallback: number): number {
  const den = num(b, 0);
  return den > 0 || den < 0 ? num(num(a) / den, fallback) : fallback;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += num(x);
  return safeDiv(sum, xs.length, 0);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.map((x) => num(x)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// Tickets — front matter without a YAML dependency.
// ---------------------------------------------------------------------------

/** A backlog ticket, normalised. Only the front-matter fields the forecast
 *  actually reasons about are typed here; the rest of the YAML is ignored. */
export interface Ticket {
  file: string;
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  hold: boolean;
  depends_on: string[];
  priority: number;
  timeout_min: number | null;
  verify: string[];
  model: string | null;
  effort: string | null;
}

/** Callers (and other tickets' code) may hand us half-built tickets. */
export type TicketInput = Partial<Ticket>;

/** `---` opens the block, `---` or `...` closes it (both are YAML document ends). */
const FENCE = /^(?:---|\.\.\.)\s*$/;

function baseName(file: string): string {
  const tail = file.replace(/\\/g, "/").split("/").pop() ?? "";
  return tail.replace(/\.[^.]+$/, "") || tail || "ticket";
}

/** Trim a scalar: drop a trailing `# comment` on unquoted values, then unwrap quotes. */
function unquote(raw: string): string {
  let v = raw.trim();
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
  const quoted = v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
  return quoted ? v.slice(1, -1) : v;
}

type FrontMatter = Record<string, string | string[]>;

/** Only `key: value` and `- item` are supported — no nesting, no anchors, no
 *  flow maps. Indentation is ignored on purpose: that flattens a nested block
 *  such as `budget:` / `  timeout_min: 30` onto the key the caller asks for.
 *  Any line we cannot make sense of is skipped, never fatal. */
function parseFrontMatter(lines: readonly string[]): FrontMatter {
  const out: FrontMatter = {};
  let listKey: string | null = null;
  for (const raw of lines) {
    const line = raw ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item && listKey) {
      const current = out[listKey];
      const arr = Array.isArray(current) ? current : [];
      const value = unquote(item[1] ?? "");
      if (value) arr.push(value);
      out[listKey] = arr;
      continue;
    }
    const kv = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const value = unquote(kv[2] ?? "");
    if (!value) {
      // A bare `key:` opens a block list; if nothing follows it stays empty.
      out[key] = [];
      listKey = key;
      continue;
    }
    out[key] = value;
    listKey = null;
  }
  return out;
}

function fmString(fm: FrontMatter, key: string): string {
  const v = fm[key];
  if (Array.isArray(v)) return v[0] ?? "";
  return typeof v === "string" ? v : "";
}

function fmList(fm: FrontMatter, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v.map((s) => String(s)).filter((s) => s.length > 0);
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (!s) return [];
  // Inline flow list: `depends_on: [001, 002]`.
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map((p) => unquote(p)).filter((p) => p.length > 0);
  }
  return [s];
}

const TRUTHY = new Set(["true", "yes", "on", "1"]);

/** Split front matter from body and normalise. A file with no front matter,
 *  empty content or malformed lines still yields a usable ticket (id and title
 *  fall back to the filename) and never throws. */
export function parseTicket(file: string, content: string): Ticket {
  const name = baseName(typeof file === "string" ? file : "");
  const fallback: Ticket = {
    file: typeof file === "string" ? file : "",
    id: name,
    title: name,
    body: "",
    assignee: null,
    hold: false,
    depends_on: [],
    priority: 0,
    timeout_min: null,
    verify: [],
    model: null,
    effort: null,
  };
  try {
    const raw = typeof content === "string" ? content : "";
    // Strip a leading BOM (U+FEFF) so the `---` fence is still the first line.
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    let fm: FrontMatter = {};
    let body = text;
    let first = 0;
    while (first < lines.length && (lines[first] ?? "").trim() === "") first++;
    if ((lines[first] ?? "").trim() === "---") {
      let end = -1;
      for (let i = first + 1; i < lines.length; i++) {
        if (FENCE.test(lines[i] ?? "")) { end = i; break; }
      }
      // An unterminated block is treated as "no front matter" rather than
      // swallowing the whole file as metadata.
      if (end > first) {
        fm = parseFrontMatter(lines.slice(first + 1, end));
        body = lines.slice(end + 1).join("\n");
      }
    }
    const id = fmString(fm, "id") || name;
    const timeout = num(fmString(fm, "timeout_min"), 0);
    return {
      file: fallback.file,
      id,
      title: fmString(fm, "title") || name,
      body,
      assignee: fmString(fm, "assignee") || null,
      hold: TRUTHY.has(fmString(fm, "hold").toLowerCase()),
      depends_on: fmList(fm, "depends_on"),
      // A non-numeric priority (`priority: high`) scores as 0 rather than NaN.
      priority: round(num(fmString(fm, "priority"), 0), 3),
      timeout_min: timeout > 0 ? Math.round(timeout) : null,
      verify: fmList(fm, "verify"),
      model: fmString(fm, "model") || null,
      effort: fmString(fm, "effort") || null,
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

export interface ModelPrice {
  id: string;
  label: string;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** Indicative published list prices in USD per million tokens, taken from
 *  Anthropic's public pricing page (anthropic.com/pricing) and keyed by model
 *  *tier* rather than by dated model id — the factory configures agents with
 *  tier aliases ("haiku", "sonnet", "opus") and `priceFor` resolves dated ids
 *  down to their tier.
 *
 *  These are estimates for a pre-launch dialog, not billing figures: published
 *  rates change, long-context and cached-token rates differ, and subscription
 *  runs are not billed per token at all. Refresh from the pricing page when it
 *  moves. */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  haiku: { id: "haiku", label: "Haiku", inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { id: "sonnet", label: "Sonnet", inputPerMTok: 3, outputPerMTok: 15 },
  opus: { id: "opus", label: "Opus", inputPerMTok: 15, outputPerMTok: 75 },
};

/** Unknown or missing ids price as Sonnet: it is the factory's own default tier
 *  and the middle of the table, so a wrong guess is off by at most one tier. */
export const DEFAULT_MODEL = "sonnet";

const FALLBACK_PRICE: ModelPrice = { id: DEFAULT_MODEL, label: "Sonnet", inputPerMTok: 3, outputPerMTok: 15 };

/** Resolve a model id to a price. Always returns an entry — never null. */
export function priceFor(model?: string | null): ModelPrice {
  const raw = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (raw) {
    const exact = MODEL_PRICING[raw];
    if (exact) return exact;
    // Tolerate provider prefixes, dated suffixes and bracketed variants:
    // "claude-opus-4-1-20250805", "us.anthropic.claude-3-5-haiku-v1:0", "opus[1m]".
    for (const key of Object.keys(MODEL_PRICING)) {
      if (raw.includes(key)) {
        const hit = MODEL_PRICING[key];
        if (hit) return hit;
      }
    }
  }
  return MODEL_PRICING[DEFAULT_MODEL] ?? FALLBACK_PRICE;
}

// ---------------------------------------------------------------------------
// Complexity
// ---------------------------------------------------------------------------

export interface ComplexityInput {
  body?: string | null;
  verify?: readonly string[] | null;
  depends_on?: readonly string[] | null;
  timeout_min?: number | null;
}

/** Weight per unit of each signal, chosen so that a "typical" ticket (~2k chars
 *  of body, a handful of criteria, 2 verify commands) lands near 0.6. */
const COMPLEXITY_WEIGHTS = {
  bodyChar: 0.9 / 2000,
  criterion: 0.5 / 8,
  verify: 0.6 / 4,
  depends: 0.4 / 3,
  timeoutMin: 0.5 / 60,
} as const;

/** Bullets, numbered steps and checkboxes all read as acceptance criteria. */
const CRITERION_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

function countCriteria(body: string): number {
  let n = 0;
  for (const line of body.split("\n")) if (CRITERION_LINE.test(line)) n++;
  return n;
}

/** Ticket "size" in [0, 1). Monotonic by construction: every signal enters a
 *  positively-weighted sum, and the sum is saturated once by 1 - e^-x, which is
 *  strictly increasing — so more body, more criteria, more verify commands,
 *  more dependencies or a longer timeout can never lower the score. It
 *  approaches 1 smoothly instead of clipping at a threshold. */
export function complexityOf(ticket?: ComplexityInput | null): number {
  const body = typeof ticket?.body === "string" ? ticket.body : "";
  const verify = Array.isArray(ticket?.verify) ? ticket.verify.length : 0;
  const depends = Array.isArray(ticket?.depends_on) ? ticket.depends_on.length : 0;
  const timeout = Math.max(0, num(ticket?.timeout_min, 0));
  const raw =
    body.length * COMPLEXITY_WEIGHTS.bodyChar +
    countCriteria(body) * COMPLEXITY_WEIGHTS.criterion +
    verify * COMPLEXITY_WEIGHTS.verify +
    depends * COMPLEXITY_WEIGHTS.depends +
    timeout * COMPLEXITY_WEIGHTS.timeoutMin;
  // Clamping the exponent keeps exp() finite for absurd inputs (a 10MB body).
  return round(1 - Math.exp(-clamp(raw, 0, 40)), 3);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type ProfileName = "cheap" | "standard" | "thorough";

export interface Profile {
  name: ProfileName;
  label: string;
  model: string;
  effort: "low" | "medium" | "high";
  /** Multiplier on the baseline number of agent turns per ticket. */
  turns: number;
  /** Multiplier on the tokens each turn burns (context depth). */
  tokens: number;
  /** Expected attempts per ticket, retries included — always >= 1. */
  retries: number;
}

export const PROFILE_NAMES: readonly ProfileName[] = ["cheap", "standard", "thorough"];

/** Three ways to run the same backlog. Ordered by cost by construction: the
 *  models get pricier and every multiplier grows, so for one backlog
 *  cheap <= standard <= thorough always holds. */
export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  cheap: { name: "cheap", label: "Cheap", model: "haiku", effort: "low", turns: 0.7, tokens: 0.8, retries: 1.05 },
  standard: { name: "standard", label: "Standard", model: "sonnet", effort: "medium", turns: 1, tokens: 1, retries: 1.25 },
  thorough: { name: "thorough", label: "Thorough", model: "opus", effort: "high", turns: 1.4, tokens: 1.25, retries: 1.6 },
};

function isProfileName(s: string): s is ProfileName {
  return s === "cheap" || s === "standard" || s === "thorough";
}

/** Accept a name or a hand-rolled profile object; always yield a sane profile. */
function resolveProfile(p?: ProfileName | Profile | string | null): Profile {
  if (p && typeof p === "object") {
    const name = typeof p.name === "string" && isProfileName(p.name) ? p.name : "standard";
    return {
      name,
      label: typeof p.label === "string" && p.label ? p.label : PROFILES[name].label,
      model: typeof p.model === "string" && p.model ? p.model : PROFILES[name].model,
      effort: p.effort === "low" || p.effort === "medium" || p.effort === "high" ? p.effort : PROFILES[name].effort,
      turns: Math.max(0, num(p.turns, 1)),
      tokens: Math.max(0, num(p.tokens, 1)),
      retries: Math.max(1, num(p.retries, 1)),
    };
  }
  if (typeof p === "string" && isProfileName(p)) return PROFILES[p];
  return PROFILES.standard;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** One past run, as `summarizeRun` in server-core.ts reports it (mirrored by
 *  `RunPoint` in board.tsx). Declared locally so this module stays dependency-free. */
export interface RunRecord {
  run?: string;
  ts?: string | null;
  spend?: number;
  tokens?: number;
  merged?: number;
  needs?: number;
  total?: number;
  mode?: string;
}

export interface HistoryStats {
  /** Runs that carried usable per-ticket signal. */
  runs: number;
  /** Tickets attempted across those runs. */
  tickets: number;
  /** Per-ticket data points behind the averages — what `trust` is built on. */
  samples: number;
  meanUsdPerTicket: number;
  medianUsdPerTicket: number;
  meanTokensPerTicket: number;
  medianTokensPerTicket: number;
  /** How far to lean on this history, in [0, 1). */
  trust: number;
}

/** Sample count at which trust reaches 0.5; it then approaches 1 asymptotically,
 *  so one lucky run never overrides the heuristic. */
const TRUST_HALF_LIFE = 3;

const ZERO_HISTORY: HistoryStats = {
  runs: 0,
  tickets: 0,
  samples: 0,
  meanUsdPerTicket: 0,
  medianUsdPerTicket: 0,
  meanTokensPerTicket: 0,
  medianTokensPerTicket: 0,
  trust: 0,
};

/** Per-ticket averages from past runs. Runs with no tickets, or with neither
 *  spend nor tokens, carry no signal and are dropped — which is also what keeps
 *  the `spend / total` division safe. Zero runs yields a zero-sample result. */
export function historyStats(runs?: readonly RunRecord[] | null): HistoryStats {
  if (!Array.isArray(runs) || runs.length === 0) return { ...ZERO_HISTORY };
  const usdSamples: number[] = [];
  const tokenSamples: number[] = [];
  let used = 0;
  let tickets = 0;
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const total = Math.max(0, num(r.total, 0));
    if (total <= 0) continue;
    const spend = Math.max(0, num(r.spend, 0));
    const toks = Math.max(0, num(r.tokens, 0));
    if (spend <= 0 && toks <= 0) continue;
    used++;
    tickets += Math.round(total);
    if (spend > 0) usdSamples.push(spend / total);
    if (toks > 0) tokenSamples.push(toks / total);
  }
  const samples = Math.max(usdSamples.length, tokenSamples.length);
  if (samples === 0) return { ...ZERO_HISTORY };
  return {
    runs: used,
    tickets,
    samples,
    meanUsdPerTicket: usd(mean(usdSamples)),
    medianUsdPerTicket: usd(median(usdSamples)),
    meanTokensPerTicket: whole(mean(tokenSamples)),
    medianTokensPerTicket: whole(median(tokenSamples)),
    trust: round(safeDiv(samples, samples + TRUST_HALF_LIFE, 0), 3),
  };
}

function normaliseHistory(h?: HistoryStats | null): HistoryStats {
  if (!h || typeof h !== "object") return { ...ZERO_HISTORY };
  return {
    runs: whole(h.runs),
    tickets: whole(h.tickets),
    samples: whole(h.samples),
    meanUsdPerTicket: Math.max(0, usd(h.meanUsdPerTicket)),
    medianUsdPerTicket: Math.max(0, usd(h.medianUsdPerTicket)),
    meanTokensPerTicket: whole(h.meanTokensPerTicket),
    medianTokensPerTicket: whole(h.medianTokensPerTicket),
    trust: clamp01(num(h.trust, 0)),
  };
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

/** Total (input + output) tokens a mid-complexity ticket burns on the standard
 *  profile — the anchor the heuristic scales by complexity and profile. */
const BASE_TOKENS_PER_TICKET = 120_000;
/** Share of those tokens that are *output*. Coding agents read (and replay
 *  cached context) far more than they write, so the split is heavily input-side. */
const OUTPUT_SHARE = 0.15;
/** Wall-clock a mid-complexity ticket takes on the standard profile, in minutes. */
const BASE_MINUTES_PER_TICKET = 8;
const DEFAULT_SLOTS = 3;
/** Above this trust, history alone is reported as the basis (~17 comparable runs). */
const HISTORY_ONLY_TRUST = 0.85;

export type ForecastBasis = "history" | "heuristic" | "blend";

export interface ForecastOpts {
  profile?: ProfileName | Profile | null;
  /** Agents running in parallel; drives the wall-clock estimate. */
  slots?: number;
  history?: HistoryStats | null;
}

export interface TicketForecast {
  id: string;
  title: string;
  complexity: number;
  tokens: number;
  usd: number;
  minutes: number;
}

export interface SkippedTicket {
  id: string;
  title: string;
  reason: "hold" | "human";
}

export interface Forecast {
  profile: ProfileName;
  model: string;
  effort: string;
  slots: number;
  tickets: TicketForecast[];
  /** Held and human-owned tickets: reported, but not in the totals. */
  skipped: SkippedTicket[];
  counted: number;
  tokens: number;
  usd: number;
  low: number;
  high: number;
  minutes: number;
  basis: ForecastBasis;
  confidence: number;
}

/** Relative token volume of a profile: turns × context depth × attempts. */
function tokenScale(p: Profile): number {
  return Math.max(0, num(p.turns, 1) * num(p.tokens, 1) * num(p.retries, 1));
}

/** USD per million tokens at this module's input/output split. */
function blendedPrice(price: ModelPrice): number {
  return Math.max(0, num(price.inputPerMTok)) * (1 - OUTPUT_SHARE) + Math.max(0, num(price.outputPerMTok)) * OUTPUT_SHARE;
}

/** Relative money burn of a profile: volume × its model's blended price. */
function costScale(p: Profile): number {
  return tokenScale(p) * blendedPrice(priceFor(p.model));
}

function ticketId(t: TicketInput, index: number): string {
  const id = typeof t.id === "string" ? t.id.trim() : "";
  if (id) return id;
  const file = typeof t.file === "string" ? t.file.trim() : "";
  if (file) return baseName(file);
  return `ticket-${index + 1}`;
}

/** Estimate a run. History is folded in proportionally to its trust, per metric,
 *  and rescaled to the requested profile — so the profile ordering survives the
 *  blend. With no history the result is the pure heuristic. */
export function forecastRun(tickets?: readonly TicketInput[] | null, opts?: ForecastOpts | null): Forecast {
  const profile = resolveProfile(opts?.profile);
  const price = priceFor(profile.model);
  const slots = Math.max(1, Math.round(num(opts?.slots, DEFAULT_SLOTS)));
  const history = normaliseHistory(opts?.history);
  const list = Array.isArray(tickets) ? tickets.filter((t): t is TicketInput => Boolean(t) && typeof t === "object") : [];

  const skipped: SkippedTicket[] = [];
  const counted: Array<{ ticket: TicketInput; id: string; title: string; complexity: number }> = [];
  list.forEach((t, i) => {
    const id = ticketId(t, i);
    const title = (typeof t.title === "string" && t.title.trim()) || id;
    if (t.hold === true) { skipped.push({ id, title, reason: "hold" }); return; }
    if (String(t.assignee ?? "").trim().toLowerCase() === "human") { skipped.push({ id, title, reason: "human" }); return; }
    counted.push({ ticket: t, id, title, complexity: clamp01(complexityOf(t)) });
  });

  // History is per *average* ticket; spread it over this backlog by complexity.
  const meanComplexity = counted.length ? mean(counted.map((c) => c.complexity)) : 0;
  const histTokenScale = safeDiv(tokenScale(profile), tokenScale(PROFILES.standard), 1);
  const histCostScale = safeDiv(costScale(profile), costScale(PROFILES.standard), 1);
  // A metric with no samples must not drag the blend towards zero.
  const usdWeight = history.medianUsdPerTicket > 0 ? clamp01(history.trust) : 0;
  const tokenWeight = history.medianTokensPerTicket > 0 ? clamp01(history.trust) : 0;

  const rows: TicketForecast[] = counted.map((c) => {
    const share = meanComplexity > 0 ? safeDiv(c.complexity, meanComplexity, 1) : 1;
    const heuristicTokens = BASE_TOKENS_PER_TICKET * (0.5 + 1.5 * c.complexity) * tokenScale(profile);
    const heuristicUsd = safeDiv(heuristicTokens, 1_000_000, 0) * blendedPrice(price);
    const historyTokens = history.medianTokensPerTicket * share * histTokenScale;
    const historyUsd = history.medianUsdPerTicket * share * histCostScale;
    const estMinutes =
      BASE_MINUTES_PER_TICKET * (0.4 + 1.6 * c.complexity) * Math.max(0, num(profile.turns, 1)) * Math.max(1, num(profile.retries, 1));
    // `timeout_min` is the ticket's own ceiling, so it caps the estimate.
    const cap = Math.max(0, num(c.ticket.timeout_min, 0));
    return {
      id: c.id,
      title: c.title,
      complexity: round(c.complexity, 3),
      tokens: whole(tokenWeight * historyTokens + (1 - tokenWeight) * heuristicTokens),
      usd: Math.max(0, usd(usdWeight * historyUsd + (1 - usdWeight) * heuristicUsd)),
      minutes: Math.max(0, round(cap > 0 ? Math.min(estMinutes, cap) : estMinutes, 1)),
    };
  });

  const totalTokens = rows.reduce((a, r) => a + r.tokens, 0);
  // Sum of the already-rounded rows, so the table always adds up to the total.
  const totalUsd = usd(rows.reduce((a, r) => a + r.usd, 0));
  const serialMinutes = rows.reduce((a, r) => a + r.minutes, 0);
  const longest = rows.reduce((a, r) => Math.max(a, r.minutes), 0);
  // Perfect packing across `slots`, but never faster than the longest ticket.
  const minutes = Math.max(0, round(Math.max(longest, safeDiv(serialMinutes, slots, 0)), 1));

  const size = rows.length;
  const confidence = round(clamp01(0.3 + 0.5 * clamp01(history.trust) + 0.2 * safeDiv(size, size + 4, 0)), 3);
  // The range tightens as confidence rises: ±55% at worst, ±20% at best.
  const spread = clamp(0.55 - 0.35 * confidence, 0.15, 0.6);
  const low = Math.max(0, usd(totalUsd * (1 - spread)));
  const high = Math.max(low, usd(totalUsd * (1 + spread)));

  const hasHistory = usdWeight > 0 || tokenWeight > 0;
  const basis: ForecastBasis = !hasHistory ? "heuristic" : history.trust >= HISTORY_ONLY_TRUST ? "history" : "blend";

  return {
    profile: profile.name,
    model: profile.model,
    effort: profile.effort,
    slots,
    tickets: rows,
    skipped,
    counted: size,
    tokens: whole(totalTokens),
    usd: totalUsd,
    low,
    high,
    minutes,
    basis,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ActualTicket {
  id?: string;
  title?: string;
  usd?: number;
  tokens?: number;
}

export interface Actuals {
  tickets?: readonly ActualTicket[] | null;
  /** Run totals; when absent they are summed from `tickets`. */
  usd?: number;
  tokens?: number;
}

export interface TicketReconcile {
  id: string;
  title: string;
  forecastUsd: number;
  actualUsd: number;
  deltaUsd: number;
  relUsd: number;
  forecastTokens: number;
  actualTokens: number;
  deltaTokens: number;
  relTokens: number;
  /** `missing` = forecast but never ran; `extra` = ran but never forecast. */
  status: "matched" | "missing" | "extra";
}

export interface Reconciliation {
  tickets: TicketReconcile[];
  matched: number;
  missing: number;
  extra: number;
  forecastUsd: number;
  actualUsd: number;
  deltaUsd: number;
  relUsd: number;
  forecastTokens: number;
  actualTokens: number;
  deltaTokens: number;
  relTokens: number;
  withinRange: boolean;
  accuracy: number;
}

/** Relative error. With nothing forecast, any actual spend reads as +100%. */
function relative(forecast: number, actual: number): number {
  const f = num(forecast);
  const a = num(actual);
  if (f > 0) return round(safeDiv(a - f, f, 0), 3);
  return a > 0 ? 1 : 0;
}

function reconcileKey(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/** Score a forecast against what actually happened. Tickets present on only one
 *  side are reported (`missing` / `extra`), never silently dropped. */
export function reconcile(forecast?: Forecast | null, actuals?: Actuals | null): Reconciliation {
  const forecastRows = Array.isArray(forecast?.tickets)
    ? forecast.tickets.filter((t): t is TicketForecast => Boolean(t) && typeof t === "object")
    : [];
  const actualRows = Array.isArray(actuals?.tickets)
    ? actuals.tickets.filter((t): t is ActualTicket => Boolean(t) && typeof t === "object")
    : [];

  // Duplicated ids on the actuals side accumulate rather than overwrite.
  const byKey = new Map<string, { id: string; title: string; usd: number; tokens: number }>();
  actualRows.forEach((a, i) => {
    const id = (typeof a.id === "string" && a.id.trim()) || `actual-${i + 1}`;
    const key = reconcileKey(id);
    const prev = byKey.get(key);
    byKey.set(key, {
      id,
      title: (typeof a.title === "string" && a.title.trim()) || prev?.title || id,
      usd: Math.max(0, num(prev?.usd, 0) + Math.max(0, num(a.usd, 0))),
      tokens: Math.max(0, num(prev?.tokens, 0) + Math.max(0, num(a.tokens, 0))),
    });
  });

  const rows: TicketReconcile[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let missing = 0;
  for (const f of forecastRows) {
    const id = (typeof f.id === "string" && f.id.trim()) || "ticket";
    const key = reconcileKey(id);
    const a = byKey.get(key);
    if (a) { seen.add(key); matched++; } else missing++;
    const fUsd = Math.max(0, usd(f.usd));
    const fTok = whole(f.tokens);
    const aUsd = Math.max(0, usd(a?.usd ?? 0));
    const aTok = whole(a?.tokens ?? 0);
    rows.push({
      id,
      title: (typeof f.title === "string" && f.title.trim()) || id,
      forecastUsd: fUsd,
      actualUsd: aUsd,
      deltaUsd: usd(aUsd - fUsd),
      relUsd: relative(fUsd, aUsd),
      forecastTokens: fTok,
      actualTokens: aTok,
      deltaTokens: Math.round(aTok - fTok),
      relTokens: relative(fTok, aTok),
      status: a ? "matched" : "missing",
    });
  }
  let extra = 0;
  for (const [key, a] of byKey) {
    if (seen.has(key)) continue;
    extra++;
    const aUsd = Math.max(0, usd(a.usd));
    const aTok = whole(a.tokens);
    rows.push({
      id: a.id,
      title: a.title,
      forecastUsd: 0,
      actualUsd: aUsd,
      deltaUsd: usd(aUsd),
      relUsd: relative(0, aUsd),
      forecastTokens: 0,
      actualTokens: aTok,
      deltaTokens: aTok,
      relTokens: relative(0, aTok),
      status: "extra",
    });
  }

  const forecastUsd = Math.max(0, usd(forecast?.usd ?? rows.reduce((a, r) => a + r.forecastUsd, 0)));
  const forecastTokens = whole(forecast?.tokens ?? rows.reduce((a, r) => a + r.forecastTokens, 0));
  const actualUsd = Math.max(0, usd(
    Number.isFinite(num(actuals?.usd, NaN)) ? num(actuals?.usd, 0) : rows.reduce((a, r) => a + r.actualUsd, 0),
  ));
  const actualTokens = whole(
    Number.isFinite(num(actuals?.tokens, NaN)) ? num(actuals?.tokens, 0) : rows.reduce((a, r) => a + r.actualTokens, 0),
  );

  // Accuracy = how close the money was, discounted by how much of the ticket set
  // we got right; a perfect estimate of the wrong backlog scores 0.5.
  const scale = Math.max(forecastUsd, actualUsd);
  const moneyScore = scale > 0 ? clamp01(1 - safeDiv(Math.abs(actualUsd - forecastUsd), scale, 1)) : 1;
  const totalRows = matched + missing + extra;
  const coverage = totalRows > 0 ? clamp01(safeDiv(matched, totalRows, 0)) : 1;
  const accuracy = round(clamp01(moneyScore * (0.5 + 0.5 * coverage)), 3);

  const low = Math.max(0, num(forecast?.low, 0));
  const high = Math.max(low, num(forecast?.high, 0));

  return {
    tickets: rows,
    matched,
    missing,
    extra,
    forecastUsd,
    actualUsd,
    deltaUsd: usd(actualUsd - forecastUsd),
    relUsd: relative(forecastUsd, actualUsd),
    forecastTokens,
    actualTokens,
    deltaTokens: Math.round(actualTokens - forecastTokens),
    relTokens: relative(forecastTokens, actualTokens),
    withinRange: Boolean(forecast) && actualUsd >= low && actualUsd <= high,
    accuracy,
  };
}
