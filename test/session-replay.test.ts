// AC: session_start replays persisted state through ctx.sessionManager.
//
// pi.readEntries never existed in the runtime; the first cut of the replay
// handler threw "pi.readEntries is not a function" on every interactive
// session, silently disabling override/goal restore. The handler must read
// custom entries from the ctx's session log, and must degrade to a no-op
// when the ctx carries no sessionManager (one-shot -p runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { encodeCommand } from "../extension/lib/control.ts";
import { encodeOp } from "../extension/lib/policy.ts";

// The factory writes the event log, the graph and binds the dashboard, and the
// module reads config.json at import. Point both at a private dir first, or a
// test run writes phantom sessions into the operator's live log and can take
// a real port.
const isolated = mkdtempSync(join(tmpdir(), "auto-loop-replay-"));
mkdirSync(join(isolated, "config", "omp-auto-loop"), { recursive: true });
writeFileSync(join(isolated, "config", "omp-auto-loop", "config.json"), '{"version":1,"dashboardPort":0}');
process.env.XDG_CONFIG_HOME = join(isolated, "config");
process.env.OMP_AUTO_LOOP_STATUS_FILE = join(isolated, "state", "events.jsonl");
// No model: the judge and reflect pass stay off, so a test never makes a network call.
delete process.env.OMP_AUTO_LOOP_JUDGE_MODEL;
const stateDir = join(isolated, "state");
mkdirSync(stateDir, { recursive: true });

// Dynamic: config.json is read at module load, so the env above must be set first.
const { default: factory } = await import("../extension/auto-loop.ts");

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

// --- policy and steering reach the running session -------------------------

type Tool = { execute: (id: string, params: { action: string; objective?: string }) => Promise<unknown> };

function liveSession() {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  const said: string[] = [];
  const sent: string[] = [];
  let tool: Tool | undefined;
  let onSaid: ((m: string) => void) | undefined;
  const pi = {
    ...makePi(handlers),
    sendUserMessage: (m: string) => {
      said.push(m);
      onSaid?.(m);
    },
    sendMessage: (m: string) => sent.push(m),
    registerTool: (t: Tool) => {
      tool = t;
    },
  };
  factory(pi);
  /** Resolves with the first agent message matching `pattern`. */
  const heard = (pattern: RegExp): Promise<string> => {
    const { promise, resolve } = Promise.withResolvers<string>();
    onSaid = (m) => {
      if (pattern.test(m)) resolve(m);
    };
    return promise;
  };
  return { handlers, said, sent, heard, goal: () => tool! };
}

const policy = (...ops: Parameters<typeof encodeOp>[0][]) =>
  appendFileSync(join(stateDir, "policy.jsonl"), ops.map((op) => encodeOp(op, Date.now(), "test")).join(""));

test("guidance addressed to the dashboard's label for a session reaches its agent", async () => {
  const { heard } = liveSession();
  // With no session id yet the key falls back to `p<pid>`; the graph label the
  // dashboard sends to is `<cwd basename>#<first 8 of the key>`.
  const graphLabel = `${basename(process.cwd())}#${`p${process.pid}`.slice(0, 8)}`;
  const guidance = heard(/^\[operator guidance\]/);
  appendFileSync(
    join(stateDir, "control.jsonl"),
    encodeCommand({ at: Date.now() + 1, target: graphLabel, action: "guide", value: "run the gate first" }),
  );
  // Real time: the extension polls the control file every 2s by design, and
  // the test awaits the delivery itself rather than a guessed delay.
  assert.equal(await guidance, "[operator guidance] run the gate first");
});

test("a continuation sends the directive as edited on the dashboard", async () => {
  policy({ op: "prompt", key: "continuation", text: "Keep going; prove each claim with command output." });
  const { handlers, sent, goal } = liveSession();
  await goal().execute("t1", { action: "set", objective: "fix the thing" });
  await handlers.session_stop({ messages: [{ role: "assistant", content: "still working" }] }, { hasUI: true, cwd: isolated });
  assert.deepEqual(sent, ["Keep going; prove each claim with command output."]);
});

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("gates set on the dashboard make verified_complete reachable", { skip: !hasGit && "needs git for worktree attestation" }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "gated-repo-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  policy({ op: "gates", repo: basename(repo), commands: ["true"] });

  const { handlers, goal } = liveSession();
  await goal().execute("t1", { action: "set", objective: "ship it" });
  await goal().execute("t2", { action: "complete" });
  await handlers.session_stop({ messages: [{ role: "assistant", content: "done" }] }, { hasUI: true, cwd: repo });

  // The sink appends asynchronously and exposes no promise, so the outcome is
  // observed where an operator would see it: the event log.
  const log = join(stateDir, "events.jsonl");
  const settled = () => existsSync(log) && readFileSync(log, "utf8").includes("settled: verified_complete");
  for (let i = 0; i < 100 && !settled(); i++) await Bun.sleep(20);
  assert.ok(settled(), readFileSync(log, "utf8"));
});
