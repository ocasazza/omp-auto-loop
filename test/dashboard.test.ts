// The dashboard's two halves: projection → panels, and panels → HTML.
// Both are pure, so none of this needs a socket, a filesystem, or a runtime.
//
// The escaping tests are the ones that matter most: every string on this page
// comes from model-written text — a goal objective, an event message, a cwd —
// and a page that renders those unescaped is an injection surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProjection, renderDashboard, humanise, escapeHtml } from "../extension/lib/dashboard.ts";

const session = (over: Record<string, string> = {}) => {
  const tags = over.tags ?? "active-goal,main";
  const props = over.props ?? "cwd=/ws/jaeger;continuations=2;max_continuations=3;heartbeats=1;model=pool:qwen";
  return `N|sk1|jaeger#1|session|${tags}|${props}|${over.body ?? "ship the cleanup"}`;
};

const event = (ts: string, kind: string, msg: string) =>
  `N|e${ts}|${msg}|event|${kind}|ts=${ts};sess=jaeger#1`;

test("sessions and events are split by node kind", () => {
  const state = parseProjection([session(), event("2026-01-01T00:00:10Z", "continue", "autonomous continuation 1/3")].join("\n"));

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
  const state = parseProjection(event("2026-01-01T00:00:10Z", "goal", "<script>alert(1)</script>"));
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
  const state = parseProjection(event("2026-01-01T00:00:01Z", "continue", "autonomous continuation 1/3"));
  assert.deepEqual(state.verdicts, []);
});

test("the page states the corroboration rate", () => {
  const state = parseProjection(
    [
      event("2026-01-01T00:00:01Z", "settled", "settled: judged_complete"),
      event("2026-01-01T00:00:02Z", "settled", "settled: claimed_unverified"),
    ].join("\n"),
  );
  const html = renderDashboard(state);

  assert.match(html, /claims corroborated <b>50%<\/b> of 2/);
  assert.match(html, /how claims settled/);
});

test("no settles means no rate rather than a zero", () => {
  const html = renderDashboard(parseProjection(session()));
  assert.doesNotMatch(html, /claims corroborated/);
});

// --- steering ------------------------------------------------------------

const withDashboard = async (
  options: { steer?: (c: { target: string; action: string; value?: string }) => void },
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
