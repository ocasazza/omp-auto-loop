// The reflect pass: a model's reply becomes at most one pending proposal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReflectPrompt, parseReflection, proposeImprovement, recentCycles } from "../extension/lib/reflect.ts";
import { encodeOp, foldPolicy, type PolicyOp } from "../extension/lib/policy.ts";
import type { ChatPort } from "../extension/lib/model.ts";

test("the time limit is proposed in minutes and stored in milliseconds", () => {
  const r = parseReflection('{"target": "param:timeoutMinutes", "after": 45, "rationale": "timeouts dominate"}');
  assert.deepEqual(r, { target: { kind: "param", key: "timeoutMs" }, after: 2_700_000, rationale: "timeouts dominate" });
});

test("prose around the JSON object is tolerated", () => {
  const r = parseReflection('Here is my proposal:\n{"target": "param:maxContinuations", "after": "5", "rationale": "r"}\nThanks.');
  assert.equal(r?.after, 5);
});

test("an unknown target, an out-of-range value, or a missing rationale is refused", () => {
  for (const reply of [
    '{"target": "param:timeoutMs", "after": 45, "rationale": "r"}',
    '{"target": "param:maxContinuations", "after": 500, "rationale": "r"}',
    '{"target": "param:timeoutMinutes", "after": 0, "rationale": "r"}',
    '{"target": "prompt:continuation", "after": "  ", "rationale": "r"}',
    '{"target": "prompt:continuation", "after": "text"}',
    "no json at all",
  ]) {
    assert.equal(parseReflection(reply), null, reply);
  }
});

test("the prompt never shows the model a millisecond figure", () => {
  const prompt = buildReflectPrompt({
    prompts: { continuation: "keep going", judgeCriteria: "" },
    limits: { maxContinuations: 3, timeoutMs: 1_800_000 },
    mix: [],
    cycles: [],
    overturned: [],
    rejected: [{ proposal: "param:timeoutMinutes = 60", rationale: "r" }],
  });
  assert.match(prompt, /timeoutMinutes: 30/);
  assert.doesNotMatch(prompt, /1800000/);
});

test("a cycle's trail is what happened between its goal and its settle", () => {
  const cycles = recentCycles(
    [
      { ts: "1", session: "a", msg: "goal set: g" },
      { ts: "2", session: "a", msg: "autonomous continuation: 1/3" },
      { ts: "3", session: "a", msg: "settled: claimed_unverified" },
      { ts: "4", session: "a", msg: "heartbeat" },
      { ts: "5", session: "a", msg: "settled: cycle_timeout" },
    ],
    8,
  );
  assert.deepEqual(
    cycles.map((c) => [c.goal, c.reason, c.trail]),
    [
      ["g", "claimed_unverified", ["autonomous continuation: 1/3"]],
      ["g", "cycle_timeout", ["heartbeat"]],
    ],
  );
});

const counting = (reply: string) => {
  const port = { calls: 0 } as ChatPort & { calls: number };
  port.complete = async () => {
    port.calls++;
    return { ok: true, text: reply };
  };
  return port;
};

const deps = (chat: ChatPort, policyText: string, appended: PolicyOp[]) => ({
  chat,
  policy: foldPolicy(policyText),
  events: [],
  limits: { maxContinuations: 3, timeoutMs: 1_800_000 },
  mix: [],
  append: (op: PolicyOp) => appended.push(op),
  source: "s#1",
  nowMs: 1,
});

test("a usable reply files exactly one pending proposal", async () => {
  const appended: PolicyOp[] = [];
  const chat = counting('{"target": "param:maxContinuations", "after": 5, "rationale": "r"}');
  const result = await proposeImprovement(deps(chat, "", appended));
  assert.equal(result.ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.op, "proposal");
});

test("while a proposal is pending the model is not even asked", async () => {
  const pending = encodeOp(
    { op: "proposal", id: "p1", source: "s", target: { kind: "param", key: "maxContinuations" }, after: 4, rationale: "r" },
    1,
    "t",
  );
  const appended: PolicyOp[] = [];
  const chat = counting('{"target": "param:maxContinuations", "after": 5, "rationale": "r"}');
  const result = await proposeImprovement(deps(chat, pending, appended));
  assert.equal(result.ok, false);
  assert.equal(chat.calls, 0);
  assert.equal(appended.length, 0);
});

test("an unusable reply files nothing and says why", async () => {
  const appended: PolicyOp[] = [];
  const result = await proposeImprovement(deps(counting("I think you should do better."), "", appended));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /unusable reply/);
  assert.equal(appended.length, 0);
});
