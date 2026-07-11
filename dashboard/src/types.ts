/** Shared event shapes — mirrors what the Python dispatcher writes to events.jsonl. */

export type TaskState =
  | "QUEUED"
  | "RUNNING"
  | "VERIFYING"
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
  tasks: Array<{ id: string; title: string } | string>; // string form: pre-0.2 logs
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

export interface BlockedEvent extends BaseEvent {
  event: "blocked";
  task: string;
  question: string;
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
  | BaseEvent;
