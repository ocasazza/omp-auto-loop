// AC: session_start replays persisted state through ctx.sessionManager.
//
// pi.readEntries never existed in the runtime; the first cut of the replay
// handler threw "pi.readEntries is not a function" on every interactive
// session, silently disabling override/goal restore. The handler must read
// custom entries from the ctx's session log, and must degrade to a no-op
// when the ctx carries no sessionManager (one-shot -p runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import factory from "../extension/auto-loop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Entry = { type: string; customType?: string; data?: unknown };

function makePi(handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown>) {
  return {
    hasUI: false,
    on: (ev: string, fn: (event?: unknown, ctx?: unknown) => unknown) => {
      handlers[ev] = fn;
    },
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerTool: () => {},
    registerCommand: () => {},
  };
}

test("session_start replays config and goal from sessionManager.getBranch", async () => {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  const entries: Entry[] = [
    { type: "message" },
    { type: "custom", customType: "auto_loop_config", data: { overrides: { maxContinuations: 9 }, disabled: true, paused: false } },
    { type: "custom", customType: "unrelated", data: { disabled: true } },
    { type: "custom", customType: "auto_loop_goal", data: { status: "active", objective: "test-goal" } },
  ];

  factory(makePi(handlers));
  assert.ok(handlers.session_start, "session_start handler registered");

  // With disabled:true replayed, the handler must take the early-exit branch
  // instead of scheduling anything — and must not throw.
  await handlers.session_start({}, { sessionManager: { getBranch: () => entries } });
});

test("session_start replays goal-only sessions", async () => {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  factory(makePi(handlers));
  const goalOnly: Entry[] = [
    { type: "custom", customType: "auto_loop_goal", data: { status: "active", objective: "g" } },
  ];
  await handlers.session_start({}, { sessionManager: { getBranch: () => goalOnly } });
  assert.ok(true, "goal-only replay completes without config entries");
});

test("session_start is a no-op when ctx has no sessionManager", async () => {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  factory(makePi(handlers));
  await handlers.session_start({}, {});
  await handlers.session_start({}, undefined);
  assert.ok(true, "missing sessionManager degrades to a no-op");
});

test("session_start ignores custom entries of other types", async () => {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  const notes: string[] = [];
  const pi = makePi(handlers);
  pi.sendUserMessage = (m: string) => { notes.push(m); };

  const entries: Entry[] = [
    { type: "custom", customType: "unrelated", data: { disabled: true, paused: true } },
  ];
  factory(pi);
  await handlers.session_start({}, { sessionManager: { getBranch: () => entries } });

  // The unrelated entry's disabled:true must NOT flip loopState; only
  // auto_loop_config entries may.
  assert.deepEqual(notes, [], "foreign customType must not disable the loop");
});
