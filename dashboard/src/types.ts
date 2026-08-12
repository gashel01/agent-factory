/** Shared event shapes — mirrors what the Python dispatcher writes to events.jsonl. */

export type TaskState =
  | "QUEUED"
  | "RUNNING"
  | "VERIFYING"
  | "REVIEWING"
  | "AWAITING_APPROVAL"
  | "MERGE_QUEUED"
  | "MERGING"
  | "DONE"
  | "FAILED"
  | "BLOCKED";

export interface BaseEvent {
  ts: string;
  event: string;
  task?: string;
}

export interface RunStartEvent extends BaseEvent {
  event: "run_start";
  run: string;
  slots: number;
  budget_usd?: number | null;
  mode?: string; // "subscription" | "api"; absent on older logs
  pr?: boolean; // this run's delivery: true = a PR per ticket, false = merge to base. Absent on pre-0.2 logs
  tasks: Array<{ id: string; title: string; model?: string | null; effort?: string | null; depends_on?: string[] } | string>; // string form: pre-0.2 logs
}

export interface StateEvent extends BaseEvent {
  event: "state";
  task: string;
  from: TaskState;
  to: TaskState;
}

export interface AgentResultEvent extends BaseEvent {
  event: "agent_result";
  task: string;
  status: string;
  turns: number | null;
  wall_s: number;
  summary: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  spent_usd?: number; // cumulative across the run at this point
}

export interface AgentProgressEvent extends BaseEvent {
  event: "agent_progress";
  task: string;
  turns: number;
  tokens: number;
}

export interface PlanLimitEvent extends BaseEvent {
  event: "plan_limit";
  status: string; // "allowed" | ...
  resets_at: number | null; // unix epoch seconds when the window resets
  window: string; // "five_hour" | "weekly" | ...
}

export interface BudgetEvent extends BaseEvent {
  event: "budget_exceeded";
  spent_usd: number;
  budget_usd: number;
}

export interface VerifyEvent extends BaseEvent {
  event: "verify";
  task: string;
  ok: boolean;
  failures: string[];
}

export interface RetryEvent extends BaseEvent {
  event: "retry";
  task: string;
  attempt: number;
  reason: string;
}

export interface FailureEvent extends BaseEvent {
  event: "failure";
  task: string;
  reason: string;
}

/** Raw git facts captured the moment an agent blocked, before its worktree was
 *  torn down. Shown next to the agent's question so the operator judges it against
 *  ground truth (e.g. "clean, 0 commits" exposes a bogus request to reset/rewrite). */
export interface BlockedContext {
  clean: boolean;
  commits: number;
  status: string[];
  diffstat: string[];
}

/** One path the agent offered the operator at a design fork. `preview_html`, when
 *  present, is a self-contained fragment rendered in a scriptless sandboxed iframe. */
export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
  preview_html?: string;
}

export interface BlockedEvent extends BaseEvent {
  event: "blocked";
  task: string;
  question: string;
  context?: BlockedContext;
  // Present only when the block is a DECISION: the concrete options to pick between.
  kind?: "decision";
  options?: DecisionOption[];
}

export interface PausedEvent extends BaseEvent {
  event: "paused_ratelimit";
  pause_n: number;
  cooldown_s: number;
}

export interface RunEndEvent extends BaseEvent {
  event: "run_end";
  counts: Record<string, number>;
  stopped: boolean;
}

/* ============================ Capsule ============================
 * A capsule is an agent-generated, human-frozen manifest that describes how to
 * build / run / verify / operate ONE project — AND the control surface the
 * dashboard should render for it. The factory understands only the SHAPE
 * (phases, runners, palette surfaces); everything app-specific lives here as
 * DATA, never as per-type code. The non-determinism is confined to generating
 * the capsule; once frozen, execution is deterministic. */

/** Where a step runs. `container` = hermetic/reproducible; `host` = the dev's
 *  machine (GUI, physical device, games). */
export type RunnerKind = "container" | "host";

export interface CapsuleRunner {
  kind: RunnerKind;
  image?: string; // container only: the image to run the command in
}

/** A capability a step needs from its runner, surfaced honestly to the user
 *  when the runner can't provide it (never a cryptic failure). */
export type Capability = "display" | "usb-device" | "gpu" | "macos" | "network";

export interface CapsuleStep {
  run: string; // a shell command line, executed by the runner's shell
  cwd?: string; // relative to the repo root; default = repo root
  on?: string; // runner id (key in Capsule.runners); default "default" (host)
  requires?: Capability[];
  retries?: number; // transient-failure tolerance (re-run on non-zero exit)
  env?: Record<string, string>;
}

/** The FIXED palette of surfaces the dashboard can render. The agent composes
 *  from this vocabulary; it never emits executable UI. */
export type SurfaceKind = "log-stream" | "device-install" | "preview" | "link" | "none";

export interface CapsuleAction {
  id: string;
  label: string;
  description?: string; // one concise line: what it does / when to use it (shown under the button)
  icon?: string; // lucide name; the renderer maps a safe allow-list
  steps: CapsuleStep[]; // run in order, gate on exit code
  surface?: SurfaceKind; // what to show while/after it runs (default log-stream)
  primary?: boolean; // render as the hero button
  group?: string; // optional heading this action sits under, so a long action
                  // list reads as labelled clusters (Setup / Checks / …) rather
                  // than a flat wall. Ungrouped actions render as one plain list.
  consent?: string; // id of a consent that must be granted first
  // device-install / preview / link metadata:
  artifact?: string; // path (relative to repo) the action produces — served for download/QR
  url?: string; // preview/link target; `${lan}` is replaced with the LAN base URL
  device?: CapsuleDeviceTarget; // device-install only
  // long-running server (dev server, watcher): the last step stays alive, the
  // engine keeps it running and captures the served URL, and the cockpit shows
  // an embedded preview + a Stop control.
  service?: boolean;
  urlRegex?: string; // capture group 1 = served URL (defaults to the first localhost URL printed)
  // Behavioral verification: acceptance criteria in plain English. An agent looks
  // at the running app (headless screenshot of its URL) or the action's output
  // and judges it against these — for what an exit code can't check.
  judge?: string;
}

/** Generic (non-adb-specific) device enumeration + install, declared as data. */
export interface CapsuleDeviceTarget {
  listCmd: string; // command that lists connected devices, one per line
  listRegex: string; // regex whose capture group 1 is a device id (per line)
  installCmd: string; // command template; ${device} and ${artifact} are substituted
}

/** A read-only info/metrics panel. Either runs `source` (a command, stdout shown)
 *  OR renders `html` in a locked sandboxed iframe (the custom-UI escape hatch:
 *  no same-origin, isolated from the dashboard — for agent-authored rich UI). */
export interface CapsulePanel {
  id: string;
  title: string;
  source?: string; // command whose stdout is shown
  html?: string;   // custom HTML rendered sandboxed (takes precedence over source)
}

/** A toolchain check: `probe` exits 0 → present. Runs with the host effective env. */
export interface CapsuleDoctorCheck {
  id: string;
  label: string;
  probe: string;
}

/** A host mutation (install an SDK, set env). The user approves the RAW FACTS
 *  verbatim — never the agent's paraphrase. That is the anti-injection contract:
 *  a malicious repo cannot dress up a dangerous install as something benign. */
export interface CapsuleConsentFacts {
  downloads?: Array<{ url: string; sha256?: string }>;
  writes?: string[]; // paths the plan creates/modifies
  env?: Record<string, string>; // env vars applied to host steps once granted
  path?: string[]; // dirs prepended to PATH for host steps once granted
  commands?: string[]; // the exact commands, shown verbatim before approval
}

export interface CapsuleConsent {
  id: string;
  title: string;
  summary?: string;
  facts: CapsuleConsentFacts;
  steps?: CapsuleStep[]; // executed only after the user approves
  granted?: boolean; // pre-granted in the capsule (e.g. already installed)
}

export interface Capsule {
  version: 1;
  name?: string;
  summary?: string;
  runners?: Record<string, CapsuleRunner>;
  doctor?: CapsuleDoctorCheck[];
  actions: CapsuleAction[];
  panels?: CapsulePanel[];
  consents?: CapsuleConsent[];
}

/** Runtime view the dashboard polls: the manifest plus live per-action state. */
export interface CapsuleActionState {
  state: "idle" | "running" | "ok" | "error";
  output: string;
  artifactReady: boolean;
}
export interface CapsuleServiceState {
  state: "stopped" | "starting" | "live" | "error";
  url: string | null;
}
export interface CapsuleView {
  capsule: Capsule | null;
  doctor: Record<string, boolean>;
  runs: Record<string, CapsuleActionState>;
  grants: string[]; // granted consent ids
  devices: Record<string, string[]>; // actionId -> device ids (device-install)
  services: Record<string, CapsuleServiceState>; // actionId -> live server state
}

export type FactoryEvent =
  | RunStartEvent
  | StateEvent
  | AgentResultEvent
  | VerifyEvent
  | RetryEvent
  | FailureEvent
  | BlockedEvent
  | PausedEvent
  | RunEndEvent
  | AgentProgressEvent
  | PlanLimitEvent
  | BudgetEvent
  | BaseEvent;
