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
    limits?: () => { maxContinuations: number; timeoutMs: number };
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
      limits: () => ({ maxContinuations: 3, timeoutMs: 1_800_000 }),
    },
    async (base) => {
      const response = await fetch(`${base}/api/site`);

      assert.equal(response.status, 200);
      assert.ok((response.headers.get("content-type") ?? "").includes("application/json"));
      assert.deepEqual(await response.json(), CONTROL_FIXTURE);
    },
  );
});
