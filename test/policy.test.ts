// The policy log: what an operator changes on the dashboard, folded into the
// state every session reads. Pure — text in, data out.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWith,
  encodeOp,
  foldPolicy,
  looksLikeProse,
  promptText,
  reviewQueue,
  validateOp,
  vocabulary,
  DEFAULT_PROMPTS,
  type PolicyOp,
} from "../extension/lib/policy.ts";

const log = (...ops: PolicyOp[]) => ops.map((op, i) => encodeOp(op, 1_000 + i, "test")).join("");

test("the latest write wins, and null returns a param to env/default", () => {
  const p = foldPolicy(
    log(
      { op: "param", key: "maxContinuations", value: 5 },
      { op: "param", key: "maxContinuations", value: 8 },
      { op: "param", key: "timeoutMs", value: 600_000 },
      { op: "param", key: "timeoutMs", value: null },
    ),
  );
  assert.deepEqual(p.params, { maxContinuations: 8 });
});

test("the first claim on a queued goal wins; a later claim changes nothing", () => {
  const p = foldPolicy(
    log(
      { op: "queue.add", id: "q1", objective: "ship it", priority: 1 },
      { op: "queue.claim", id: "q1", session: "a#1" },
      { op: "queue.claim", id: "q1", session: "b#2" },
    ),
  );
  assert.equal(p.queue[0]?.status, "claimed");
  assert.equal(p.queue[0]?.claimedBy, "a#1");
});

test("the queue runs lowest priority first, then oldest", () => {
  const p = foldPolicy(
    log(
      { op: "queue.add", id: "q1", objective: "first added", priority: 100 },
      { op: "queue.add", id: "q2", objective: "second added", priority: 100 },
      { op: "queue.add", id: "q3", objective: "urgent", priority: 100 },
      { op: "queue.priority", id: "q3", priority: 1 },
    ),
  );
  assert.deepEqual(p.queue.map((q) => q.id), ["q3", "q1", "q2"]);
});

test("accepting a proposal applies it; rejecting or re-deciding does not", () => {
  const prompt = { op: "proposal", id: "p1", source: "s", target: { kind: "prompt", key: "continuation" }, after: "new text", rationale: "why" } as const;
  const param = { op: "proposal", id: "p2", source: "s", target: { kind: "param", key: "maxContinuations" }, after: 6, rationale: "why" } as const;

  const accepted = foldPolicy(log(prompt, { op: "proposal.decide", id: "p1", decision: "accepted" }));
  assert.equal(promptText(accepted, "continuation"), "new text");
  // `before` is what was in effect when the proposal was made.
  assert.equal(accepted.proposals[0]?.before, DEFAULT_PROMPTS.continuation);

  const rejected = foldPolicy(log(param, { op: "proposal.decide", id: "p2", decision: "rejected" }));
  assert.equal(rejected.params.maxContinuations, undefined);

  const flipped = foldPolicy(
    log(param, { op: "proposal.decide", id: "p2", decision: "rejected" }, { op: "proposal.decide", id: "p2", decision: "accepted" }),
  );
  assert.equal(flipped.proposals[0]?.status, "rejected");
  assert.equal(flipped.params.maxContinuations, undefined);
});

test("malformed or out-of-bounds lines are skipped, never applied", () => {
  const text = [
    "not json",
    JSON.stringify({ op: "param", key: "maxContinuations", value: 500, at: 1 }),
    JSON.stringify({ op: "param", key: "maxContinuations", value: 2.5, at: 1 }),
    JSON.stringify({ op: "param", key: "nope", value: 1, at: 1 }),
    JSON.stringify({ op: "param", key: "maxContinuations", value: 4 }),
    encodeOp({ op: "param", key: "maxContinuations", value: 4 }, 2, "t").trim(),
  ].join("\n");
  assert.deepEqual(foldPolicy(text).params, { maxContinuations: 4 });
});

test("a rule re-labels only chatter, never a class the loop branches on", () => {
  const p = foldPolicy(
    log(
      { op: "rule", prefix: "dashboard unavailable:", cls: "noise" },
      { op: "rule", prefix: "autonomous", cls: "noise" },
    ),
  );
  assert.equal(classifyWith(p, "dashboard unavailable: port in use"), "noise");
  assert.equal(classifyWith(p, "autonomous continuation: 1/3"), "continue");
  assert.equal(classifyWith(p, "something else"), "other");
  assert.ok("error" in validateOp({ op: "rule", prefix: "x", cls: "continue" }));
});

test("the longest matching rule prefix wins", () => {
  const p = foldPolicy(
    log({ op: "rule", prefix: "judge", cls: "a" }, { op: "rule", prefix: "judge verdict:", cls: "b" }),
  );
  assert.equal(classifyWith(p, "judge verdict: VERIFIED"), "b");
  assert.equal(classifyWith(p, "judge unavailable: x"), "a");
});

test("only event classes and settle reasons take new terms; settle ids may carry spaces", () => {
  assert.ok("error" in validateOp({ op: "term.add", vocab: "decision", id: "x", label: "X", description: "" }));
  assert.ok("op" in validateOp({ op: "term.add", vocab: "settle", id: "turn ended error", label: "Turn ended error", description: "" }));
  assert.ok("error" in validateOp({ op: "term.add", vocab: "event", id: "has space", label: "X", description: "" }));

  const p = foldPolicy(
    log(
      { op: "term.add", vocab: "event", id: "noise", label: "Noise", description: "chatter" },
      { op: "term", vocab: "event", id: "noise", hidden: true },
      { op: "term", vocab: "event", id: "heartbeat", label: "Idle nudge" },
    ),
  );
  const events = vocabulary(p, "event");
  assert.deepEqual(
    events.filter((t) => t.id === "noise" || t.id === "heartbeat").map((t) => [t.id, t.label, t.hidden, t.custom]),
    [
      ["heartbeat", "Idle nudge", false, false],
      ["noise", "Noise", true, true],
    ],
  );
});

test("saving blank criteria clears them", () => {
  const p = foldPolicy(
    log({ op: "criteria", repo: "r", text: "pushed and green" }, validateOp({ op: "criteria", repo: "r", text: "  " }).op as PolicyOp),
  );
  assert.deepEqual(p.criteria, {});
});

test("a sentence saved as a gate is flagged; a command is not", () => {
  assert.ok(looksLikeProse("Push all changes related to the goal to active branches or PRs and make sure all checks are passing."));
  assert.ok(!looksLikeProse("bun test"));
  assert.ok(!looksLikeProse("nix build .#checks.aarch64-darwin.tests --no-link"));
});

test("each done claim joins the goal it closed and the judge's words, newest first", () => {
  const events = [
    { ts: "2026-01-01T00:00:01Z", session: "a#1", msg: "goal set: fix the thing" },
    { ts: "2026-01-01T00:00:02Z", session: "b#2", msg: "goal set: other work" },
    { ts: "2026-01-01T00:00:03Z", session: "a#1", msg: "judge verdict: VERIFIED — tests passed" },
    { ts: "2026-01-01T00:00:04Z", session: "a#1", msg: "settled: judged_complete" },
    { ts: "2026-01-01T00:00:05Z", session: "b#2", msg: "settled: claimed_unverified" },
    { ts: "2026-01-01T00:00:06Z", session: "a#1", msg: "settled: cycle_timeout" },
    // A later goal must not be attributed to the earlier settle.
    { ts: "2026-01-01T00:00:07Z", session: "b#2", msg: "goal set: next thing" },
  ];
  const p = foldPolicy(log({ op: "ratify", verdict: "a#1@2026-01-01T00:00:04Z", decision: "overturned", note: "no" }));
  const q = reviewQueue(events, p);
  assert.deepEqual(
    q.map((v) => [v.session, v.reason, v.goal, v.judge, v.ratification?.decision]),
    [
      ["b#2", "claimed_unverified", "other work", "", undefined],
      ["a#1", "judged_complete", "fix the thing", "VERIFIED — tests passed", "overturned"],
    ],
  );
});
