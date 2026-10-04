// omp-auto-loop — port of prime-agent's internal autonomous runtime to the
// pi/omp extension API. Upstream: PrimeIntellect-ai/prime-agent,
// packages/coding-agent/src/core/{autonomous.ts, goals.ts, cron-jobs.ts}
// (Apache-2.0). Earlier draft drew on DraconDev/opencode-auto-continue
// (AGPL-3.0) for the original settle gate; that lineage is retained for
// attribution.
//
// Ported internals:
//   - shouldAutonomouslyContinue (autonomous.ts:390): continuation is the
//     default; termination needs terminal evidence. Per-user-input cycle
//     budgets from DEFAULT_AUTONOMOUS_LIMITS: 3 continuations / 30 minutes
//     (OMP_AUTO_LOOP_MAX_CONTINUATIONS / OMP_AUTO_LOOP_TIMEOUT_MS).
//   - Quality gates (autonomous.ts:447): when gate commands are configured
//     (OMP_AUTO_LOOP_GATES, JSON array) they are the termination authority —
//     a settle stops only when every gate passes. A failed gate continues
//     the run with the gate's exit status and truncated output; a gate whose
//     worktree snapshot is unchanged since its last failure is NOT rerun
//     (autonomous.ts:459 no-progress detection) — the model is told to edit
//     something first. Retries cap at OMP_AUTO_LOOP_GATE_RETRIES (3), gate
//     timeout OMP_AUTO_LOOP_GATE_TIMEOUT_MS (5m).
//   - Goals (goals.ts): a model-driven `goal` tool (set / pause / resume /
//     complete / status) owning the thread goal state, persisted to the
//     session log via appendEntry — omp's stand-in for prime's kernel-side
//     goal skill.
//   - Heartbeat (cron-jobs.ts): while a goal is active, an idle-session
//     timer (OMP_AUTO_LOOP_HEARTBEAT_MS, default 10m, 0 disables) nudges the
//     session to check progress toward the goal.
//   - DEVIATION: prime terminates via verifier gates only; with no gates
//     configured, omp uses an AUTOLOOP:DONE marker in the reply as the
//     completion signal.
//
// omp's own auto-retry (agent_end willContinue) is never intercepted;
// approval/ask-blocked turns never settle, so they cannot be continued past.
// No slash command, no arming: the loop rides every session where the Nix
// module enables it, via the PI_CONFIG_FILES settings overlay.

import * as path from 'path';
import * as os from 'os';
import { readFileSync } from 'fs';
import { registerCommands } from './lib/commands'; // NEW import for commands
import { createDashboard, parseEvents, verdictMix } from './lib/dashboard.ts';
import { encodeCommand, selectCommands, type ControlCommand, type ControlAction } from './lib/control.ts';
import type { ExtensionCommandContext, AutocompleteItem } from '@oh-my-pi/pi-coding-agent';

import { type } from "@oh-my-pi/omptype";
import { exec as childExec } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";

import {
  shouldContinue,
  buildGateOutcome,
  goalPrefix as v2GoalPrefix,
  type Decision,
  type GateSetOutcome,
} from "./lib/core.ts";
import {
  buildJudgePrompt,
  extractEvidence,
  judgeFailureContext,
  parseJudgeVerdict,
} from "./lib/judge.ts";
import type { JudgePort, JudgeVerdict } from "./lib/ports.ts";
import {
  runGateSet,
  gateFailureContext,
  type GateAttempt,
} from "./lib/gates.ts";
import {
  ObservationSink,
  createGraphProjection,
  idPart,
  type RepoRef,
  type SessionState,
} from "./lib/observation.ts";
import { CanvasLifecycle } from "./lib/canvas.ts";
import type { FsPort } from "./lib/ports.ts";
import { replayCycle, type LoopEvent } from "./lib/resume.ts";
import {
  criteriaFor,
  encodeOp,
  flag,
  foldPolicy,
  gatesFor,
  nextQueued,
  promptText,
  EMPTY_POLICY,
  type Policy,
  type PolicyOp,
} from "./lib/policy.ts";
import { chatFromEnv } from "./lib/model.ts";
import { proposeImprovement } from "./lib/reflect.ts";

// XDG path resolution
export const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const XDG_STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
export const XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');

const AUTO_LOOP_CONFIG_DIR = path.join(XDG_CONFIG_HOME, 'omp-auto-loop');
export const AUTO_LOOP_CONFIG_FILE = path.join(AUTO_LOOP_CONFIG_DIR, 'config.json');

export let fileConfig: Partial<SessionConfig> = {};
try {
  const configContent = readFileSync(AUTO_LOOP_CONFIG_FILE, 'utf8');
  const parsedConfig = JSON.parse(configContent);
  if (parsedConfig.version === 1) {
    fileConfig.dashboardPort = parsedConfig.dashboardPort;
    if (typeof parsedConfig.graphApiPort === "number") fileConfig.graphApiPort = parsedConfig.graphApiPort;
  }
} catch (e: any) {
  console.error(`[auto-loop] Failed to read or parse config.json at ${AUTO_LOOP_CONFIG_FILE}: ${e.message}`);
}

// Gate defaults (the loop's own; session-config defaults live in ./lib/config).
export const DEFAULT_GATE_RETRIES = 3;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function envStringArray(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Last assistant message as a record (for stopReason checks), or null. */
function lastAssistantRecord(messages: unknown): Record<string, unknown> | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = record(messages[i]);
    if (msg && msg.role === "assistant") return msg;
  }
  return null;
}

/** The transcript as an array, for evidence extraction. */
function lastMessages(event: unknown): unknown[] {
  const messages = record(event)?.messages;
  return Array.isArray(messages) ? messages : [];
}

/** Concatenated text parts of the last assistant message, or "". */
function lastAssistantText(messages: unknown): string {
  const msg = lastAssistantRecord(messages);
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((part) => {
      const p = record(part);
      return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}


function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;
}

interface ShellResult {
  ok: boolean;
  exitText: string;
  output: string;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  const { promise, resolve } = Promise.withResolvers<ShellResult>();
  childExec(
    command,
    { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const out = [String(stdout ?? ""), String(stderr ?? "")]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (error && error.killed) {
        resolve({ ok: false, exitText: "timed out", output: truncate(out, 6000) });
        return;
      }
      if (error) {
        const code = (record(error) ?? {}).code;
        resolve({
          ok: false,
          exitText: `exited ${typeof code === "number" ? code : "?"}`,
          output: truncate(out, 6000),
        });
        return;
      }
      resolve({ ok: true, exitText: "exited 0", output: truncate(out, 6000) });
    },
  );
  return promise;
}

/** Port of captureGitWorktreeSnapshot (autonomous.ts:538): status + diff +
 * untracked list, hashed. Best-effort: non-repo or git failure → undefined. */
async function worktreeSnapshot(
  cwd: string,
  _deadlineMs = Number.POSITIVE_INFINITY,
): Promise<string | undefined> {
  const status = await runShell("git status --porcelain=v1 -unormal", cwd, 10_000);
  if (!status.ok) return undefined;
  const diff = await runShell("git diff HEAD", cwd, 10_000);
  const untracked = await runShell(
    "git ls-files --others --exclude-standard",
    cwd,
    10_000,
  );
  return createHash("sha256")
    .update(`${status.output}\u0000${diff.output}\u0000${untracked.output}`)
    .digest("hex");
}

const DONE_MARKER = "AUTOLOOP:DONE";

export interface GoalState {
  status: "idle" | "active" | "paused" | "complete";
  objective: string;
  goalId?: string;
  continuationsUsed: number;
  createdAt?: number;
  updatedAt?: number;
}
export const GoalParams = type({
  action: "'set'|'pause'|'resume'|'complete'|'status'",
  "objective?": "string<=4000",
});

export {
  type SessionConfig,
  DEFAULT_SESSION_CONFIG,
  type LoopActions,
  getEffectiveConfig,
} from "./lib/config.ts";

import { SESSION_OVERRIDES_KEY, DEFAULT_SESSION_CONFIG, getEffectiveConfig } from "./lib/config.ts";

type GoalAction = "set" | "pause" | "resume" | "complete" | "status";

// This function is now exported for testing purposes
export function sessionKey(lastCtx: Record<string, unknown> | null, record: (value: unknown) => Record<string, unknown> | null, idPart: (id: string) => string): string {
  const manager = record(lastCtx?.sessionManager);
  const getId = manager?.getSessionId;
  const id = typeof getId === "function" ? idPart(String(getId.call(manager) ?? "")) : "";
  return id || `p${process.pid}`;
}

export default function (pi: {
  on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof GoalParams;
    approval: "read";
    execute: (
      toolCallId: string,
      params: { action: GoalAction; objective?: string },
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
  }) => void;
  appendEntry: (customType: string, data: unknown) => void;
  sendUserMessage: (content: string) => void;
  hasUI: boolean; // From Pi interface
  registerCommand: (name: string, opts: {
    description: string;
    getArgumentCompletions?: (prefix: string, args: string) => Promise<AutocompleteItem[]>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void;
}): void {
  if (process.env.OMP_AUTO_LOOP_DISABLE === "1") return;

  // Session-specific overrides for configuration
  const sessionOverrides = ((globalThis as any)[SESSION_OVERRIDES_KEY] ??= new Map<string, Partial<SessionConfig>>()) as Map<string, Partial<SessionConfig>>;

  let loopState = {
    continuations: 0,
    cycleStart: Date.now(),
    scheduledContinuation: false,
    completionClaimed: false,
    goal: { status: "idle", objective: "", continuationsUsed: 0 } as GoalState,
    lastCtx: null as Record<string, unknown> | null, // This will be updated on each turn
    lastNudgeAt: Date.now(),
    disabled: DEFAULT_SESSION_CONFIG.disabled,
    paused: DEFAULT_SESSION_CONFIG.paused,
  };

  // Helper to update session overrides and persist
  const setOverride = (patch: Partial<SessionConfig> | null) => {
    const currentSessionId = sessionKey(loopState.lastCtx, record, idPart); // Use the exported sessionKey
    if (patch === null) {
      sessionOverrides.delete(currentSessionId);
    } else {
      sessionOverrides.set(currentSessionId, { ...sessionOverrides.get(currentSessionId), ...patch });
    }
    // Persist the combined auto_loop_config state
    pi.appendEntry("auto_loop_config", {
      overrides: sessionOverrides.get(currentSessionId),
      disabled: loopState.disabled, // Current disabled state
      paused: loopState.paused,     // Current paused state
    });
  };

  // Every note() lands in the event log (JSONL, one line per event) that
  // resumeFromLog replays, and in graph.lines, the projection the jump-cannon
  // canvas imports. Policy and control files sit beside it.
  const statusFile =
    process.env.OMP_AUTO_LOOP_STATUS_FILE ??
    `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? ""}/.local/state`}/omp-auto-loop/events.jsonl`;
  const stateDir = dirname(statusFile);
  const policyFile = `${stateDir}/policy.jsonl`;

  // The operator's policy, re-folded only when the file changes: the settle
  // path reads it on every decision and the log is append-only.
  let policyCache: { mtimeMs: number; size: number; policy: Policy } | undefined;
  const readPolicy = (): Policy => {
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(policyFile);
    } catch {
      return EMPTY_POLICY;
    }
    if (policyCache && policyCache.mtimeMs === st.mtimeMs && policyCache.size === st.size) return policyCache.policy;
    let text = "";
    try {
      text = readFileSync(policyFile, "utf8");
    } catch {
      return EMPTY_POLICY;
    }
    policyCache = { mtimeMs: st.mtimeMs, size: st.size, policy: foldPolicy(text) };
    return policyCache.policy;
  };
  // O_APPEND: one op, one write, so concurrent writers never interleave.
  const appendPolicy = (op: PolicyOp, by: string): void => {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(policyFile, encodeOp(op, Date.now(), by));
  };

  // Create a bound getEffectiveConfig for use within the extension
  const getEffective = getEffectiveConfig({
    piHasUI: pi.hasUI,
    fileConfig,
    sessionOverrides,
    envInt,
    envStringArray,
    DEFAULT_SESSION_CONFIG,
    livePolicy: () => {
      const { maxContinuations, timeoutMs } = readPolicy().params;
      return {
        ...(maxContinuations !== undefined ? { maxContinuations } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    },
  });

  const actions: LoopActions = {
    newCycle: () => {
      loopState.continuations = 0;
      loopState.cycleStart = Date.now();
      gateAttemptLedger.clear();
      loopState.completionClaimed = false;
    },
 disable: () => {
      loopState.disabled = true;
      setOverride({ disabled: true });
      note("auto-loop disabled by command.");
    },
    enable: () => {
      loopState.disabled = false;
      setOverride({ disabled: false });
      note("auto-loop enabled by command.");
    },
    setGoal: (text: string) => {
      loopState.goal = {
        status: "active",
        objective: text,
        goalId: `goal_${Date.now().toString(36)}`,
        continuationsUsed: 0,
        createdAt: Date.now(),
      };
      // The goal tool will call persistGoal, so no need to call it here directly
      actions.newCycle(); // Start a new cycle for the new goal
      note(`goal set: ${text.slice(0, 400)}`);
    },
    setPaused: (paused: boolean) => {
      loopState.paused = paused;
      setOverride({ paused: paused });
      note(`auto-loop ${paused ? 'paused' : 'resumed'} by command.`);
    },
  };

  // Gate retry bookkeeping, mirroring AutonomousRuntimeState. The v2 ledger
  // carries the no-progress digest alongside the attempt count.
  const gateAttemptLedger = new Map<string, GateAttempt>();

  // Production adapters for the injected ports (lib/ports.ts). Only this
  // factory binds ports to node built-ins; nothing under lib/ imports them.
  const nodeExec = {
    run: (command: string, cwd: string, timeoutMs: number) =>
      runShell(command, cwd, timeoutMs),
  };
  const nodeFs: FsPort = {
    appendFile: async (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, data);
    },
    writeFile: async (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    readFile: async (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    mkdirp: async (path) => {
      mkdirSync(path, { recursive: true });
    },
    unlink: async (path) => {
      rmSync(path, { force: true });
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
    stat: async (path) => {
      try {
        const st = statSync(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    },
  };

  const nodeGit = {
    attest: async (cwd: string, deadlineMs: number) => {
      const digest = await worktreeSnapshot(cwd, deadlineMs);
      if (digest === undefined) {
        return { kind: "unavailable" as const, reason: "worktree attestation failed" };
      }
      return {
        kind: "available" as const,
        digest,
        capturedAtMs: Date.now(),
      };
    },
    nowMs: () => Date.now(),
  };

  // The judge and the reflect pass share one model, disabled unless
  // OMP_AUTO_LOOP_JUDGE_MODEL is set, so an unconfigured deployment settles a
  // bare claim exactly as before. The default endpoint is omp's loopback Envoy
  // AI Gateway proxy.
  const JUDGE_MAX_TOKENS = 96;
  const JUDGE_EVIDENCE_MAX_CHARS = 4000;
  const chat = chatFromEnv(process.env);
  const judgePort: JudgePort | undefined = chat
    ? {
        judge: async (request): Promise<JudgeVerdict> => {
          // Global criteria, then this repo's definition of done.
          const policy = readPolicy();
          const criteria = [promptText(policy, "judgeCriteria"), criteriaFor(policy, repoName())]
            .filter((c) => c.trim())
            .join("\n");
          const reply = await chat.complete(
            buildJudgePrompt(request, criteria),
            JUDGE_MAX_TOKENS,
          );
          if (!reply.ok) return { ok: false, done: false, rationale: `judge ${reply.error}` };
          return parseJudgeVerdict(reply.text) ?? { ok: false, done: false, rationale: "unparseable judge reply" };
        },
      }
    : undefined;

  const sessionLabel = `${basename(process.cwd())}#${process.pid}`;
  const sink = new ObservationSink(
    nodeFs,
    {
      stateDir,
      sessionLabel,
      maxGraphLines: envInt("OMP_AUTO_LOOP_MAX_GRAPH_LINES", 20000), // Max graph lines from env
    },
    createGraphProjection(),
    Date.now(),
  );

  // Steering from outside the terminal. One file, read by every session on
  // this host, because only one of them can hold the dashboard port and an
  // action must not depend on which. Commands are consumed by timestamp, so a
  // session that starts later does not replay a day of old steering onto a
  // fresh run.
  const controlFile = `${stateDir}/control.jsonl`;
  let controlCursor = 0;
  try {
    const existing = readFileSync(controlFile, "utf8");
    controlCursor = selectCommands(existing, sessionLabel, 0).cursor;
  } catch {
    // No channel yet: the first command creates it.
  }

  /** Set a goal and hand its full text to the agent, which a note truncates. */
  const startGoal = (objective: string, why: string): void => {
    actions.setGoal(objective);
    pi.sendUserMessage(`[auto-loop] ${why}: ${objective}`);
  };

  const applyCommand = (command: ControlCommand): void => {
    switch (command.action) {
      case "pause":
        actions.setPaused(true);
        break;
      case "resume":
        actions.setPaused(false);
        break;
      case "disable":
        actions.disable();
        break;
      case "enable":
        actions.enable();
        break;
      case "goal":
        if (command.value) startGoal(command.value, "new goal from the operator");
        break;
      case "guide":
        // Labelled as the operator's words, so the agent can tell steering
        // from its own tool output.
        if (command.value) pi.sendUserMessage(`[operator guidance] ${command.value}`);
        break;
      case "reopen": {
        // A human overturned this session's "done": the same goal goes back to
        // work on a fresh budget, with the reason in the agent's context.
        if (!loopState.goal.objective) break;
        loopState.goal = { ...loopState.goal, status: "active" };
        actions.newCycle();
        persistGoal();
        pi.sendUserMessage(
          `[operator] Your completion was not accepted${command.value ? `: ${command.value}` : "."} ` +
            `Keep working on: ${loopState.goal.objective}`,
        );
        break;
      }
    }
    note(`steered: ${command.action}${command.value ? ` — ${command.value.slice(0, 80)}` : ""}`);
  };

  const drainControl = (): void => {
    let text = "";
    try {
      text = readFileSync(controlFile, "utf8");
    } catch {
      return;
    }
    const selected = selectCommands(text, [sessionLabel, sessionState().label], controlCursor);
    controlCursor = selected.cursor;
    for (const command of selected.commands) applyCommand(command);
  };

  const controlTimer = setInterval(drainControl, 2_000);
  if (typeof controlTimer.unref === "function") controlTimer.unref();

  // The loop's own human surface. `dashboardPort` was reserved in config from
  // the start and nothing served it, so `/autoloop open-dashboard` opened the
  // jump-cannon canvas instead -- five thousand nodes answering a different
  // question. Read-only, loopback, and best-effort: a port already taken must
  // not stop the loop from running.
  // Call sites need lockstep reset semantics: a new cycle is a new budget.
  // The gate attempt ledger belongs to that budget. Without clearing it here,
  // a gate that burned its retries stays exhausted for the lifetime of the
  // process, so later cycles in the same session settle
  // "gate_retries_exhausted" without ever running the gate again -- the loop
  // stops steering on the second work item onwards.
  // This is now actions.newCycle()

  // Replay our own event log and adopt the budget a previous process for
  // this session had spent, so a session that dies mid-cycle resumes
  // instead of silently getting a fresh budget. A switch to a different
  // session starts fresh; the filter keeps each session's own history.
  function resumeFromLog(): void {
    void (async () => {
      const text = await nodeFs.readFile(statusFile);
      if (!text) return;
      const rows: LoopEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line) as LoopEvent);
        } catch {
          // Truncated tail from a crash mid-append: dropped.
        }
      }
      const resumed = replayCycle(rows, { session: sessionLabel });
      if (resumed.continuations > 0) {
        loopState.continuations = resumed.continuations;
        loopState.cycleStart = resumed.cycleStartedAtMs;
        note(
          `resumed: prior run had spent ${resumed.continuations}/${getEffective().maxContinuations} continuations`,
        );
      }
    })();
  }

  function persistGoal(): void {
    loopState.goal = { ...loopState.goal, updatedAt: Date.now() };
    pi.appendEntry("auto_loop_goal", loopState.goal);
  }

  // Graph identity and links. The session key is omp's session id, so a
  // restarted or resumed session stays one hub; the pid is only a fallback
  // before any handler has delivered a context.
  let heartbeats = 0;
  let outcome: string | null = null;
  const repoByCwd = new Map<string, RepoRef | null>();
  // Subagents run as further extension instances in this process; this
  // registry maps each agent's registry id to its session key so a subagent
  // can link to the session that spawned it.
  const agentKeys: Map<string, string> = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("omp-auto-loop.agent-keys")
  ] ??= new Map<string, string>()) as Map<string, string>;

  function ctxCwd(): string {
    return (loopState.lastCtx && typeof loopState.lastCtx.cwd === "string" && loopState.lastCtx.cwd) || process.cwd();
  }

  // sessionKey is already defined above in this scope for setOverride/getEffectiveConfig

  /** Resolve (once per cwd, async) the repo whose shared git dir holds cwd. */
  function repoFor(cwd: string): RepoRef | null {
    if (!repoByCwd.has(cwd)) {
      repoByCwd.set(cwd, null);
      void runShell("git rev-parse --path-format=absolute --git-common-dir", cwd, 5_000).then(
        (r) => {
          const common = r.ok ? r.output.trim().split("\n")[0]!.trim() : "";
          if (!common) return;
          const root = common.replace(/\/.git\/?$/, "");
          repoByCwd.set(cwd, { root, name: basename(root) });
        },
      );
    }
    return repoByCwd.get(cwd) ?? null;
  }

  function sessionState(): SessionState {
    const cwd = ctxCwd();
    const key = sessionKey(loopState.lastCtx, record, idPart);
    const agent = record(loopState.lastCtx?.agent);
    const agentId = typeof agent?.id === "string" ? agent.id : null;
    if (agentId) agentKeys.set(agentId, key);
    const parentId = typeof agent?.parentId === "string" ? agent.parentId : null;
    const model = record(loopState.lastCtx?.model);
    return {
      key,
      label: `${basename(cwd)}#${key.slice(0, 8)}${agentId && agent?.kind === "sub" ? `/${agentId}` : ""}`,
      cwd,
      agent: agent?.kind === "sub" ? "sub" : "main",
      parentKey: (parentId && agentKeys.get(parentId)) || null,
      repo: repoFor(cwd),
      goal: loopState.goal.status === "idle" ? null : { objective: loopState.goal.objective, status: loopState.goal.status },
      gates: gateCommandsNow(getEffective()),
      model: typeof model?.id === "string" ? model.id : null,
      continuations: loopState.continuations,
      maxContinuations: getEffective().maxContinuations,
      heartbeats,
      outcome,
    };
  }

  // Every note is both printed (tail-visible in the pane) and enqueued to the
  // serialized sink, which owns the JSONL and graph writes. The handler never
  // blocks on disk; the sink preserves order for the importer.
  const note = (msg: string) => {
    // console.log() only if headless
    if (getEffective().headless) {
        console.log(`[auto-loop] ${msg}`);
    } else {
        // Assume pi.sendMessage for UI notification if not headless
        pi.sendUserMessage(`[auto-loop] ${msg}`);
    }

    if (msg.startsWith("settled: ")) outcome = msg.slice("settled: ".length);
    else if (msg.startsWith("gates passed")) outcome = "verified";
    else if (msg.startsWith("cycle stopped")) outcome = "timeout";
    sink.emit(msg, Date.now(), sessionState());
  };

  const readText = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };

  /** Run the reflect pass over the log and file its proposal, if the model gives a usable one. */
  const proposeNow = (source: string) => {
    if (!chat) return Promise.resolve({ ok: false as const, error: "no model configured (OMP_AUTO_LOOP_JUDGE_MODEL)" });
    const rows = parseEvents(readText(statusFile));
    return proposeImprovement({
      chat,
      policy: readPolicy(),
      events: rows.map((d) => ({ ts: d.ts, session: d.session, msg: d.message })),
      limits: { maxContinuations: getEffective().maxContinuations, timeoutMs: getEffective().timeoutMs },
      mix: verdictMix(rows, Date.now(), 24),
      append: (op) => appendPolicy(op, source),
      source,
      nowMs: Date.now(),
    });
  };

  /** The repo a session works in: its shared git root's name, else its cwd's. */
  const repoName = (): string => repoFor(ctxCwd())?.name ?? basename(ctxCwd());

  /**
   * Gates for this session: the dashboard's per-repo set wins, then
   * OMP_AUTO_LOOP_GATES / config.json. Read per settle, so a gate configured
   * on the dashboard applies to the next claim.
   */
  const gateCommandsNow = (config: SessionConfig): string[] => {
    const fromPolicy = gatesFor(readPolicy(), repoName());
    return fromPolicy.length > 0 ? [...fromPolicy] : (config.gateCommands ?? []);
  };

  const afterSettle = (): void => {
    const policy = readPolicy();
    if (flag(policy, "queueAutoPull")) {
      const item = nextQueued(policy, repoName());
      if (item) {
        // Claim, then re-read: the log's order decides a race, so only the
        // session whose claim landed first takes the goal.
        appendPolicy({ op: "queue.claim", id: item.id, session: sessionLabel }, sessionLabel);
        if (readPolicy().queue.find((q) => q.id === item.id)?.claimedBy === sessionLabel) {
          startGoal(item.objective, "next goal from the queue");
        }
      }
    }
    if (flag(policy, "reflect")) void proposeNow(sessionLabel);
  };

  let dashboard: { close: () => void; url: string } | undefined;
  if (getEffective().dashboardPort > 0) {
    try {
      dashboard = createDashboard({
        port: getEffective().dashboardPort,
        readProjection: () => readText(`${stateDir}/graph.lines`),
        // The log is the record; the projection can be missing a settle.
        readEvents: () => readText(statusFile),
        readPolicy: () => readText(policyFile),
        writePolicy: (op) => appendPolicy(op, "dashboard"),
        limits: () => ({ maxContinuations: getEffective().maxContinuations, timeoutMs: getEffective().timeoutMs }),
        reflect: () => proposeNow("dashboard"),
        // Another session already serving the port is the normal case on a
        // host running more than one session; only a real failure is news.
        onError: (message) => {
          if (!/in use|EADDRINUSE/i.test(message)) note(`dashboard unavailable: ${message}`);
        },
        onListening: (url) => note(`dashboard: ${url}`),
        steer: (command) => {
          // Append, never rewrite: every session reads this file and appends
          // to it, so a read-modify-write would drop whichever steering landed
          // in the window. O_APPEND makes one line one write.
          appendFileSync(
            controlFile,
            encodeCommand({
              at: Date.now(),
              target: command.target,
              action: command.action as ControlAction,
              value: command.value,
              by: "dashboard",
            }),
          );
        },
      });
    } catch (error) {
      note(`dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  function sessionIdle(): boolean {
    const isIdle = loopState.lastCtx?.isIdle;
    return typeof isIdle === "function" && isIdle.call(loopState.lastCtx) === true;
  }

  // The pi extension API has no readEntries; custom entries are replayed from
  // the session log via the handler ctx's sessionManager.
  function readCustomEntries(ctx: unknown, customType: string): { data: unknown }[] {
    if (ctx === null || typeof ctx !== "object" || !("sessionManager" in ctx)) return [];
    const sm = (ctx as { sessionManager: unknown }).sessionManager;
    if (sm === null || typeof sm !== "object" || !("getBranch" in sm) || typeof sm.getBranch !== "function") return [];
    const entries: unknown[] = sm.getBranch();
    return entries.filter((e): e is { data: unknown } =>
      e !== null && typeof e === "object" && "type" in e && e.type === "custom"
      && "customType" in e && e.customType === customType && "data" in e);
  }

  function sessionStartConfig(data: unknown): { overrides?: Partial<SessionConfig>; disabled?: boolean; paused?: boolean } | null {
    if (data === null || typeof data !== "object") return null;
    const cfg: { overrides?: Partial<SessionConfig>; disabled?: boolean; paused?: boolean } = {};
    if ("overrides" in data) cfg.overrides = data.overrides as Partial<SessionConfig>;
    if ("disabled" in data && typeof data.disabled === "boolean") cfg.disabled = data.disabled;
    if ("paused" in data && typeof data.paused === "boolean") cfg.paused = data.paused;
    return cfg;
  }

  pi.on("session_start", async (event, ctx) => {
    loopState.lastCtx = ctx; // Set lastCtx in loopState
    // Replay overrides
    const configEntries = readCustomEntries(ctx, "auto_loop_config");
    if (configEntries.length > 0) {
        const latestConfig = sessionStartConfig(configEntries[configEntries.length - 1].data);
        if (latestConfig?.overrides) {
            sessionOverrides.set(sessionKey(loopState.lastCtx, record, idPart), latestConfig.overrides);
        }
        loopState.disabled = latestConfig?.disabled ?? loopState.disabled;
        loopState.paused = latestConfig?.paused ?? loopState.paused;
    }

    // Replay goal if exists
    const goalEntries = readCustomEntries(ctx, "auto_loop_goal");
    const goalData = goalEntries.length > 0 ? goalEntries[goalEntries.length - 1].data : null;
    if (goalData !== null && typeof goalData === "object" && "status" in goalData && "objective" in goalData) {
      loopState.goal = goalData as GoalState;
    }

    if (loopState.disabled) {
      note("auto-loop is currently disabled.");
      return;
    }
    // resumeFromLog should be called after loopState is initialized and potentially restored
    resumeFromLog();
    if (loopState.goal.status === "active" && getEffective().heartbeatMs > 0) {
      // Schedule heartbeat only if goal is active and heartbeat is enabled
      const heartbeatInterval = setInterval(() => {
        if (sessionIdle() && loopState.goal.status === "active") {
          loopState.lastNudgeAt = Date.now();
          pi.sendMessage("heartbeat");
          heartbeats++;
        }
      }, getEffective().heartbeatMs);
      // Clean up on session_stop (will be registered below)
    }
  });

  pi.on("session_switch", (event, ctx) => {
    loopState.lastCtx = ctx;
  });

  pi.on("session_stop", async (event, ctx) => {
    if (loopState.disabled) {
      note("auto-loop disabled (session)");
      return;
    }
    loopState.lastCtx = ctx;

    const currentConfig = getEffective();

    // `goal complete` moves the goal to "complete" before the turn ends, so
    // gating on "active" alone would skip the decision for exactly the state
    // that needs one.
    if ((loopState.goal.status === "active" || loopState.completionClaimed) && !loopState.paused && !loopState.disabled) {
      const stopReason = lastAssistantText(event);
      // The decision core is pure: it takes observed facts, not ports. Gates
      // are evidence, so they run HERE and their aggregate is passed in.
      const gateCommands = gateCommandsNow(currentConfig);
      let gateOutcome: GateSetOutcome | undefined;
      if (gateCommands.length > 0) {
        const run = await runGateSet(
          {
            commands: gateCommands,
            maxRetries: DEFAULT_GATE_RETRIES,
            perCommandTimeoutMs: DEFAULT_GATE_TIMEOUT_MS,
            totalTimeoutMs: DEFAULT_GATE_TIMEOUT_MS * gateCommands.length,
            cwd: ctxCwd(),
            exec: nodeExec,
            git: nodeGit,
          },
          gateAttemptLedger,
        );
        gateOutcome = buildGateOutcome(run.local, run.exhausted, run.unavailable);
      }

      // The judge only speaks when gates cannot: a gate set is the stronger
      // evidence, so consulting a model alongside it would add latency and
      // cost for nothing.
      let judgeVerdict: { done: boolean; rationale: string } | undefined;
      let judgeUnavailable = false;
      if (loopState.completionClaimed && gateCommands.length === 0 && judgePort) {
        const verdict = await judgePort.judge({
          objective: loopState.goal.objective,
          reply: lastAssistantText(event),
          evidence: extractEvidence(lastMessages(event), JUDGE_EVIDENCE_MAX_CHARS),
        });
        if (verdict.ok) {
          judgeVerdict = { done: verdict.done, rationale: verdict.rationale };
          // The reason travels with the verdict so a human reviewing it later
          // sees why, not just what.
          const first = verdict.rationale.split("\n")[0]!.trim().slice(0, 240);
          const reason = first === "VERIFIED" || first === "UNVERIFIED" ? "" : first;
          note(`judge verdict: ${verdict.done ? "VERIFIED" : "UNVERIFIED"}${reason ? ` — ${reason}` : ""}`);
        } else {
          judgeUnavailable = true;
          note(`judge unavailable: ${verdict.rationale}`);
        }
      }
      const decision = shouldContinue({
        state: loopState,
        limits: {
          maxContinuations: currentConfig.maxContinuations,
          timeoutMs: currentConfig.timeoutMs,
        },
        goal: loopState.goal,
        input: {
          // A session with no UI is headless unless the config opts in.
          headless: !ctx.hasUI,
          headlessOptIn: currentConfig.headless,
          // Structural: the goal tool raised the claim. A text marker would be
          // forgeable by the reply under judgment.
          claimsCompletion: loopState.completionClaimed,
          scheduledContinuation: loopState.scheduledContinuation,
          stopReason,
          configuredGates: gateCommands,
          gateOutcome,
          gateResultIsStale: false,
          judgeVerdict,
          judgeUnavailable,
          nowMs: Date.now(),
        },
      });

      if (decision.kind === "continue") {
        loopState.continuations = decision.continuations;
        loopState.goal.continuationsUsed++;
        pi.sendMessage(promptText(readPolicy(), "continuation"));
        loopState.scheduledContinuation = true;
        note(
          `autonomous continuation: ${loopState.continuations}/${currentConfig.maxContinuations}. ${decision.reason ?? "no claim"}`,
        );
      } else if (decision.kind === "settle") {
        note(`settled: ${decision.reason}`);
        afterSettle();
      }
    }
    // Ensure all timeouts/intervals are cleared
    // The heartbeat interval needs to be managed globally or returned from pi.on
  });

  pi.on("session_input", (event, ctx) => {
    loopState.lastCtx = ctx;
    loopState.scheduledContinuation = false;
  });

  pi.registerTool({
    name: "goal",
    label: "Goal",
    description:
      "Own the thread goal for the autonomous loop (port of prime-agent's goal skill). " +
      "set: start/replace the goal (objective required). pause/resume/complete: change status. " +
      "status: report. While a goal is active the loop keeps the session working toward it " +
      "and an idle heartbeat re-checks progress.",
    approval: "read",
    parameters: GoalParams,
    execute: async (_toolCallId, params) => {
      if (params.action === "set") {
        const objective = (params.objective ?? "").trim();
        if (!objective) {
          return {
            content: [{ type: "text", text: "goal set requires a non-empty objective" }],
          };
        }
        actions.setGoal(objective);
        return { content: [{ type: "text", text: `Goal active: ${objective}` }] };
      }
      if (params.action === "complete") {
        if (loopState.goal.status !== "active") {
          return { content: [{ type: "text", text: "No active goal to complete." }] };
        }
        loopState.goal.status = "complete";
        loopState.completionClaimed = true;
        persistGoal();
        note("goal complete");
        return { content: [{ type: "text", text: "Goal completed." }] };
      }
      if (params.action === "pause") {
        if (loopState.goal.status !== "active") {
          return { content: [{ type: "text", text: "No active goal to pause." }] };
        }
        actions.setPaused(true);
        return { content: [{ type: "text", text: "Goal paused." }] };
      }
      if (params.action === "resume") {
        if (loopState.goal.status !== "paused") {
          return { content: [{ type: "text", text: "No paused goal to resume." }] };
        }
        actions.setPaused(false);
        return { content: [{ type: "text", text: "Goal resumed." }] };
      }
      if (params.action === "status") {
        return {
          content: [
            { type: "text", text: `Current goal: ${loopState.goal.objective || "None"}. Status: ${loopState.goal.status}` },
          ],
        };
      }
      return { content: [{ type: "text", text: `Unknown goal action: ${params.action}` }] };
    },
  });

  // Register commands if pi.registerCommand exists
  if (typeof pi.registerCommand === 'function') {
    registerCommands(
      pi,
      () => getEffective(sessionKey(loopState.lastCtx, record, idPart)), // Pass a getter for effective config
      setOverride,
      { get: () => ({
          goalObjective: loopState.goal.objective,
          continuations: loopState.continuations,
          maxContinuations: getEffective().maxContinuations,
          cycleStartTime: loopState.cycleStart,
          gates: getEffective().gateCommands,
          disabled: loopState.disabled,
          status: loopState.goal.status,
          paused: loopState.paused,
      })},
      actions,
      XDG_CONFIG_HOME,
      XDG_STATE_HOME,
      XDG_CACHE_HOME
    );
  }
}
