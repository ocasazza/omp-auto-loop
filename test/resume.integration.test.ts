// AC-1 integration: a REAL events.jsonl written by a real run is replayed
// through the REAL FsPort adapter, including a truncated tail line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCycle, type LoopEvent } from "../extension/lib/resume.ts";
import { ObservationSink, createGraphProjection, type SessionState } from "../extension/lib/observation.ts";
import type { FsPort } from "../extension/lib/ports.ts";

// Replay reads only the event log; the hub state is incidental here.
const IDLE: SessionState = {
  key: "k",
  label: "repo",
  cwd: "/repo",
  agent: "main",
  parentKey: null,
  repo: null,
  goal: null,
  gates: [],
  model: null,
  continuations: 0,
  maxContinuations: 3,
  heartbeats: 0,
  outcome: null,
};

function realFs(): FsPort {
  return {
    appendFile: async (p, d) => {
      appendFileSync(p, d);
    },
    writeFile: async (p, d) => {
      writeFileSync(p, d);
    },
    readFile: async (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    mkdirp: async (p) => {
      mkdirSync(p, { recursive: true });
    },
    unlink: async (p) => {
      rmSync(p, { force: true });
    },
    createExclusive: async (path) => {
      try {
        writeFileSync(path, String(process.pid), { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    rename: async (from, to) => {
      renameSync(from, to);
    },
    stat: async (p) => {
      try {
        const s = statSync(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
  };
}

function readEvents(path: string): LoopEvent[] {
  const text = readFileSync(path, "utf8");
  const rows: LoopEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as LoopEvent);
    } catch {
      // A truncated final line: dropped at the adapter boundary.
    }
  }
  return rows;
}

test("a real prior run's log reconstructs the budget it had spent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloop-resume-"));
  const events = join(dir, "events.jsonl");
  const fs = realFs();

  // A real sink writes the log.
  const sink = new ObservationSink(
    fs,
    { stateDir: dir, sessionLabel: "repo#7", maxGraphLines: 1000 },
    createGraphProjection(),
    Date.parse("2026-01-01T00:00:00.000Z"),
  );
  sink.emit("autonomous continuation 1/3", Date.parse("2026-01-01T00:00:00.000Z"), IDLE);
  sink.emit("autonomous continuation 2/3", Date.parse("2026-01-01T00:10:00.000Z"), IDLE);
  await sink.drain();

  const replayed = replayCycle(readEvents(events), { session: "repo#7" });
  assert.equal(replayed.continuations, 2, "the new process resumes the budget its predecessor spent");
  assert.equal(replayed.cycleStartedAtMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("a crash mid-write (truncated tail) still resumes the intact prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloop-trunc-"));
  const events = join(dir, "events.jsonl");
  const fs = realFs();
  const sink = new ObservationSink(
    fs,
    { stateDir: dir, sessionLabel: "repo#8", maxGraphLines: 1000 },
    createGraphProjection(),
    Date.parse("2026-02-01T00:00:00.000Z"),
  );
  sink.emit("autonomous continuation 1/3", Date.parse("2026-02-01T00:00:00.000Z"), IDLE);
  await sink.drain();
  // Simulate the process dying mid-append.
  appendFileSync(events, '{"ts":"2026-02-01T00:01:00.000Z","session":"repo#8","ki');

  const replayed = replayCycle(readEvents(events), { session: "repo#8" });
  assert.equal(replayed.continuations, 1, "the truncated line is dropped, the prefix survives");
});

test("a settled run resumes with a full budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloop-settled-"));
  const events = join(dir, "events.jsonl");
  const fs = realFs();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    events,
    [
      '{"ts":"2026-03-01T00:00:00.000Z","session":"repo#9","kind":"continue","msg":"autonomous continuation 1/3"}',
      '{"ts":"2026-03-01T00:01:00.000Z","session":"repo#9","kind":"settled","msg":"settled: claimed_unverified"}',
      '{"ts":"2026-03-01T00:02:00.000Z","session":"repo#9","kind":"continue","msg":"autonomous continuation 1/3"}',
    ].join("\n") + "\n",
  );
  const replayed = replayCycle(readEvents(events), { session: "repo#9" });
  assert.equal(replayed.continuations, 1);
  assert.equal(replayed.cycleStartedAtMs, Date.parse("2026-03-01T00:02:00.000Z"));
});

test("the sink stamps each event with its kind so replay need not guess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloop-kind-"));
  const events = join(dir, "events.jsonl");
  const sink = new ObservationSink(
    realFs(),
    { stateDir: dir, sessionLabel: "repo#10", maxGraphLines: 1000 },
    createGraphProjection(),
    Date.parse("2026-04-01T00:00:00.000Z"),
  );
  sink.emit("autonomous continuation 1/3", Date.parse("2026-04-01T00:00:00.000Z"), IDLE);
  await sink.drain();
  const row = JSON.parse(readFileSync(events, "utf8").split("\n")[0] ?? "{}");
  assert.equal(row.kind, "continue", "the event carries a machine-readable class");
  // Replay classifies from `kind`, not from the message text.
  assert.equal(replayCycle([row], { session: "repo#10" }).continuations, 1);
});

test("concurrent writers sharing graph.lines never lose each other's events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloop-race-"));
  const fs = realFs();
  const sinks = [1, 2, 3].map(
    (n) =>
      new ObservationSink(
        fs,
        { stateDir: dir, sessionLabel: `repo#${n}`, maxGraphLines: 10_000 },
        createGraphProjection(),
        0,
      ),
  );
  for (let i = 1; i <= 20; i++) {
    sinks.forEach((sink, n) => sink.emit(`autonomous continuation ${i}`, i, { ...IDLE, key: `k${n}` }));
  }
  await Promise.all(sinks.map((s) => s.drain()));
  const ids = readFileSync(join(dir, "graph.lines"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("N|e"))
    .map((l) => l.split("|")[1]);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
  assert.equal(ids.length, 60, "every writer's every event survives");
  rmSync(dir, { recursive: true, force: true });
});
