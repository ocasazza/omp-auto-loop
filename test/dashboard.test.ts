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

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
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
