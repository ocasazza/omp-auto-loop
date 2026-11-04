// The panel-kit site API: GET /api/trace and GET /api/site, and the writes the
// panel-kit host POSTs back (examples/autoloop.rs against this server).
//
// The conformance target is panel-kit's own fixture, copied into test/fixtures/
// from panel-kit nix/data/ (the grammars there parse what these routes serve):
// projecting the fixture's policy, events and projection must reproduce the
// fixture record for record, and a write must land as the PolicyOp the loop
// already understands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeOp, type PolicyOp } from "../extension/lib/policy.ts";

const TRACE_LINES = readFileSync(new URL("./fixtures/autoloop-trace.lines", import.meta.url), "utf8");
const CONTROL_FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/autoloop-control.json", import.meta.url), "utf8"));

// The event log behind the fixture's claims and term counts: the events the
// trace fixture's producers wrote, in events.jsonl shape. Two goal-set events,
// two unclassified ones, and the two settles that also count under their
// reasons — which is exactly the fixture's term counts.
const EVENTS =
  [
    { ts: "2026-10-04T01:00:00.000Z", session: "planner#a1", kind: "goal", msg: "goal set: fix the flaky gate" },
    { ts: "2026-10-04T01:01:00.000Z", session: "coder", kind: "other", msg: "continue: 1/5" },
    { ts: "2026-10-04T01:02:00.000Z", session: "planner#a1", kind: "other", msg: "gate: bun test passed" },
    { ts: "2026-10-04T01:03:00.000Z", session: "reviewer#b1", kind: "goal", msg: "goal set: audit the queue" },
    { ts: "2026-10-04T01:04:00.000Z", session: "reviewer#b1", kind: "settled", msg: "settled: claimed_unverified" },
    { ts: "2026-10-04T01:05:00.000Z", session: "planner#a1", kind: "settled", msg: "settled: judged_complete" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

// The policy behind the fixture's proposal, queue and repo policies. The
// proposal is the fourth op, so its `at` is epoch ms 4 — the fixture's
// 1970-01-01T00:00:00.004Z.
const POLICY_OPS: PolicyOp[] = [
  { op: "gates", repo: "alpha", commands: ["bun test", "nix flake check"] },
  { op: "criteria", repo: "beta", text: "pushed and green" },
  { op: "queue.add", id: "q1", objective: "retire the html page", priority: 1, repo: "beta" },
  { op: "proposal", id: "p1", source: "reflect", target: { kind: "param", key: "maxContinuations" }, after: 6, rationale: "sessions run out" },
];
const POLICY = POLICY_OPS.map((op, i) => encodeOp(op, i + 1, "test")).join("");

const withDashboard = async (
  options: {
    readProjection?: () => string;
    readEvents?: () => string;
    readPolicy?: () => string;
    writePolicy?: (op: PolicyOp) => void;
    steer?: (c: { target: string; action: string; value?: string }) => void;
    limits?: () => { maxContinuations: number; timeoutMs: number; parkAfter: number };
  },
  run: (base: string) => Promise<void>,
) => {
  const { createDashboard } = await import("../extension/lib/dashboard.ts"); // mirrors dashboard.test.ts: the module lazy-imports node:http itself
  const http = await import("node:http");
  // Take a port the way the other route tests do: bind a probe, free it, reuse it.
  const probe = http.createServer(() => {});
  const bound = Promise.withResolvers<void>();
  probe.listen(0, "127.0.0.1", () => bound.resolve());
  await bound.promise;
  const address = probe.address() as { port: number }; // a TCP listen always answers with AddressInfo
  const { port } = address;
  const freed = Promise.withResolvers<void>();
  probe.close(() => freed.resolve());
  await freed.promise;

  const listening = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  const dashboard = createDashboard({
    port,
    readProjection: () => "",
    ...options,
    // The real signal, not a guessed delay: the port is actually bound.
    onListening: () => listening.resolve(),
    onError: (message) => failed.reject(new Error(message)),
  });
  try {
    await Promise.race([listening.promise, failed.promise]);
    await run(`http://127.0.0.1:${port}`);
  } finally {
    dashboard.close();
  }
};

test("GET /api/trace returns the projection text the trace grammar parses", async () => {
  await withDashboard({ readProjection: () => TRACE_LINES }, async (base) => {
    const response = await fetch(`${base}/api/trace`);

    assert.equal(response.status, 200);
    assert.ok((response.headers.get("content-type") ?? "").includes("text/plain"));
    assert.equal(await response.text(), TRACE_LINES);
  });
});

test("the served site matches panel-kit's control fixture record for record", async () => {
  await withDashboard(
    {
      readProjection: () => TRACE_LINES,
      readEvents: () => EVENTS,
      readPolicy: () => POLICY,
      limits: () => ({ maxContinuations: 3, timeoutMs: 1_800_000, parkAfter: 3 }),
    },
    async (base) => {
      const response = await fetch(`${base}/api/site`);

      assert.equal(response.status, 200);
      assert.ok((response.headers.get("content-type") ?? "").includes("application/json"));
      assert.deepEqual(await response.json(), CONTROL_FIXTURE);
    },
  );
});

// -- Writes ------------------------------------------------------------------

const postSite = (base: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${base}/api/site`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

/** A dashboard over the fixture's state with an in-memory policy log and steering capture. */
const withSite = async (run: (base: string, ops: PolicyOp[], steered: { target: string; action: string; value?: string }[]) => Promise<void>) => {
  const ops: PolicyOp[] = [];
  const steered: { target: string; action: string; value?: string }[] = [];
  await withDashboard(
    {
      readProjection: () => TRACE_LINES,
      readEvents: () => EVENTS,
      readPolicy: () => POLICY + ops.map((op, i) => encodeOp(op, 100 + i, "test")).join(""),
      writePolicy: (op) => ops.push(op),
      steer: (command) => steered.push(command),
      limits: () => ({ maxContinuations: 3, timeoutMs: 1_800_000, parkAfter: 3 }),
    },
    (base) => run(base, ops, steered),
  );
};

/** The emitter's write for one record: the served object with fields overridden. */
const revisedBody = async (base: string, id: string, fields: Record<string, string>) => {
  const site = await (await fetch(`${base}/api/site`)).json();
  const record = site.objects.find((object: { id: string }) => object.id === id);
  assert.ok(record, `the site has no record ${id}`);
  return { objects: [{ ...record, ...fields }], morphisms: [] };
};

test("each control edit lands as the PolicyOp it names", async () => {
  await withSite(async (base, ops) => {
    // ratify (accepted) — the claim record, revised, as the emitter writes it
    assert.equal((await postSite(base, await revisedBody(base, "claim:planner#a1@2026-10-04T01:05:00.000Z", { decision: "accepted", note: "judge agreed" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "ratify", verdict: "planner#a1@2026-10-04T01:05:00.000Z", decision: "accepted", note: "judge agreed" });
    // decide
    assert.equal((await postSite(base, await revisedBody(base, "proposal:p1", { status: "accepted" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "proposal.decide", id: "p1", decision: "accepted" });
    // prioritize
    assert.equal((await postSite(base, await revisedBody(base, "queued_goal:q1", { priority: "0" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "queue.priority", id: "q1", priority: 0 });
    // retire
    assert.equal((await postSite(base, await revisedBody(base, "queued_goal:q1", { status: "retired" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "queue.retire", id: "q1" });
    // set_gates — a trailing newline is lines, not a command
    assert.equal((await postSite(base, await revisedBody(base, "repo_policy:alpha", { gates: "cargo test\n" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "gates", repo: "alpha", commands: ["cargo test"] });
    // set_criteria — blank clears
    assert.equal((await postSite(base, await revisedBody(base, "repo_policy:beta", { criteria: "" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "criteria", repo: "beta", text: null });
    // set_value
    assert.equal((await postSite(base, await revisedBody(base, "param:maxContinuations", { value: "7" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "param", key: "maxContinuations", value: 7 });
    // set_text
    assert.equal((await postSite(base, await revisedBody(base, "prompt:judgeCriteria", { text: "evidence first" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "prompt", key: "judgeCriteria", text: "evidence first" });
    // describe and hide
    assert.equal((await postSite(base, await revisedBody(base, "term:event:other", { description: "Matched nothing declared." }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "term", vocab: "event", id: "other", description: "Matched nothing declared." });
    assert.equal((await postSite(base, await revisedBody(base, "term:event:other", { hidden: "true" }))).status, 202);
    assert.deepEqual(ops.at(-1), { op: "term", vocab: "event", id: "other", hidden: true });
  });
});

test("overturning a claim from the site sends the session back to work", async () => {
  await withSite(async (base, ops, steered) => {
    const response = await postSite(base, await revisedBody(base, "claim:reviewer#b1@2026-10-04T01:04:00.000Z", { decision: "overturned", note: "no evidence" }));

    assert.equal(response.status, 202);
    assert.deepEqual(ops.at(-1), { op: "ratify", verdict: "reviewer#b1@2026-10-04T01:04:00.000Z", decision: "overturned", note: "no evidence" });
    assert.deepEqual(steered, [{ target: "reviewer#b1", action: "reopen", value: "no evidence" }]);
  });
});

test("a written edit is visible on the next read", async () => {
  await withSite(async (base) => {
    assert.equal((await postSite(base, await revisedBody(base, "param:maxContinuations", { value: "7" }))).status, 202);

    const site = await (await fetch(`${base}/api/site`)).json();
    const param = site.objects.find((object: { id: string }) => object.id === "param:maxContinuations");
    assert.equal(param.value, "7");
    assert.deepEqual(param.tags, ["count", "custom"]);
  });
});

test("a write that is not the emitter's is refused, and nothing lands", async () => {
  await withSite(async (base, ops) => {
    assert.equal((await postSite(base, {})).status, 400);
    assert.equal((await postSite(base, { objects: {} })).status, 400);
    // no edit accepts a repo record
    assert.equal((await postSite(base, { objects: [{ id: "rac6ec850", sort: "repo", tags: ["alpha"] }] })).status, 400);
    // unknown record
    assert.equal((await postSite(base, { objects: [{ id: "claim:ghost@nowhere", sort: "claim" }] })).status, 404);
    // the field model is stringly
    assert.equal((await postSite(base, { objects: [{ id: "param:maxContinuations", sort: "param", value: 7 }] })).status, 400);
    // the loop checks each param's own bounds
    assert.equal((await postSite(base, await revisedBody(base, "param:maxContinuations", { value: "500" }))).status, 400);
    // claimed is the loop's own write, never an operator edit
    assert.equal((await postSite(base, await revisedBody(base, "queued_goal:q1", { status: "claimed" }))).status, 400);
    // malformed json
    assert.equal((await postSite(base, "{ not json")).status, 400);
    // an unchanged record is a no-op, not an error
    assert.equal((await postSite(base, await revisedBody(base, "param:reflect", { value: "1" }))).status, 202);
    assert.deepEqual(ops, []);
  });
});

test("site writes go through the same gates as the other writes", async () => {
  await withSite(async (base) => {
    const record = await revisedBody(base, "param:maxContinuations", { value: "7" });
    assert.equal((await postSite(base, record, { "content-type": "text/plain" })).status, 415);
    assert.equal((await fetch(`${base}/api/site`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(record) })).status, 405);
  });
  await withDashboard({ readProjection: () => TRACE_LINES }, async (base) => {
    // No policy writer wired: there is nowhere for an edit to land.
    assert.equal((await postSite(base, { objects: [] })).status, 403);
    assert.equal((await fetch(`${base}/api/site`)).status, 200);
  });
});
