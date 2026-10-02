// AC-3: fail-closed is preserved, and the emitted records stay inside the
// grammar the separately-deployed jump-cannon pest importer accepts.
//
// Heart (the coordinator we studied) refuses to reconcile when the target
// lacks lifecycle capabilities rather than guessing. That discipline is ours
// too: absence of evidence must never read as a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGateOutcome, shouldContinue, type CycleState, type Limits } from "../extension/lib/core.ts";
import { runGateSet, evidenceBundle, type GateAttempt } from "../extension/lib/gates.ts";
import { createGraphProjection, type SessionState } from "../extension/lib/observation.ts";
import type { Attestation, ExecPort, ExecResult, GitPort } from "../extension/lib/ports.ts";

const LIMITS: Limits = { maxContinuations: 3, timeoutMs: 1_800_000 };
const S0: CycleState = { continuations: 0, startedAtMs: 0, cycleId: "c1" };
const GOAL = { status: "idle" as const, objective: "", continuationsUsed: 0 };

class PassExec implements ExecPort {
  async run(_command: string, _cwd: string, _timeoutMs: number): Promise<ExecResult> {
    return { ok: true, exitText: "exited 0", output: "" };
  }
}
class UnavailableGit implements GitPort {
  attest(_cwd: string, _d: number): Promise<Attestation> {
    return Promise.resolve({ kind: "unavailable", reason: "not a repository" });
  }
  nowMs(): number {
    return 0;
  }
}

test("a gate that passes while attestation is unavailable still settles unverified", async () => {
  const run = await runGateSet(
    { commands: ["true"], maxRetries: 3, perCommandTimeoutMs: 1000, totalTimeoutMs: 5000, cwd: "/r", exec: new PassExec(), git: new UnavailableGit() },
    new Map(),
  );
  assert.equal(run.local[0]?.kind, "pass", "the command itself passed");
  assert.equal(run.unavailable, true, "but we could not prove the workspace state");

  const outcome = buildGateOutcome(run.local, run.exhausted, run.unavailable);
  const decision = shouldContinue({
    state: S0,
    limits: LIMITS,
    goal: GOAL,
    input: {
      headless: false, headlessOptIn: false, scheduledContinuation: false,
      stopReason: "stop", claimsCompletion: true,
      configuredGates: ["true"], gateOutcome: outcome, gateResultIsStale: false, nowMs: 0,
    },
  });
  assert.equal(decision.kind, "settle");
  assert.equal(decision.reason, "gate_unavailable", "absence of evidence is never a verified pass");
});

test("retry exhaustion settles unverified even though the last result failed", () => {
  const outcome = buildGateOutcome(
    [{ kind: "fail", command: "t", exitText: "exited 1", output: "", attempt: 4, digest: "d" }],
    true,
  );
  const decision = shouldContinue({
    state: S0, limits: LIMITS, goal: GOAL,
    input: {
      headless: false, headlessOptIn: false, scheduledContinuation: false,
      stopReason: "stop", claimsCompletion: true,
      configuredGates: ["t"], gateOutcome: outcome, gateResultIsStale: false, nowMs: 0,
    },
  });
  assert.equal(decision.reason, "gate_retries_exhausted");
  assert.notEqual(decision.reason, "verified_complete");
});

test("every emitted graph line matches a grammar the importer accepts", () => {
  // Mirrors the pest package: N|id|title|kind|tags|props[|body] and
  // E|src|tgt, no empty id, no bare delimiter runs, no raw newline.
  const nodeRe = /^N\|[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]*\|[^|\n]*(?:\|[^\n]+)?$/;
  const edgeRe = /^E\|[^|\n]+\|[^|\n]+(?:\|[a-z_]+)?$/;
  const active: SessionState = {
    key: "k1",
    label: "repo#k1",
    cwd: "/a b/c",
    agent: "sub",
    parentKey: "k0",
    repo: { root: "/src/a,b;c", name: "a,b;c" },
    goal: { objective: "ship it\n  today | now", status: "active" },
    gates: ["nix build .#x; echo a=b", "just test\nnow"],
    model: "anthropic/claude|opus",
    continuations: 1,
    maxContinuations: 3,
    heartbeats: 4,
    outcome: "turn ended, error",
  };
  const p = createGraphProjection();
  let text = p.apply("", { ...active, key: "k0", agent: "main", parentKey: null, goal: null }, "   \n  ", "t");
  text = p.apply(text, active, "gate failed (t) — attempt 1\nstderr: boom | x=1", "2026-01-01T00:00:00.000Z");
  text = p.compact(text, 6);
  for (const line of text.split("\n").filter(Boolean)) {
    if (line.startsWith("N|")) {
      assert.match(line, nodeRe, `node line must satisfy the importer grammar: ${line}`);
    } else {
      assert.match(line, edgeRe, `edge line must be E|src|tgt: ${line}`);
    }
  }
});
