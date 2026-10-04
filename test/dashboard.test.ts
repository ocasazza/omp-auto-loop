// The dashboard's two halves: projection → panels, and panels → HTML.
// Both are pure, so none of this needs a socket, a filesystem, or a runtime.
//
// The escaping tests are the ones that matter most: every string on this page
// comes from model-written text — a goal objective, an event message, a cwd —
// and a page that renders those unescaped is an injection surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { controlView, parseProjection, renderDashboard, humanise, escapeHtml, taxonomyReport } from "../extension/lib/dashboard.ts";
import { encodeOp, foldPolicy, type PolicyOp } from "../extension/lib/policy.ts";

const session = (over: Record<string, string> = {}) => {
  const tags = over.tags ?? "active-goal,main";
  const props = over.props ?? "cwd=/ws/jaeger;continuations=2;max_continuations=3;heartbeats=1;model=pool:qwen";
  return `N|sk1|jaeger#1|session|${tags}|${props}|${over.body ?? "ship the cleanup"}`;
};

const event = (ts: string, kind: string, msg: string) =>
  JSON.stringify({ ts, session: "jaeger#1", kind, msg });

test("sessions and events are split by node kind", () => {
  const state = parseProjection(session(), event("2026-01-01T00:00:10Z", "continue", "autonomous continuation 1/3"));

  assert.equal(state.sessions.length, 1);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.sessions[0].label, "jaeger#1");
  assert.equal(state.sessions[0].model, "pool:qwen");
});

test("an active goal is working, anything else is idle", () => {
  const working = parseProjection(session());
  const idle = parseProjection(session({ tags: "no-goal,main", body: "" }));

  assert.equal(working.sessions[0].activeGoal, true);
  assert.equal(working.sessions[0].status, "working");
  assert.equal(idle.sessions[0].activeGoal, false);
  assert.equal(idle.sessions[0].status, "idle");
});

test("continuations and heartsbeat counts are numbers, not strings", () => {
  const s = parseProjection(session()).sessions[0];
  assert.equal(s.continuations, 2);
  assert.equal(s.maxContinuations, 3);
  assert.equal(s.heartbeats, 1);
});

test("a malformed line costs a row, never the page", () => {
  const state = parseProjection(["N|", "N|||", "garbage", "E|a|b", session()].join("\n"));

  assert.equal(state.sessions.length, 1);
});

test("events read newest first", () => {
  const state = parseProjection(
    "",
    [
      event("2026-01-01T00:00:10Z", "continue", "first"),
      event("2026-01-01T00:00:30Z", "settled", "third"),
      event("2026-01-01T00:00:20Z", "goal", "second"),
    ].join("\n"),
  );

  assert.deepEqual(
    state.decisions.map((d) => d.message),
    ["third", "second", "first"],
  );
});

test("working sessions sort above idle ones", () => {
  const state = parseProjection(
    [
      session({ tags: "no-goal,main", body: "" }),
      "N|sz2|zzz#2|session|active-goal,main|cwd=/x|a goal",
    ].join("\n"),
  );

  assert.equal(state.sessions[0].label, "zzz#2");
});

test("a settle reads as a sentence, not a log token", () => {
  const said = humanise({ ts: "", session: "", kind: "settled", message: "settled: claimed_unverified" });
  assert.match(said, /claimed done/);
  assert.doesNotMatch(said, /claimed_unverified/);

  const judged = humanise({ ts: "", session: "", kind: "settled", message: "settled: judged_complete" });
  assert.match(judged, /judge corroborated/);
});

test("an unknown settle reason still reads as a sentence", () => {
  const said = humanise({ ts: "", session: "", kind: "settled", message: "settled: some_new_reason" });
  assert.equal(said, "stopped — some new reason");
});

test("a verdict is named, not echoed as a token", () => {
  const said = humanise({ ts: "", session: "", kind: "other", message: "judge verdict: UNVERIFIED" });
  assert.equal(said, "judge: unverified");
});

test("model text cannot inject markup", () => {
  const state = parseProjection(
    session({ body: '<img src=x onerror="alert(1)">' }),
  );
  const html = renderDashboard(state);

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("an event message cannot inject markup", () => {
  const state = parseProjection("", event("2026-01-01T00:00:10Z", "goal", "<script>alert(1)</script>"));
  const html = renderDashboard(state);

  // The page has a script of its own, and the escaped text necessarily still
  // contains the word "alert(1)". What must not survive is the executable
  // form: a literal opening tag followed by the payload.
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("a quote in a label cannot break out of an attribute", () => {
  assert.equal(escapeHtml(`" onmouseover="x`), "&quot; onmouseover=&quot;x");
});

test("an empty projection renders an empty page, not an error", () => {
  const html = renderDashboard(parseProjection(""));

  assert.match(html, /0<\/b> sessions/);
  assert.match(html, /no sessions recorded yet/);
  assert.match(html, /no events recorded yet/);
});

test("the page states what is actually running", () => {
  const html = renderDashboard(parseProjection(session()));

  assert.match(html, /jaeger#1/);
  assert.match(html, /2\/3/);
  assert.match(html, /ship the cleanup/);
  assert.match(html, /1<\/b> working/);
});

test("a taken port reports and does not throw", async () => {
  // `listen` fails asynchronously: a try/catch around the call catches
  // nothing, and an unhandled 'error' event takes the process down — the loop
  // would die because its dashboard could not have a port.
  const http = await import("node:http");
  const blocker = http.createServer(() => {});
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const port = (blocker.address() as { port: number }).port;

  const { createDashboard } = await import("../extension/lib/dashboard.ts");
  let reported = "";
  const dashboard = createDashboard({
    port,
    readProjection: () => "",
    onError: (message: string) => {
      reported = message;
    },
  });

  // Give the async error event a turn to arrive.
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.match(reported, /in use|EADDRINUSE/i);
  dashboard.close();
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

// --- the self-improvement signal -----------------------------------------

test("the verdict mix separates claims from evidence", () => {
  const state = parseProjection(
    "",
    [
      event("2026-01-01T00:00:01Z", "settled", "settled: claimed_unverified"),
      event("2026-01-01T00:00:02Z", "settled", "settled: claimed_unverified"),
      event("2026-01-01T00:00:03Z", "settled", "settled: judged_complete"),
      event("2026-01-01T00:00:04Z", "settled", "settled: judge_unavailable"),
    ].join("\n"),
  );

  // Ties are broken by name, so the strip does not reorder between refreshes.
  assert.deepEqual(state.verdicts, [
    { reason: "claimed_unverified", count: 2 },
    { reason: "judge_unavailable", count: 1 },
    { reason: "judged_complete", count: 1 },
  ]);
});

test("a non-settle event is not a verdict", () => {
  const state = parseProjection("", event("2026-01-01T00:00:01Z", "continue", "autonomous continuation 1/3"));
  assert.deepEqual(state.verdicts, []);
});

test("the rate is windowed, so a pre-judge history cannot read as a broken judge", () => {
  const old = event("2020-01-01T00:00:01Z", "settled", "settled: claimed_unverified");
  const fresh = event(new Date().toISOString(), "settled", "settled: judged_complete");

  const state = parseProjection("", [old, fresh].join("\n"));

  // All time carries both, and is dragged down by the one from before a judge
  // existed: 50%, which says nothing about the judge working today.
  assert.deepEqual(state.verdicts, [
    { reason: "claimed_unverified", count: 1 },
    { reason: "judged_complete", count: 1 },
  ]);

  // The recent window is what says whether the judge works now.
  assert.equal(state.recent.windowHours, 24);
  assert.deepEqual(state.recent.verdicts, [{ reason: "judged_complete", count: 1 }]);
});

test("the page states both windows", () => {
  const state = parseProjection(
    "",
    [
      event("2020-01-01T00:00:01Z", "settled", "settled: claimed_unverified"),
      event(new Date().toISOString(), "settled", "settled: judged_complete"),
    ].join("\n"),
  );
  const html = renderDashboard(state);

  assert.match(html, /corroborated <b>100%<\/b> in 24h/);
  assert.match(html, /all time/);
  assert.match(html, /last 24h/);
});

test("the page states the corroboration rate", () => {
  const now = Date.now();
  const state = parseProjection(
    "",
    [
      event(new Date(now - 60_000).toISOString(), "settled", "settled: judged_complete"),
      event(new Date(now - 120_000).toISOString(), "settled", "settled: claimed_unverified"),
    ].join("\n"),
  );
  const html = renderDashboard(state);

  assert.match(html, /corroborated <b>50%<\/b> in 24h/);
  assert.match(html, /how claims settled/);
});

test("no settles means no rate rather than a zero", () => {
  const html = renderDashboard(parseProjection(session()));
  assert.doesNotMatch(html, /claims corroborated/);
});

// --- steering ------------------------------------------------------------

const withDashboard = async (
  options: {
    steer?: (c: { target: string; action: string; value?: string }) => void;
    readEvents?: () => string;
    readPolicy?: () => string;
    writePolicy?: (op: PolicyOp) => void;
  },
  run: (base: string) => Promise<void>,
) => {
  const http = await import("node:http");
  const probe = http.createServer(() => {});
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const { createDashboard } = await import("../extension/lib/dashboard.ts");
  const dashboard = createDashboard({ port, readProjection: () => "", ...options });
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    dashboard.close();
  }
};

const post = (base: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${base}/api/action`, { method: "POST", headers, body: JSON.stringify(body) });

test("steering applies the action it was given", async () => {
  const seen: unknown[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    const response = await post(base, { target: "s1", action: "pause" });

    assert.equal(response.status, 202);
    assert.deepEqual(seen, [{ target: "s1", action: "pause", value: undefined }]);
  });
});

test("a GET cannot steer: an <img> on any page would otherwise be enough", async () => {
  const seen: unknown[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    const response = await fetch(`${base}/api/action`);

    assert.equal(response.status, 405);
    assert.deepEqual(seen, []);
  });
});

test("a form-encoded POST cannot steer", async () => {
  const seen: unknown[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    const response = await post(base, { action: "pause" }, { "content-type": "application/x-www-form-urlencoded" });

    assert.equal(response.status, 415);
    assert.deepEqual(seen, []);
  });
});

test("an unknown action is refused, not ignored", async () => {
  const seen: unknown[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    const response = await post(base, { target: "s1", action: "rm -rf /" });

    assert.equal(response.status, 400);
    assert.deepEqual(seen, []);
  });
});

test("a goal with no objective is refused", async () => {
  const seen: unknown[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    assert.equal((await post(base, { target: "s1", action: "goal" })).status, 400);
    assert.equal((await post(base, { target: "s1", action: "goal", value: "   " })).status, 400);

    assert.deepEqual(seen, []);
  });
});

test("an unspecified target steers every session", async () => {
  const seen: { target: string }[] = [];
  await withDashboard({ steer: (c) => seen.push(c) }, async (base) => {
    await post(base, { action: "pause" });

    assert.equal(seen[0].target, "*");
  });
});

test("with no steer sink the route refuses rather than pretending", async () => {
  await withDashboard({}, async (base) => {
    assert.equal((await post(base, { action: "pause" })).status, 403);
  });
});

// Taxonomy management, read half: what the loop says it classifies by, against
// what the log shows it has actually produced.

test("taxonomy counts classes, and a recorded kind wins over the message", () => {
  const report = taxonomyReport(
    [
      event("2026-01-01T00:00:00Z", "continue", "autonomous continuation 1/3"),
      // The recorded class disagrees with the message; the record is authoritative.
      event("2026-01-01T00:01:00Z", "heartbeat", "goal set: x"),
      // A log predating the field: classified from the message.
      JSON.stringify({ ts: "2026-01-01T00:02:00Z", session: "jaeger#1", msg: "settled: cycle_timeout" }),
    ].join("\n"),
  );
  const counts = new Map(report.eventClasses.map((term) => [term.id, term.count]));

  assert.equal(counts.get("continue"), 1);
  assert.equal(counts.get("heartbeat"), 1);
  assert.equal(counts.get("settled"), 1);
  assert.equal(counts.get("goal"), 0);
});

test("a settle reason the union does not name is reported, never dropped", () => {
  const report = taxonomyReport(event("2026-01-01T00:00:00Z", "settled", "settled: turn ended error"));

  assert.deepEqual(report.settleUnmatched, [{ reason: "turn ended error", count: 1 }]);
  assert.equal(report.settleReasons.find((term) => term.id === "cycle_timeout")?.count, 0);
});

test("the taxonomy route serves the declared vocabularies", async () => {
  const events = event("2026-01-01T00:00:00Z", "settled", "settled: judged_complete");
  await withDashboard({ readEvents: () => events }, async (base) => {
    const response = await fetch(`${base}/api/taxonomy`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.settleReasons.find((t: { id: string }) => t.id === "judged_complete").count, 1);
    assert.equal(body.eventClasses.find((t: { id: string }) => t.id === "settled").count, 1);
    assert.deepEqual(
      body.decisionKinds.map((t: { id: string }) => t.id),
      ["continue", "settle", "verify", "no-op"],
    );
  });
});

// --- control surface -------------------------------------------------------

const postTo = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A dashboard over an in-memory policy log, so a write is visible to the next read. */
const withPolicy = async (
  initial: PolicyOp[],
  run: (base: string, ops: PolicyOp[], steered: { target: string; action: string; value?: string }[]) => Promise<void>,
) => {
  const ops = [...initial];
  const steered: { target: string; action: string; value?: string }[] = [];
  await withDashboard(
    {
      readPolicy: () => ops.map((op, i) => encodeOp(op, i + 1, "t")).join(""),
      writePolicy: (op) => ops.push(op),
      steer: (c) => steered.push(c),
    },
    (base) => run(base, ops, steered),
  );
};

test("a policy write is validated before it reaches the log", async () => {
  await withPolicy([], async (base, ops) => {
    assert.equal((await postTo(base, "/api/policy", { op: "param", key: "maxContinuations", value: 500 })).status, 400);
    assert.equal((await postTo(base, "/api/policy", { op: "param", key: "maxContinuations", value: 5 })).status, 202);
    assert.deepEqual(ops, [{ op: "param", key: "maxContinuations", value: 5 }]);
  });
});

test("a policy write by GET or form post is refused", async () => {
  await withPolicy([], async (base, ops) => {
    assert.equal((await fetch(`${base}/api/policy?op=param`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "op=param" })).status, 415);
    assert.equal((await fetch(`${base}/api/reflect`)).status, 405);
    assert.deepEqual(ops, []);
  });
});

test("overturning a done claim records it and sends the session back to work", async () => {
  await withPolicy([], async (base, ops, steered) => {
    const verdict = "repo#4242@2026-01-01T00:00:04Z";
    const response = await postTo(base, "/api/policy", { op: "ratify", verdict, decision: "overturned", note: "no evidence" });
    assert.equal(response.status, 202);
    assert.equal(ops[0]?.op, "ratify");
    assert.deepEqual(steered, [{ target: "repo#4242", action: "reopen", value: "no evidence" }]);
  });
});

test("accepting a done claim does not steer anything", async () => {
  await withPolicy([], async (base, _ops, steered) => {
    await postTo(base, "/api/policy", { op: "ratify", verdict: "repo#1@2026-01-01T00:00:04Z", decision: "accepted" });
    assert.deepEqual(steered, []);
  });
});

test("dispatching a queued goal claims it and hands the objective to that session", async () => {
  await withPolicy([{ op: "queue.add", id: "q1", objective: "audit citations", priority: 1 }], async (base, ops, steered) => {
    assert.equal((await postTo(base, "/api/policy", { op: "queue.dispatch", id: "q1", target: "repo#01a0" })).status, 202);
    assert.deepEqual(ops.at(-1), { op: "queue.claim", id: "q1", session: "repo#01a0" });
    assert.deepEqual(steered, [{ target: "repo#01a0", action: "goal", value: "audit citations" }]);
    // Claimed now, so a second dispatch has nothing to send.
    assert.equal((await postTo(base, "/api/policy", { op: "queue.dispatch", id: "q1", target: "repo#02b0" })).status, 404);
  });
});

test("a sentence saved as a gate moves to the repo's done criteria", async () => {
  const line = "Push all changes to a PR and make sure all checks are passing.";
  await withPolicy([{ op: "gates", repo: "brane", commands: ["bun test", line] }], async (base, ops) => {
    assert.equal((await postTo(base, "/api/policy", { op: "gate.toCriteria", repo: "brane", line })).status, 202);
    const policy = foldPolicy(ops.map((op, i) => encodeOp(op, i + 1, "t")).join(""));
    assert.deepEqual(policy.gates.brane, ["bun test"]);
    assert.equal(policy.criteria.brane, line);
  });
});

test("a hidden event class leaves the feed but not the log", () => {
  const events = [
    event("2026-01-01T00:00:01Z", "other", "dashboard unavailable: port in use"),
    event("2026-01-01T00:00:02Z", "goal", "goal set: real work"),
  ].join("\n");
  const state = parseProjection("", events);
  const policy = foldPolicy(
    [
      encodeOp({ op: "term.add", vocab: "event", id: "noise", label: "Noise", description: "" }, 1, "t"),
      encodeOp({ op: "rule", prefix: "dashboard unavailable:", cls: "noise" }, 2, "t"),
      encodeOp({ op: "term", vocab: "event", id: "noise", hidden: true }, 3, "t"),
    ].join(""),
  );
  const html = renderDashboard(state, controlView(state, policy, { maxContinuations: 3, timeoutMs: 1_800_000 }, false));
  assert.doesNotMatch(html, /port in use/);
  assert.match(html, /real work/);
  assert.match(html, /1 event hidden by taxonomy settings/);
  assert.match(html, /2<\/b> events/);
});

test("the folded policy is readable, and a read changes nothing", async () => {
  await withPolicy([{ op: "criteria", repo: "brane", text: "pushed and green" }], async (base, ops) => {
    const response = await fetch(`${base}/api/policy`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).criteria, { brane: "pushed and green" });
    assert.equal(ops.length, 1);
  });
});
