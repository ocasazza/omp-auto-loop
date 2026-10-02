// Gate executor: aggregate deadline, retry accounting, and the
// unchanged-workspace no-progress skip (prime-agent autonomous.ts:459).
// Ports are fakes; no process is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runGateSet, gateFailureContext, type GateAttempt } from "../extension/lib/gates.ts";
import type { Attestation, ExecPort, ExecResult, GitPort } from "../extension/lib/ports.ts";

class FakeExec implements ExecPort {
  calls: string[] = [];
  private readonly result: (command: string, n: number) => ExecResult;
  constructor(result: (command: string, n: number) => ExecResult) {
    this.result = result;
  }
  async run(command: string, _cwd: string, _timeoutMs: number): Promise<ExecResult> {
    this.calls.push(command);
    return this.result(command, this.calls.filter((c) => c === command).length);
  }
}

class FakeGit implements GitPort {
  digest = "d0";
  now = 0;
  attestCalls = 0;
  private readonly unavailable: boolean;
  constructor(unavailable = false) {
    this.unavailable = unavailable;
  }
  async attest(_cwd: string, _deadlineMs: number): Promise<Attestation> {
    this.attestCalls += 1;
    if (this.unavailable) return { kind: "unavailable", reason: "not a repo" };
    return { kind: "available", digest: this.digest, capturedAtMs: this.now };
  }
  nowMs(): number {
    return this.now;
  }
}

const base = { cwd: "/repo", perCommandTimeoutMs: 1000, totalTimeoutMs: 5000 };

test("passing gate yields a pass local result and no failure", async () => {
  const exec = new FakeExec(() => ({ ok: true, exitText: "exited 0", output: "" }));
  const git = new FakeGit();
  const attempts = new Map<string, GateAttempt>();
  const run = await runGateSet({ ...base, commands: ["true"], maxRetries: 3, exec, git }, attempts);
  assert.deepEqual(run.local, [{ kind: "pass", command: "true" }]);
  assert.equal(run.exhausted, false);
  assert.equal(attempts.get("true")?.attempts, 0);
});

test("a failing gate records the attempt and its exit text", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "tests failed" }));
  const git = new FakeGit();
  const attempts = new Map<string, GateAttempt>();
  const run = await runGateSet({ ...base, commands: ["false"], maxRetries: 3, exec, git }, attempts);
  assert.equal(run.local[0].kind, "fail");
  assert.equal(attempts.get("false")?.attempts, 1);
  assert.equal(attempts.get("false")?.failureDigest, "d0");
  assert.equal(exec.calls.length, 1);
});

test("unchanged worktree is NOT rerun (no-progress skip)", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "" }));
  const git = new FakeGit();
  const attempts = new Map<string, GateAttempt>([
    ["false", { command: "false", attempts: 1, failureDigest: "d0" }],
  ]);
  const run = await runGateSet({ ...base, commands: ["false"], maxRetries: 3, exec, git }, attempts);
  assert.equal(exec.calls.length, 0, "gate must not rerun on an unchanged worktree");
  assert.equal(run.local[0].kind, "not-run");
  assert.equal(attempts.get("false")?.attempts, 2);
});

test("the skip cannot be gamed: a real edit makes the gate rerun", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "" }));
  const git = new FakeGit();
  git.digest = "d1"; // the worktree changed since the last failure
  const attempts = new Map<string, GateAttempt>([
    ["false", { command: "false", attempts: 1, failureDigest: "d0" }],
  ]);
  const run = await runGateSet({ ...base, commands: ["false"], maxRetries: 3, exec, git }, attempts);
  assert.equal(exec.calls.length, 1, "changed worktree must rerun the gate");
  assert.equal(run.local[0].kind, "fail");
});

test("retries past the cap report exhaustion", async () => {
  const exec = new FakeExec(() => ({ ok: false, exitText: "exited 1", output: "" }));
  const git = new FakeGit();
  const attempts = new Map<string, GateAttempt>([
    ["false", { command: "false", attempts: 3, failureDigest: "other" }],
  ]);
  const run = await runGateSet({ ...base, commands: ["false"], maxRetries: 3, exec, git }, attempts);
  assert.equal(run.exhausted, true);
  assert.equal(attempts.get("false")?.attempts, 4);
});

test("an exhausted total deadline stops the set and flags unavailable", async () => {
  // The clock advances past the whole-set budget while the first gate runs,
  // so the SECOND command must not start (design §5.2: each command is
  // clamped to min(perCommand, remaining total)).
  const git = new FakeGit();
  const exec = new FakeExec(() => {
    git.now += 10_000;
    return { ok: true, exitText: "exited 0", output: "" };
  });
  const run = await runGateSet({ ...base, commands: ["a", "b"], maxRetries: 3, exec, git }, new Map());
  assert.equal(exec.calls.length, 1, "only the first gate may start");
  assert.equal(run.unavailable, true);
  assert.equal(run.local[0]?.kind, "pass", "the first gate did pass");
  assert.equal(run.local[1]?.kind, "timeout", "the second never ran");
});

test("a gate that cannot attest is evidence-incomplete, not a pass", async () => {
  const exec = new FakeExec(() => ({ ok: true, exitText: "exited 0", output: "" }));
  const git = new FakeGit(true);
  const run = await runGateSet({ ...base, commands: ["true"], maxRetries: 3, exec, git }, new Map());
  assert.equal(run.unavailable, true, "no attestation means no verified verdict");
});

test("gate failure text carries attempt, command, and evidence", () => {
  const text = gateFailureContext(
    { kind: "fail", command: "just test", exitText: "exited 1", output: "3 failing", attempt: 2 },
    3,
    "Active goal (g1): ship it. ",
  );
  assert.match(text, /attempt 2\/3/);
  assert.match(text, /`just test` exited 1/);
  assert.match(text, /3 failing/);
  assert.match(text, /Active goal \(g1\): ship it\./);
});

test("a not-run failure explains the edit-first rule", () => {
  const text = gateFailureContext({ kind: "not-run", command: "just test", attempt: 2 }, 3, "");
  assert.match(text, /not rerun: workspace unchanged/);
  assert.match(text, /Edit source files/);
});
