// AC-2: gate evidence is auditable after the fact.
// RED: the executor exposes no evidence bundle.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runGateSet,
  gateFailureContext,
  evidenceBundle,
  type GateAttempt,
} from "../extension/lib/gates.ts";
import type { Attestation, ExecPort, ExecResult, GitPort } from "../extension/lib/ports.ts";

class FakeExec implements ExecPort {
  calls: string[] = [];
  private readonly result: (n: number) => ExecResult;
  constructor(result: (n: number) => ExecResult) {
    this.result = result;
  }
  async run(command: string, _cwd: string, _timeoutMs: number): Promise<ExecResult> {
    this.calls.push(command);
    return this.result(this.calls.length);
  }
}

class FakeGit implements GitPort {
  digest = "d0";
  now = 0;
  attest(_cwd: string, _deadlineMs: number): Promise<Attestation> {
    return Promise.resolve({ kind: "available", digest: this.digest, capturedAtMs: this.now });
  }
  nowMs(): number {
    return this.now;
  }
}

const base = { cwd: "/repo", perCommandTimeoutMs: 1000, totalTimeoutMs: 5000, maxRetries: 3 };

test("a failed gate's evidence names command, attempt, exit text, and digest", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "boom" }));
  const git = new FakeGit();
  const run = await runGateSet({ ...base, commands: ["false"], exec, git }, new Map());
  const bundle = evidenceBundle(run.local, run.exhausted, "false");
  assert.equal(bundle.command, "false");
  assert.equal(bundle.attempt, 1);
  assert.equal(bundle.exitText, "exited 1");
  assert.ok(bundle.digest, "the digest that justified the verdict is recorded");
  assert.equal(bundle.digest, "d0");
});

test("a no-progress skip records the digest that justified not rerunning", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "" }));
  const git = new FakeGit();
  const attempts = new Map<string, GateAttempt>([
    ["false", { command: "false", attempts: 1, failureDigest: "d0" }],
  ]);
  const run = await runGateSet({ ...base, commands: ["false"], exec, git }, attempts);
  const bundle = evidenceBundle(run.local, run.exhausted, "false");
  assert.equal(bundle.kind, "not-run");
  assert.equal(bundle.attempt, 2);
  assert.equal(bundle.digest, "d0", "an auditor can see WHY the gate was skipped");
  assert.equal(exec.calls.length, 0);
});

test("a passing gate records a pass with no digest", async () => {
  const exec = new FakeExec(() => ({ ok: true, exitText: "exited 0", output: "" }));
  const run = await runGateSet({ ...base, commands: ["true"], exec, git: new FakeGit() }, new Map());
  const bundle = evidenceBundle(run.local, run.exhausted, "true");
  assert.equal(bundle.kind, "pass");
  assert.equal(bundle.digest, "");
});

test("evidence survives a run with no results", () => {
  const bundle = evidenceBundle([], false, "nope");
  assert.equal(bundle.kind, "not-run");
  assert.equal(bundle.attempt, 0);
});

test("the failure text and the evidence bundle agree on the attempt", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 2", output: "x" }));
  const run = await runGateSet({ ...base, commands: ["t"], exec, git: new FakeGit() }, new Map());
  const bundle = evidenceBundle(run.local, run.exhausted, "t");
  assert.match(gateFailureContext(bundle, 3, ""), /attempt 1\/3/);
  assert.equal(bundle.attempt, 1);
});
