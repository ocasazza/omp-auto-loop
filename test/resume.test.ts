// AC-1: cycle state survives a process restart (the cheap "lease").
// RED: replayCycle does not exist yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { replayCycle, type LoopEvent, type ResumedCycle } from "../extension/lib/resume.ts";

function ev(kind: LoopEvent["kind"], msg: string, ts: string): LoopEvent {
  return { ts, session: "repo#1", kind, msg };
}

test("empty log yields a fresh cycle", () => {
  const r = replayCycle([]);
  assert.equal(r.continuations, 0);
});

test("continuation events accumulate the budget", () => {
  const r = replayCycle([
    ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"),
    ev("continue", "autonomous continuation 2/3", "2026-01-01T00:01:00.000Z"),
  ]);
  assert.equal(r.continuations, 2);
});

test("the cycle start is the FIRST continuation of the current cycle", () => {
  const r = replayCycle([
    ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"),
    ev("continue", "autonomous continuation 2/3", "2026-01-01T00:05:00.000Z"),
  ]);
  assert.equal(r.cycleStartedAtMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("a settle ends the cycle and resets the budget", () => {
  const r = replayCycle([
    ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"),
    ev("continue", "autonomous continuation 2/3", "2026-01-01T00:01:00.000Z"),
    ev("settled", "settled: claimed_unverified", "2026-01-01T00:02:00.000Z"),
  ]);
  assert.equal(r.continuations, 0);
  assert.equal(r.cycleStartedAtMs, Date.parse("2026-01-01T00:02:00.000Z"));
});

test("only the trailing cycle survives an earlier reset", () => {
  const r = replayCycle([
    ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"),
    ev("settled", "settled: cycle_timeout", "2026-01-01T00:01:00.000Z"),
    ev("continue", "autonomous continuation 1/3", "2026-01-01T00:02:00.000Z"),
  ]);
  assert.equal(r.continuations, 1);
  assert.equal(r.cycleStartedAtMs, Date.parse("2026-01-01T00:02:00.000Z"));
});

test("events from another session are ignored", () => {
  const r = replayCycle(
    [
      { ...ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"), session: "other#9" },
      ev("continue", "autonomous continuation 1/3", "2026-01-01T00:01:00.000Z"),
    ],
    { session: "repo#1" },
  );
  assert.equal(r.continuations, 1);
});

test("an event with an unusable timestamp still counts as spent budget", () => {
  // A missing/garbled timestamp means we cannot place the event in time, not
  // that the continuation did not happen: counting it is the conservative
  // choice (less remaining budget, never more).
  const r = replayCycle(
    [
      ev("continue", "autonomous continuation 1/3", "2026-01-01T00:00:00.000Z"),
      { ...ev("continue", "autonomous continuation 2/3", "2026-01-01T00:01:00.000Z"), ts: "not-a-date" },
    ],
    { session: "repo#1" },
  );
  assert.equal(r.continuations, 2);
  assert.equal(r.cycleStartedAtMs, Date.parse("2026-01-01T00:00:00.000Z"), "the first usable timestamp still anchors the cycle");
});

test("replay never exceeds the continuations present in the log", () => {
  const rows: LoopEvent[] = Array.from({ length: 37 }, (_, i) =>
    ev("continue", `autonomous continuation ${i + 1}/3`, "2026-01-01T00:00:00.000Z"),
  );
  const r: ResumedCycle = replayCycle(rows);
  assert.ok(r.continuations <= rows.length);
  assert.equal(r.continuations, 37);
});

// Pre-`kind` logs carry no event class, so replay classifies by message -- and
// must classify exactly as the graph projection does. The two copies had
// diverged: resume.ts matched includes("gate") before startsWith("settled"),
// so a settle whose reason named a gate read as a gate event and the budget
// was never reset.
test("a settle with no recorded kind resets the budget, gate in the reason included", () => {
  const r = replayCycle([
    { ts: "2026-01-01T00:00:00.000Z", session: "repo#1", msg: "autonomous continuation 1/3" },
    { ts: "2026-01-01T00:01:00.000Z", session: "repo#1", msg: "autonomous continuation 2/3" },
    { ts: "2026-01-01T00:02:00.000Z", session: "repo#1", msg: "settled: gate_retries_exhausted" },
  ]);
  assert.equal(r.continuations, 0);
  assert.equal(r.cycleStartedAtMs, Date.parse("2026-01-01T00:02:00.000Z"));
});
