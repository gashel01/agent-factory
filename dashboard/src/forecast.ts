/** Cost-estimation engine: predict what a run will spend, offer cheap/standard/
 *  thorough approaches, and reconcile the prediction against the real bill.
 *
 *  Deliberately pure: no fs, no http, no node imports, no globals. Callers hand in
 *  already-read strings and already-parsed event objects and get plain data back.
 *  That is what makes it testable — server.ts calls main() at import time, so
 *  anything living there is unreachable from a unit test.
 *
 *  Every function here is TOTAL: malformed input yields defaults, never a throw,
 *  and no division-by-zero or NaN may reach a caller. */

/* ============================ ticket front matter ============================ */

export interface TicketMeta {
  file: string;
  id: string;
  title: string;
  filesHint: string[];
  dependsOn: string[];
  priority: number | null;
  timeoutMin: number | null;
  verify: string[];
  model: string | null;
  effort: string | null;
  bodyChars: number;
}

/** Defaults for a ticket we could not read anything useful from. Kept in one place
 *  so "missing front matter" and "malformed front matter" behave identically. */
function emptyMeta(file: string, bodyChars: number): TicketMeta {
  return {
    file,
    id: idFromFile(file),
    title: "",
    filesHint: [],
    dependsOn: [],
    priority: null,
    timeoutMin: null,
    verify: [],
    model: null,
    effort: null,
    bodyChars,
  };
}

/** Tickets are `backlog/<id>.md` (often `<id>-<slug>.md`), so the basename carries
 *  the id even when the front matter is unreadable. */
function idFromFile(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  const stem = base.replace(/\.[^.]*$/, "");
  return /^(\d+)[-_]/.exec(stem)?.[1] ?? stem;
}

/** Strip a trailing `# comment`, but only outside quotes — `id: "001" # note`
 *  must keep its value while `title: fix #42 crash` must keep its hash. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/** Split a YAML flow sequence/mapping body on commas at depth 0. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => unquote(s)).filter((s) => s.length > 0);
}

interface RawFrontMatter {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

/** A deliberately small YAML subset — enough for the shapes tickets actually use
 *  (scalars, flow sequences, flow mappings, block sequences, one nesting level)
 *  and forgiving about everything else. We do NOT want a YAML dependency here:
 *  the dashboard ships with zero runtime deps. */
function readFrontMatter(block: string): RawFrontMatter {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let parent = "";       // current nested-mapping key ("" = top level)
  let parentIndent = 0;
  let pendingList = "";  // key whose block sequence we are collecting

  for (const rawLine of block.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    // `- item` continues the most recent `key:` that had no inline value.
    const item = /^-\s*(.*)$/.exec(text);
    if (item) {
      if (pendingList) {
        const value = unquote(item[1] ?? "");
        if (value) (lists.get(pendingList) ?? []).push(value);
      }
      continue;
    }

    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(text);
    if (!kv) continue; // junk line — skip it rather than fail the whole ticket
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();

    if (parent && indent <= parentIndent) parent = ""; // dedented out of the nesting
    const path = parent && indent > parentIndent ? `${parent}.${key}` : key;
    pendingList = "";

    if (value.startsWith("[") ) {
      lists.set(path, splitFlow(value.replace(/^\[/, "").replace(/\]\s*$/, "")));
    } else if (value.startsWith("{")) {
      // Flow mapping: `budget: { timeout_min: 30, max_turns: 50 }`.
      for (const pair of splitFlow(value.replace(/^\{/, "").replace(/\}\s*$/, ""))) {
        const inner = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(pair);
        if (inner) scalars.set(`${path}.${inner[1] ?? ""}`, unquote(inner[2] ?? ""));
      }
    } else if (value === "") {
      // Either a block sequence or a nested mapping — we don't know yet, so arm both.
      lists.set(path, []);
      pendingList = path;
      parent = path;
      parentIndent = indent;
    } else {
      scalars.set(path, unquote(value));
    }
  }
  return { scalars, lists };
}

/** Whole numbers only: `priority: high` or `timeout_min: 30m` are malformed, and
 *  a tolerant parser reports "unknown" rather than a number nobody wrote. */
function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  return /^-?\d+$/.test(v) ? Number(v) : null;
}

/** Read `backlog/<id>.md`. Missing or malformed front matter yields sane defaults;
 *  this never throws, because a forecast must survive one bad ticket in the pile. */
export function parseTicket(file: string, content: string): TicketMeta {
  const text = typeof content === "string" ? content : "";
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return emptyMeta(file, text.trim().length);

  const block = m[1] ?? "";
  const body = m[2] ?? "";
  const fm = readFrontMatter(block);
  const meta = emptyMeta(file, body.trim().length);

  const scalar = (k: string): string | null => {
    const v = fm.scalars.get(k);
    return v !== undefined && v !== "" ? v : null;
  };
  const list = (k: string): string[] => {
    const inline = fm.lists.get(k);
    if (inline && inline.length > 0) return inline;
    const single = scalar(k); // YAML allows a bare scalar where a sequence is expected
    return single ? [single] : [];
  };

  meta.id = scalar("id") ?? meta.id;
  // Fall back to the first markdown heading, then the id — a nameless ticket is
  // still forecastable, it just needs *something* to label the row with.
  meta.title = scalar("title") ?? /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim() ?? meta.id;
  meta.filesHint = list("files_hint");
  meta.dependsOn = list("depends_on");
  meta.priority = intOrNull(fm.scalars.get("priority"));
  // Real tickets nest it (`budget: { timeout_min: 30 }`); the flat form is accepted too.
  meta.timeoutMin = intOrNull(fm.scalars.get("timeout_min"))
    ?? intOrNull(fm.scalars.get("budget.timeout_min"));
  meta.verify = list("verify");
  meta.model = scalar("model");
  meta.effort = scalar("effort");
  return meta;
}

/* ================================= pricing ================================= */

export interface Pricing {
  inPerMTok: number;
  outPerMTok: number;
  cacheReadPerMTok: number;
}

/** Anthropic API list price in USD per MILLION tokens.
 *
 *  Source: https://www.anthropic.com/pricing (API tab) / docs.anthropic.com
 *  "Models overview" pricing table, checked 2026-08-09. Cache READS bill at 0.1x
 *  the family's input rate (cache writes are not modelled: the factory's agents
 *  re-read a stable prefix, so writes are a rounding error next to reads).
 *
 *  Keys are matched as SUBSTRINGS of the model id, longest key first, so a family
 *  key covers every id in that family and a more specific key overrides it. To
 *  reprice, edit this table — nothing else in the module hardcodes a rate. */
export const MODEL_PRICING: Record<string, Pricing> = {
  // Opus 4 / 4.1: $15 in, $75 out.
  "opus-4-1": { inPerMTok: 15, outPerMTok: 75, cacheReadPerMTok: 1.5 },
  "opus-4-0": { inPerMTok: 15, outPerMTok: 75, cacheReadPerMTok: 1.5 },
  "opus-4-2": { inPerMTok: 15, outPerMTok: 75, cacheReadPerMTok: 1.5 },
  // Opus 4.5 cut the Opus tier to $5 in / $25 out; later Opus generations follow it.
  "opus-4-5": { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
  "opus": { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
  // Sonnet 3.7 / 4 / 4.5+: $3 in, $15 out (<=200K context; the long-context
  // premium is not modelled — factory tasks rarely cross the threshold).
  "sonnet": { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
  // Haiku 3.5: $0.80 in, $4 out.
  "haiku-3": { inPerMTok: 0.8, outPerMTok: 4, cacheReadPerMTok: 0.08 },
  // Haiku 4.5+: $1 in, $5 out.
  "haiku": { inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1 },
};

/** Fallback for an id we do not recognise (a new family, a vendor prefix we never
 *  saw). We bill it at the Sonnet tier: it is the mid point of the table, so an
 *  unknown id is never wildly optimistic nor alarmist. */
export const UNKNOWN_PRICE_KEY = "sonnet";

/** The MODEL_PRICING key an id resolves to. Exported because `historyStats` groups
 *  past spend by this key, so history recorded under `claude-opus-4-1-20250805`
 *  still calibrates a forecast that merely says `opus`. */
export function priceKeyFor(model: string | null | undefined): string {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id) return UNKNOWN_PRICE_KEY;
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, id)) return id;
  // Longest key first so "opus-4-5" wins over "opus" for `claude-opus-4-5-…`.
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) if (id.includes(key)) return key;
  return UNKNOWN_PRICE_KEY;
}

export function priceFor(model: string | null): Pricing {
  return MODEL_PRICING[priceKeyFor(model)] ?? MODEL_PRICING[UNKNOWN_PRICE_KEY]
    ?? { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 };
}

export interface TokenMix {
  input: number;
  output: number;
  cacheRead: number;
}

export function costOfTokens(tokens: TokenMix, price: Pricing): number {
  return (
    (tokens.input * price.inPerMTok
      + tokens.output * price.outPerMTok
      + tokens.cacheRead * price.cacheReadPerMTok) / 1_000_000
  );
}

/* =============================== complexity =============================== */

/** Saturating 0..1 curve: strictly increasing everywhere (so complexityOf stays
 *  monotonic in every input, with no plateau once a hard cap is hit), and `half`
 *  is the value that scores 0.5. */
function saturate(x: number, half: number): number {
  const v = Number.isFinite(x) && x > 0 ? x : 0;
  return v / (v + half);
}

/** Weights: what actually drives an agent's spend, in order. A long brief means
 *  more reading and more turns; touching many files means more edits; every verify
 *  command is a failure mode that can cost a repair loop; the declared timeout is
 *  the author's own difficulty signal; dependencies mean unfamiliar surrounding
 *  code. They sum to 1, so the result is a genuine 0..1. */
const COMPLEXITY_WEIGHTS = { body: 0.35, files: 0.25, verify: 0.15, timeout: 0.15, deps: 0.1 };

/** The `half` point of each curve — the value at which that facet scores 0.5. */
const COMPLEXITY_HALF = { body: 1500, files: 4, verify: 3, timeout: 45, deps: 2 };

/** Timeout the dispatcher assumes when a ticket does not declare one (Budget in
 *  src/factory/task.py). Used so a silent ticket scores like an average one. */
const DEFAULT_TIMEOUT_MIN = 30;

/** 0..1 difficulty score. Monotonically non-decreasing in body length, files
 *  touched, verify command count, declared timeout and dependency count. */
export function complexityOf(t: TicketMeta): number {
  const c =
    COMPLEXITY_WEIGHTS.body * saturate(t.bodyChars, COMPLEXITY_HALF.body)
    + COMPLEXITY_WEIGHTS.files * saturate(t.filesHint.length, COMPLEXITY_HALF.files)
    + COMPLEXITY_WEIGHTS.verify * saturate(t.verify.length, COMPLEXITY_HALF.verify)
    + COMPLEXITY_WEIGHTS.timeout * saturate(t.timeoutMin ?? DEFAULT_TIMEOUT_MIN, COMPLEXITY_HALF.timeout)
    + COMPLEXITY_WEIGHTS.deps * saturate(t.dependsOn.length, COMPLEXITY_HALF.deps);
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
}

/* ================================ profiles ================================ */

export type ProfileId = "cheap" | "standard" | "thorough";

export interface Profile {
  id: ProfileId;
  label: string;
  description: string;
  model: string;
  effort: string;
  maxRetries: number;
  turnMultiplier: number;
}

/** The real trade-off, not three arbitrary multipliers: a cheaper model thinking
 *  less with no second chance, versus a stronger model thinking longer and allowed
 *  to fix its own verify failures twice. */
export const PROFILES: Record<ProfileId, Profile> = {
  cheap: {
    id: "cheap",
    label: "Cheap",
    description: "Haiku at low effort, no retry. For mechanical tickets — a rename, "
      + "a copy edit, a config tweak — where a failure costs you a re-run, not money.",
    model: "haiku",
    effort: "low",
    maxRetries: 0,
    turnMultiplier: 0.7,
  },
  standard: {
    id: "standard",
    label: "Standard",
    description: "Sonnet at medium effort with one retry. The default: strong enough "
      + "for ordinary feature work, and it can repair its own verify failure once.",
    model: "sonnet",
    effort: "medium",
    maxRetries: 1,
    turnMultiplier: 1,
  },
  thorough: {
    id: "thorough",
    label: "Thorough",
    description: "Opus at high effort with two retries. For tickets that touch many "
      + "files or carry real design risk, where a wrong answer costs more than tokens.",
    model: "opus",
    effort: "high",
    maxRetries: 2,
    turnMultiplier: 1.5,
  },
};

export const PROFILE_IDS: readonly ProfileId[] = ["cheap", "standard", "thorough"];

export function profileFor(id: string | null | undefined): Profile {
  const key = String(id ?? "").trim().toLowerCase();
  return PROFILE_IDS.includes(key as ProfileId)
    ? PROFILES[key as ProfileId]
    : PROFILES.standard;
}

/** Reasoning effort drives turn count and output tokens (see EFFORT_LEVELS in
 *  src/factory/config.py). Relative to `medium` = 1. */
const EFFORT_MULTIPLIER: Record<string, number> = {
  low: 0.7,
  medium: 1,
  high: 1.35,
  xhigh: 1.7,
  max: 2.1,
  ultracode: 3,
};

function effortMultiplier(effort: string | null | undefined): number {
  return EFFORT_MULTIPLIER[String(effort ?? "").trim().toLowerCase()] ?? 1;
}

/* ================================ history ================================ */

export interface ModelStats {
  samples: number;
  medianCostUsd: number;
  medianTokens: TokenMix;
}

export interface HistoryStats {
  runs: number;
  samples: number;           // completed tasks observed
  medianCostUsd: number;
  medianTokens: TokenMix;
  medianTurns: number;
  medianWallS: number;
  retryRate: number;         // 0..1: share of observed tasks that needed >=1 retry
  byModel: Record<string, ModelStats>; // keyed by priceKeyFor(model)
}

export function emptyHistory(): HistoryStats {
  return {
    runs: 0,
    samples: 0,
    medianCostUsd: 0,
    medianTokens: { input: 0, output: 0, cacheRead: 0 },
    medianTurns: 0,
    medianWallS: 0,
    retryRate: 0,
    byModel: {},
  };
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : (hi + (s[mid - 1] ?? 0)) / 2;
}

interface Sample {
  costUsd: number;
  tokens: TokenMix;
  turns: number;
  wallS: number;
  status: string;
  priceKey: string;
  declared: boolean; // the run declared this task's model, so byModel may claim it
}

/** Statuses that mean "the agent finished its work" on runs old enough to predate
 *  the state events. Only consulted when a run logged no state transitions at all. */
const OK_STATUSES = new Set(["ok", "done", "success", "completed"]);

/** Median cost and token mix per COMPLETED task, overall and per model family,
 *  plus the observed retry rate. Zero-sample and well-formed when there is no
 *  history — callers never have to null-check it. */
export function historyStats(
  runs: ReadonlyArray<{ run: string; events: ReadonlyArray<Record<string, unknown>> }>,
): HistoryStats {
  const stats = emptyHistory();
  if (!Array.isArray(runs) || runs.length === 0) return stats;

  const completed: Sample[] = [];
  let observedTasks = 0;
  let retriedTasks = 0;

  for (const entry of runs) {
    const events = entry?.events;
    if (!Array.isArray(events)) continue;
    stats.runs++;

    const declaredModel = new Map<string, string>();
    const done = new Set<string>();
    const retried = new Set<string>();
    const results = new Map<string, Sample>();
    let sawState = false;

    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const kind = str(ev, "event");
      if (kind === "run_start") {
        const tasks = ev["tasks"];
        if (Array.isArray(tasks)) {
          for (const t of tasks) {
            // Pre-0.2 logs list bare id strings and carry no per-task model.
            if (!t || typeof t !== "object") continue;
            const rec = t as Record<string, unknown>;
            const id = str(rec, "id");
            const model = str(rec, "model");
            if (id && model) declaredModel.set(id, model);
          }
        }
      } else if (kind === "state") {
        sawState = true;
        if (str(ev, "to") === "DONE") done.add(str(ev, "task"));
      } else if (kind === "retry") {
        const task = str(ev, "task");
        if (task) retried.add(task);
      } else if (kind === "agent_result") {
        const task = str(ev, "task");
        if (!task) continue;
        // Last result wins: a retried task reports once per attempt, and the final
        // attempt is the one whose cost belongs to a completed task.
        results.set(task, {
          costUsd: num(ev, "cost_usd"),
          tokens: {
            input: num(ev, "input_tokens"),
            output: num(ev, "output_tokens"),
            cacheRead: num(ev, "cache_read_tokens"),
          },
          turns: num(ev, "turns"),
          wallS: num(ev, "wall_s"),
          status: str(ev, "status").toLowerCase(),
          priceKey: UNKNOWN_PRICE_KEY,
          declared: false,
        });
      }
    }

    // run_start may arrive after nothing else has been seen for a task, so resolve
    // the price key once the whole run is read.
    for (const [task, sample] of results) {
      const model = declaredModel.get(task);
      if (model) {
        sample.priceKey = priceKeyFor(model);
        sample.declared = true;
      }
      observedTasks++;
      if (retried.has(task)) retriedTasks++;
      const ok = sawState ? done.has(task) : OK_STATUSES.has(sample.status);
      if (ok) completed.push(sample);
    }
  }

  stats.retryRate = observedTasks > 0 ? Math.min(1, retriedTasks / observedTasks) : 0;
  stats.samples = completed.length;
  if (completed.length === 0) return stats;

  stats.medianCostUsd = median(completed.map((s) => s.costUsd));
  stats.medianTokens = {
    input: median(completed.map((s) => s.tokens.input)),
    output: median(completed.map((s) => s.tokens.output)),
    cacheRead: median(completed.map((s) => s.tokens.cacheRead)),
  };
  stats.medianTurns = median(completed.map((s) => s.turns));
  stats.medianWallS = median(completed.map((s) => s.wallS));

  const groups = new Map<string, Sample[]>();
  for (const s of completed) {
    // Tasks whose model was never declared cannot calibrate a specific family;
    // they still count in the overall medians above.
    if (!s.declared) continue;
    const bucket = groups.get(s.priceKey);
    if (bucket) bucket.push(s); else groups.set(s.priceKey, [s]);
  }
  for (const [key, samples] of groups) {
    stats.byModel[key] = {
      samples: samples.length,
      medianCostUsd: median(samples.map((s) => s.costUsd)),
      medianTokens: {
        input: median(samples.map((s) => s.tokens.input)),
        output: median(samples.map((s) => s.tokens.output)),
        cacheRead: median(samples.map((s) => s.tokens.cacheRead)),
      },
    };
  }
  return stats;
}

/* ================================ forecast ================================ */

export interface TaskForecast {
  id: string;
  title: string;
  model: string;
  effort: string;
  complexity: number;
  expectedTurns: number;
  tokens: TokenMix;
  costUsd: number;
  lowUsd: number;
  highUsd: number;
}

export interface Forecast {
  profile: string;
  basis: "history" | "heuristic" | "blended";
  perTask: TaskForecast[];
  totalUsd: number;
  lowUsd: number;
  highUsd: number;
  assumptions: string[];
}

export interface ForecastOptions {
  profile: string;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  history?: HistoryStats;
}

/** Heuristic shape of a single agent attempt, for a median ticket (complexity 0.5)
 *  at medium effort. Calibrated against the factory's own runs: an agent re-sends a
 *  growing conversation prefix every turn, so cache reads dominate the token count
 *  while output dominates the bill. */
const BASE_TURNS = 14;
const FRESH_INPUT_PER_TURN = 2_600;  // new prompt text (tool results, file reads)
const CACHE_READ_PER_TURN = 22_000;  // the re-sent, cached conversation prefix
const OUTPUT_PER_TURN = 1_100;       // reasoning + edits emitted per turn

/** Complexity 0.5 is the reference point, so every scale below is 1.0 there. */
const REFERENCE_COMPLEXITY = 0.5;
const turnScale = (c: number) => 0.55 + 0.9 * c;
const sizeScale = (c: number) => 0.6 + 0.8 * c;
const contextScale = (c: number) => 0.5 + c;

/** Retry rate assumed when there is no history to observe one from. */
const DEFAULT_RETRY_RATE = 0.18;

/** Sample count at which history is trusted outright. Below it we blend, so a
 *  single lucky (or disastrous) past task cannot swing the whole quote. */
const FULL_TRUST_SAMPLES = 25;

/** Half-width of the low/high band, as a fraction of the point estimate. Pure
 *  heuristics deserve a wide spread; calibrated numbers earn a tighter one. */
const SPREAD_HEURISTIC = 0.45;
const SPREAD_HISTORY = 0.2;

function heuristicTurns(complexity: number, effort: string, profile: Profile): number {
  const turns = BASE_TURNS * turnScale(complexity) * effortMultiplier(effort) * profile.turnMultiplier;
  return Math.max(1, Math.round(Number.isFinite(turns) ? turns : BASE_TURNS));
}

function heuristicTokens(turns: number, complexity: number, effort: string): TokenMix {
  const e = effortMultiplier(effort);
  return {
    input: Math.round(turns * FRESH_INPUT_PER_TURN * sizeScale(complexity)),
    output: Math.round(turns * OUTPUT_PER_TURN * sizeScale(complexity) * e),
    cacheRead: Math.round(turns * CACHE_READ_PER_TURN * contextScale(complexity)),
  };
}

function scaleTokens(t: TokenMix, k: number): TokenMix {
  const f = Number.isFinite(k) && k > 0 ? k : 1;
  return {
    input: Math.round(t.input * f),
    output: Math.round(t.output * f),
    cacheRead: Math.round(t.cacheRead * f),
  };
}

function blendTokens(a: TokenMix, b: TokenMix, w: number): TokenMix {
  return {
    input: Math.round(a.input * (1 - w) + b.input * w),
    output: Math.round(a.output * (1 - w) + b.output * w),
    cacheRead: Math.round(a.cacheRead * (1 - w) + b.cacheRead * w),
  };
}

const tokenTotal = (t: TokenMix) => t.input + t.output + t.cacheRead;

/** Predict a run's spend. With history it CALIBRATES the heuristic (and says so in
 *  `basis` / `assumptions`); with none it falls back to pure heuristics and says
 *  that too. A per-ticket `model`/`effort` in the front matter beats the profile. */
export function forecastRun(tickets: TicketMeta[], opts: ForecastOptions): Forecast {
  const list = Array.isArray(tickets) ? tickets : [];
  const profile = profileFor(opts?.profile);
  const history = opts?.history ?? emptyHistory();
  const samples = Math.max(0, history.samples || 0);
  // Trust grows with evidence; capped at 1 so history can fully replace, but never
  // over-shoot, the heuristic.
  const weight = Math.min(1, samples / FULL_TRUST_SAMPLES);
  const basis: Forecast["basis"] = samples === 0 ? "heuristic" : weight >= 1 ? "history" : "blended";

  const retryRate = samples > 0 ? Math.min(1, Math.max(0, history.retryRate)) : DEFAULT_RETRY_RATE;
  const attempts = 1 + retryRate * profile.maxRetries;
  const spread = SPREAD_HEURISTIC - (SPREAD_HEURISTIC - SPREAD_HISTORY) * weight;

  let overrides = 0;
  const perTask: TaskForecast[] = [];

  for (const t of list) {
    const model = t.model ?? opts?.defaultModel ?? profile.model;
    const effort = t.effort ?? opts?.defaultEffort ?? profile.effort;
    if (t.model || t.effort) overrides++;

    const complexity = complexityOf(t);
    const price = priceFor(model);
    const expectedTurns = heuristicTurns(complexity, effort, profile);
    const heuristic = heuristicTokens(expectedTurns, complexity, effort);

    let tokens = heuristic;
    if (weight > 0) {
      // Past spend is recorded per model family, so history under `claude-opus-4-1`
      // still calibrates a ticket that merely asks for `opus`.
      const key = priceKeyFor(model);
      const observed = history.byModel[key] ?? {
        samples,
        medianCostUsd: history.medianCostUsd,
        medianTokens: history.medianTokens,
      };
      let fromHistory: TokenMix;
      if (tokenTotal(observed.medianTokens) > 0) {
        // The median describes a median ticket, so re-apply this ticket's complexity.
        fromHistory = scaleTokens(observed.medianTokens, sizeScale(complexity) / sizeScale(REFERENCE_COMPLEXITY));
      } else {
        // Older logs record cost but no token breakdown. Recover a mix by stretching
        // the heuristic shape until a REFERENCE ticket prices out at the observed
        // median — using the reference, not this ticket, keeps complexity meaningful.
        const refTurns = heuristicTurns(REFERENCE_COMPLEXITY, effort, profile);
        const refCost = costOfTokens(heuristicTokens(refTurns, REFERENCE_COMPLEXITY, effort), price);
        const k = refCost > 0 ? observed.medianCostUsd / refCost : 1;
        fromHistory = scaleTokens(heuristic, k);
      }
      tokens = blendTokens(heuristic, fromHistory, weight);
    }

    const costUsd = Math.max(0, costOfTokens(tokens, price) * attempts);
    perTask.push({
      id: t.id,
      title: t.title,
      model,
      effort,
      complexity,
      expectedTurns,
      tokens,
      costUsd,
      lowUsd: costUsd * (1 - spread),
      highUsd: costUsd * (1 + spread),
    });
  }

  const sum = (pick: (f: TaskForecast) => number) => perTask.reduce((a, f) => a + pick(f), 0);
  const assumptions: string[] = [];
  const wantedProfile = String(opts?.profile ?? "").trim().toLowerCase();
  if (wantedProfile && wantedProfile !== profile.id) {
    assumptions.push(`Unknown profile "${opts.profile}" — using "${profile.id}".`);
  }
  assumptions.push(
    `Profile "${profile.id}": ${profile.model} at ${profile.effort} effort, up to ${profile.maxRetries} retr${profile.maxRetries === 1 ? "y" : "ies"}.`,
  );
  assumptions.push(
    samples === 0
      ? "No completed-task history yet — the estimate comes from the ticket heuristic alone "
        + "(body length, files touched, verify commands, timeout, dependencies)."
      : `Calibrated against ${samples} completed task${samples === 1 ? "" : "s"} from ${history.runs} past run${history.runs === 1 ? "" : "s"} `
        + `(history weight ${Math.round(weight * 100)}%, heuristic ${Math.round((1 - weight) * 100)}%).`,
  );
  assumptions.push(
    `Retry allowance: ${Math.round(retryRate * 100)}% of tasks retried `
    + `(${samples > 0 ? "observed" : "assumed, no history"}) x up to ${profile.maxRetries}.`,
  );
  if (overrides > 0) {
    assumptions.push(`${overrides} ticket${overrides === 1 ? "" : "s"} override the profile's model/effort in their front matter.`);
  }
  assumptions.push("Prices are Anthropic list price per million tokens; an unrecognised model id is billed at the Sonnet tier.");
  assumptions.push(`Range spans +/-${Math.round(spread * 100)}% around the estimate — a spread, not a quote.`);

  return {
    profile: profile.id,
    basis,
    perTask,
    totalUsd: sum((f) => f.costUsd),
    lowUsd: sum((f) => f.lowUsd),
    highUsd: sum((f) => f.highUsd),
    assumptions,
  };
}

/* =============================== reconcile =============================== */

export interface TaskReconciliation {
  id: string;
  predictedUsd: number;
  actualUsd: number;
  deltaUsd: number;
  deltaPct: number; // percent, relative to the prediction
}

export interface Reconciliation {
  perTask: TaskReconciliation[];
  predictedTotal: number;
  actualTotal: number;
  deltaPct: number;
  withinRange: boolean;
  calibration: number;
}

/** Percentage change from `predicted` to `actual`. With nothing predicted there is
 *  no ratio to take, so we report 0% when nothing was spent either and 100% when
 *  spend appeared out of nowhere — never Infinity or NaN. */
function pctDelta(predicted: number, actual: number): number {
  if (predicted > 0) return ((actual - predicted) / predicted) * 100;
  return actual > 0 ? 100 : 0;
}

/** Bounds on the feed-forward factor: one freak task must not halve or decuple the
 *  next quote. */
const CALIBRATION_MIN = 0.1;
const CALIBRATION_MAX = 10;

/** Compare a forecast with what the run really cost. Tasks present on only one side
 *  (never ran, or ran without being forecast) are counted with a zero on the missing
 *  side rather than dropped, so the totals stay honest and no NaN escapes. */
export function reconcile(
  forecast: Forecast,
  actuals: ReadonlyArray<{ id: string; costUsd: number }>,
): Reconciliation {
  const predicted = new Map<string, number>();
  for (const f of forecast?.perTask ?? []) {
    predicted.set(f.id, (predicted.get(f.id) ?? 0) + (Number.isFinite(f.costUsd) ? f.costUsd : 0));
  }
  const actual = new Map<string, number>();
  for (const a of Array.isArray(actuals) ? actuals : []) {
    if (!a || typeof a.id !== "string") continue;
    const cost = Number.isFinite(a.costUsd) ? a.costUsd : 0;
    actual.set(a.id, (actual.get(a.id) ?? 0) + cost);
  }

  const ids = [...predicted.keys()];
  for (const id of actual.keys()) if (!predicted.has(id)) ids.push(id);

  const perTask: TaskReconciliation[] = ids.map((id) => {
    const p = predicted.get(id) ?? 0;
    const a = actual.get(id) ?? 0;
    return { id, predictedUsd: p, actualUsd: a, deltaUsd: a - p, deltaPct: pctDelta(p, a) };
  });

  const predictedTotal = perTask.reduce((s, r) => s + r.predictedUsd, 0);
  const actualTotal = perTask.reduce((s, r) => s + r.actualUsd, 0);

  // Calibration uses only tasks that appear on BOTH sides: a forecast task that
  // never ran says nothing about our accuracy, it would just make us look pessimistic.
  const matched = perTask.filter((r) => predicted.has(r.id) && actual.has(r.id));
  const mp = matched.reduce((s, r) => s + r.predictedUsd, 0);
  const ma = matched.reduce((s, r) => s + r.actualUsd, 0);
  const raw = mp > 0 ? ma / mp : (predictedTotal > 0 ? actualTotal / predictedTotal : 1);
  const calibration = Number.isFinite(raw) && raw > 0
    ? Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, raw))
    : 1;

  return {
    perTask,
    predictedTotal,
    actualTotal,
    deltaPct: pctDelta(predictedTotal, actualTotal),
    withinRange: actualTotal >= (forecast?.lowUsd ?? 0) && actualTotal <= (forecast?.highUsd ?? 0),
    calibration,
  };
}
