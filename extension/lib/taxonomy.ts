// The loop's vocabularies, declared once as data.
//
// Each set below was a bare type union restated by hand in every consumer. The
// event classifier had a second copy in resume.ts that had already diverged:
// it matched `includes("gate")`, so any objective that merely mentioned a gate
// replayed as a gate event and corrupted the restored budget. Declaring the
// runtime list and deriving the union from it makes a consumer unable to drift
// from the producer.
//
// `usage` records what the code does with a term, so a control surface never
// implies a term is extensible when it is not. "branch" terms are read by the
// loop to choose behaviour, so neither adding nor removing one is a data edit;
// "label" terms are only written, so the set can grow without a new consumer.

export interface Term<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly usage: "branch" | "label";
}

/**
 * Event classes. The classification is by message prefix because pre-`kind`
 * logs must replay; a recorded `kind` is authoritative and is never re-derived.
 */
export const EVENT_CLASSES = [
  {
    id: "continue",
    label: "Continue",
    description: "A continuation was issued for the active goal.",
    usage: "branch",
  },
  {
    id: "gate",
    label: "Gate",
    description: 'A gate set passed or failed ("gate failed", "gates passed").',
    usage: "branch",
  },
  {
    id: "goal",
    label: "Goal",
    description: "A goal was set, completed, or cleared.",
    usage: "branch",
  },
  {
    id: "heartbeat",
    label: "Heartbeat",
    description: "An idle session was nudged toward its goal.",
    usage: "label",
  },
  {
    id: "settled",
    label: "Settled",
    description: "The cycle closed; the reason follows in the message.",
    usage: "branch",
  },
  {
    id: "other",
    label: "Other",
    description: "Matched no declared class.",
    usage: "label",
  },
] as const satisfies readonly Term<string>[];

export type EventClass = (typeof EVENT_CLASSES)[number]["id"];

/**
 * Classify an event by its message.
 *
 * The prefixes are the strings the loop emits (see the `note()` call sites in
 * auto-loop.ts). Matching on `includes("gate")` instead typed every goal that
 * mentioned a gate as a gate event, which silently corrupts anything keyed on
 * the class — including the budget replay.
 */
export function classify(msg: string): EventClass {
  if (msg.startsWith("autonomous continuation")) return "continue";
  if (msg.startsWith("gate failed") || msg.startsWith("gates passed")) {
    return "gate";
  }
  if (msg.startsWith("goal")) return "goal";
  if (msg.startsWith("heartbeat")) return "heartbeat";
  if (msg.startsWith("settled")) return "settled";
  return "other";
}

/**
 * Settle reasons: why a cycle closed. Every term is a label — nothing reads
 * one to choose behaviour — but each has a producer, so a new term is a new
 * call site in core.ts or gates.ts, never a data-only addition.
 */
export const SETTLE_REASONS = [
  {
    id: "headless",
    label: "Headless",
    description: "A headless run without opt-in: no-op, never a settle.",
    usage: "label",
  },
  {
    id: "scheduled_continuation",
    label: "Scheduled continuation",
    description: "A scheduled nudge, consumed once: no-op, never a settle.",
    usage: "label",
  },
  {
    id: "error",
    label: "Error",
    description: "The turn ended in an error.",
    usage: "label",
  },
  {
    id: "aborted",
    label: "Aborted",
    description: "The turn was aborted.",
    usage: "label",
  },
  {
    id: "verified_complete",
    label: "Verified complete",
    description: "The gate set passed: the only reason that counts as verified.",
    usage: "label",
  },
  {
    id: "claimed_unverified",
    label: "Claimed, unverified",
    description: "The model claimed completion with neither gate nor judge.",
    usage: "label",
  },
  {
    id: "judged_complete",
    label: "Judged complete",
    description: "A judge verdict marked the work done.",
    usage: "label",
  },
  {
    id: "judge_unavailable",
    label: "Judge unavailable",
    description: "A judge was expected but produced no usable verdict; never a pass.",
    usage: "label",
  },
  {
    id: "continuation_limit",
    label: "Continuation limit",
    description: "maxContinuations was reached.",
    usage: "label",
  },
  {
    id: "cycle_timeout",
    label: "Cycle timeout",
    description: "The elapsed cap for the cycle was reached.",
    usage: "label",
  },
  {
    id: "gate_retries_exhausted",
    label: "Gate retries exhausted",
    description: "The gate set exhausted its retries.",
    usage: "label",
  },
  {
    id: "gate_deadline",
    label: "Gate deadline",
    description: "The gate set exceeded its deadline.",
    usage: "label",
  },
  {
    id: "gate_unavailable",
    label: "Gate unavailable",
    description: "A gate could not be run.",
    usage: "label",
  },
  {
    id: "stale_result",
    label: "Stale result",
    description: "A gate result predated the current worktree.",
    usage: "label",
  },
] as const satisfies readonly Term<string>[];

export type SettleReason = (typeof SETTLE_REASONS)[number]["id"];

/** What the loop decided to do next. Each kind is switched on by the caller. */
export const DECISION_KINDS = [
  {
    id: "continue",
    label: "Continue",
    description: "Run another turn against the same goal.",
    usage: "branch",
  },
  {
    id: "settle",
    label: "Settle",
    description: "Close the cycle; `reason` records why.",
    usage: "branch",
  },
  {
    id: "verify",
    label: "Verify",
    description: "Run the configured gate set, then decide again with its outcome.",
    usage: "branch",
  },
  {
    id: "no-op",
    label: "No-op",
    description: "Take no action; `reason` records why.",
    usage: "branch",
  },
] as const satisfies readonly Term<string>[];

export type DecisionKind = (typeof DECISION_KINDS)[number]["id"];

/**
 * Edge kinds between graph nodes, keyed by the kinds it connects. Declared as
 * `[[schema.edge_types]]` in the omp-auto-loop canvas package; this list must
 * match that schema, and `inferEdgeKind` in observation.ts is its only reader.
 */
export const EDGE_KINDS = [
  {
    id: "in_repo",
    label: "In repo",
    description: "session -> repo",
    usage: "label",
  },
  {
    id: "pursues",
    label: "Pursues",
    description: "session -> goal",
    usage: "label",
  },
  {
    id: "runs_gate",
    label: "Runs gate",
    description: "session -> gate",
    usage: "label",
  },
  {
    id: "spawned",
    label: "Spawned",
    description: "session -> session",
    usage: "label",
  },
  {
    id: "emitted",
    label: "Emitted",
    description: "session -> event",
    usage: "label",
  },
  {
    id: "next",
    label: "Next",
    description: "event -> event",
    usage: "label",
  },
] as const satisfies readonly Term<string>[];

export type EdgeKind = (typeof EDGE_KINDS)[number]["id"];
