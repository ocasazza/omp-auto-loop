// CK-012 literal decision triples + the four preserved invariants.
// Pure: no ports, no filesystem, no model. `S0` is the settled baseline.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldContinue,
  aggregate,
  buildGateOutcome,
  goalPrefix,
  type CycleState,
  type DecideArgs,
  type Decision,
  type Limits,
  type SettleInput,
} from "../extension/lib/core.ts";

const LIMITS: Limits = { maxContinuations: 3, timeoutMs: 1_800_000 };

function state(over: Partial<CycleState> = {}): CycleState {
  return { continuations: 0, startedAtMs: 0, cycleId: "c1", ...over };
}

function input(over: Partial<SettleInput> = {}): SettleInput {
  return {
    headless: false,
    headlessOptIn: false,
    scheduledContinuation: false,
    stopReason: "stop",
    claimsCompletion: false,
    configuredGates: [],
    gateResultIsStale: false,
    nowMs: 0,
    ...over,
  };
}

function decide(s: Partial<CycleState>, i: Partial<SettleInput>): Decision {
  const args: DecideArgs = { state: state(s), limits: LIMITS, goal: { status: "idle", objective: "", continuationsUsed: 0 }, input: input(i) };
  return shouldContinue(args);
}

// The 10 CK-012 triples (T1..T10 from the design; T11 is the continue default).
test("T1 headless without opt-in settles as a no-op (invariant 1)", () => {
  const d = decide({}, { headless: true });
  assert.equal(d.kind, "no-op");
  assert.equal(d.reason, "headless");
});

test("T1b headless WITH opt-in is not inert", () => {
  assert.equal(decide({}, { headless: true, headlessOptIn: true }).kind, "continue");
});

test("T2 scheduled continuation is a no-op and leaves the count (invariant 2)", () => {
  const d = decide({}, { scheduledContinuation: true });
  assert.equal(d.kind, "no-op");
  assert.equal(d.reason, "scheduled_continuation");
  assert.equal(d.continuations, 0);
});

test("T3 error and aborted turns settle (invariant 3)", () => {
  assert.equal(decide({}, { stopReason: "error" }).reason, "error");
  assert.equal(decide({}, { stopReason: "aborted" }).reason, "aborted");
});

test("T4 continuation cap settles the cycle (invariant 4)", () => {
  const d = decide({ continuations: 3 }, {});
  assert.equal(d.kind, "settle");
  assert.equal(d.reason, "continuation_limit");
});

test("T4b elapsed-time cap settles independently of the count", () => {
  const d = decide({ continuations: 0, startedAtMs: 0 }, { nowMs: LIMITS.timeoutMs });
  assert.equal(d.kind, "settle");
  assert.equal(d.reason, "cycle_timeout");
});

test("T5 user input resets the cycle: a fresh state continues", () => {
  // After reset the caller passes continuations 0 and a new startedAtMs.
  const d = decide({ continuations: 0, startedAtMs: 10_000 }, { nowMs: 10_000 });
  assert.equal(d.kind, "continue");
  assert.equal(d.continuations, 1);
});

test("T6 claim + passing gates settles verified", () => {
  const outcome = buildGateOutcome([{ kind: "pass", command: "true" }], false);
  const d = decide({}, { configuredGates: ["true"], claimsCompletion: true, gateOutcome: outcome });
  assert.equal(d.kind, "settle");
  assert.equal(d.reason, "verified_complete");
});

test("T7 failed gate continues with budget remaining", () => {
  const outcome = buildGateOutcome(
    [{ kind: "fail", command: "false", exitText: "exited 1", output: "boom", attempt: 1 }],
    false,
  );
  const d = decide({ continuations: 0 }, { configuredGates: ["false"], claimsCompletion: true, gateOutcome: outcome });
  assert.equal(d.kind, "continue");
  assert.equal(d.continuations, 1);
});

test("T8 gate retries exhausted settles, never verified", () => {
  const outcome = buildGateOutcome(
    [{ kind: "fail", command: "false", exitText: "exited 1", output: "", attempt: 4 }],
    true,
  );
  const d = decide({}, { configuredGates: ["false"], claimsCompletion: true, gateOutcome: outcome });
  assert.equal(d.kind, "settle");
  assert.equal(d.reason, "gate_retries_exhausted");
});

test("T9 claim without gates settles as claimed_unverified (the live path)", () => {
  const d = decide({}, { claimsCompletion: true, configuredGates: [] });
  assert.equal(d.kind, "settle");
  assert.equal(d.reason, "claimed_unverified");
});

test("T10 stale gate identity is a no-op", () => {
  const d = decide({}, { gateResultIsStale: true });
  assert.equal(d.kind, "no-op");
  assert.equal(d.reason, "stale_result");
});

test("T11 no claim, no gates, budget remains -> continue (the default)", () => {
  const d = decide({ continuations: 1 }, {});
  assert.equal(d.kind, "continue");
  assert.equal(d.continuations, 2);
});

test("claim with gates configured but no outcome yet requests verification", () => {
  const d = decide({}, { configuredGates: ["true"], claimsCompletion: true });
  assert.equal(d.kind, "verify");
});

test("aggregate is derived from local judgments, not asserted", () => {
  assert.equal(aggregate([]), "unavailable");
  assert.equal(aggregate([{ kind: "pass", command: "a" }]), "passed");
  assert.equal(
    aggregate([{ kind: "pass", command: "a" }, { kind: "fail", command: "b", exitText: "1", output: "", attempt: 1 }]),
    "failed",
  );
  assert.equal(aggregate([{ kind: "not-run", command: "a", attempt: 2 }]), "unavailable");
});

test("goalPrefix only speaks for an active goal with an objective", () => {
  assert.equal(goalPrefix({ status: "active", objective: "ship it", continuationsUsed: 0 }, "g1"), "Active goal (g1): ship it. ");
  assert.equal(goalPrefix({ status: "paused", objective: "ship it", continuationsUsed: 0 }, "g1"), "");
  assert.equal(goalPrefix({ status: "active", objective: "", continuationsUsed: 0 }), "");
});
