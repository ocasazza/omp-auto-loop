// Judge rubric, verdict parsing, and Clause 9 decision precedence — pure, no I/O.
// The parse is deliberately strict: an ambiguous or unrecognised answer is
// null, which the caller must treat as "judge unavailable", never as a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgePrompt, extractEvidence, parseJudgeVerdict, judgeFailureContext } from "../extension/lib/judge.ts";
import { shouldContinue } from "../extension/lib/core.ts";

test("buildJudgePrompt labels the reply as an untrusted self-report", () => {
  const p = buildJudgePrompt({ objective: "fix", reply: "done", evidence: "42 passed" });
  assert.match(p, /UNTRUSTED SELF-REPORT/);
  assert.match(p, /VERIFIED or UNVERIFIED/);
  assert.match(p, /missing, empty, or/);
  assert.match(p, /42 passed/);
});

test("parseJudgeVerdict is strict about the token", () => {
  assert.equal(parseJudgeVerdict("All good.\nVERIFIED")?.done, true);
  assert.equal(parseJudgeVerdict("No output.\nUNVERIFIED")?.done, false);
  // UNVERIFIED contains VERIFIED: the overlap correction is load-bearing.
  assert.equal(parseJudgeVerdict("UNVERIFIED")?.done, false);
  assert.equal(parseJudgeVerdict("Reasoning.\nMore.\nVERIFIED")?.done, true);

  assert.equal(parseJudgeVerdict("VERIFIED or UNVERIFIED"), null);
  assert.equal(parseJudgeVerdict("VERIFIED\nVERIFIED"), null);
  assert.equal(parseJudgeVerdict("probably fine"), null);
  assert.equal(parseJudgeVerdict("verified"), null);
  assert.equal(parseJudgeVerdict(""), null);
  assert.equal(parseJudgeVerdict("   \n "), null);
});

test("extractEvidence collects tool output, newest first, bounded", () => {
  const tool = (text: string, extra: Record<string, unknown> = {}) => ({
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text }],
    ...extra,
  });

  assert.match(extractEvidence([tool("42 passed")], 4000), /\[bash\] 42 passed/);
  // A failure is evidence the work is unproven.
  assert.match(extractEvidence([tool("boom", { isError: true })], 4000), /ERROR/);
  assert.equal(extractEvidence([{ role: "assistant", content: [{ type: "text", text: "done" }] }], 4000), "");
  assert.equal(extractEvidence("nope", 4000), "");
  assert.equal(extractEvidence([], 4000), "");
  assert.equal(extractEvidence([tool("x")], 0), "");
  // Junk entries are skipped, not fatal, and the real result still lands.
  assert.match(extractEvidence([null, 42, "s", tool("survivor")], 4000), /survivor/);

  const recent = extractEvidence([tool("oldest"), tool("middle"), tool("newest")], 26);
  assert.match(recent, /newest/);
  assert.doesNotMatch(recent, /oldest/);

  const ordered = extractEvidence([tool("first"), tool("second")], 4000);
  assert.ok(ordered.indexOf("first") < ordered.indexOf("second"));
  // A truncated command line reads as a complete but empty run.
  assert.equal(extractEvidence([tool("x".repeat(500))], 100), "");
});

test("judgeFailureContext marks the rationale as untrusted", () => {
  const text = judgeFailureContext("no output", "");
  assert.match(text, /judge-rejected/);
  assert.match(text, /untrusted model output/);
});

// --- Clause 9 precedence -------------------------------------------------

const s0 = {
  continuations: 0,
  startedAtMs: Date.now() - 1000,
  cycleId: "c0",
  goal: { status: "idle" as const, objective: "", continuationsUsed: 0 },
};
const LIMITS = { maxContinuations: 3, timeoutMs: 30 * 60 * 1000 };

function claim(extra: Record<string, unknown> = {}) {
  return {
    headless: false,
    headlessOptIn: false,
    claimsCompletion: true,
    scheduledContinuation: false,
    stopReason: "stop",
    configuredGates: [],
    gateResultIsStale: false,
    nowMs: Date.now(),
    ...extra,
  };
}

const decide = (input: Record<string, unknown>, state = s0) =>
  shouldContinue({ state, limits: LIMITS, goal: s0.goal, input } as never);
test("an unconfigured judge settles claimed_unverified, unchanged", () => {
  assert.equal(decide(claim()).reason, "claimed_unverified");
});

test("an approving judge settles judged_complete", () => {
  assert.equal(decide(claim({ judgeVerdict: { done: true, rationale: "ok" } })).reason, "judged_complete");
});

test("a rejecting judge continues while budget remains", () => {
  const d = decide(claim({ judgeVerdict: { done: false, rationale: "no" } }));
  assert.equal(d.kind, "continue");
  assert.equal(d.continuations, 1);
});

test("a rejecting judge settles the continuation cap when already reached", () => {
  const d = decide(claim({ judgeVerdict: { done: false, rationale: "no" } }), { ...s0, continuations: 3 });
  assert.equal(d.reason, "continuation_limit");
});

test("an unusable judge settles judge_unavailable, never judged_complete", () => {
  assert.equal(decide(claim({ judgeUnavailable: true })).reason, "judge_unavailable");
});

test("a verdict takes precedence over judgeUnavailable", () => {
  assert.equal(
    decide(claim({ judgeVerdict: { done: true, rationale: "ok" }, judgeUnavailable: true })).reason,
    "judged_complete",
  );
});

test("gates remain the authority: the judge is never consulted", () => {
  const gates = ["nix flake check"];
  assert.equal(decide(claim({ configuredGates: gates, judgeVerdict: { done: true, rationale: "ok" } })).kind, "verify");
  assert.equal(decide(claim({ configuredGates: gates, judgeUnavailable: true })).kind, "verify");
  assert.equal(
    decide(claim({
      configuredGates: gates,
      judgeVerdict: { done: false, rationale: "no" },
      gateOutcome: { aggregate: "passed", local: [{ kind: "pass", command: "nix flake check", attempt: 1 }] },
    })).reason,
    "verified_complete",
  );
});