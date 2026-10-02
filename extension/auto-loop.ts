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
} from "./lib/core.ts";
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
    // Add other general keys from config.json if they exist and are not impBridge
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

// Adapted from prime-agent DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT.
const CONTINUATION_DIRECTIVE =
  "No human input is available while the autonomous loop is running. " +
  "Continue working until the task is complete or the loop's limits stop " +
  "the run. If you were about to ask the user a question, make a reasonable " +
  "assumption and verify it. If you believe you are blocked, prove it with " +
  "host-observable evidence (command output, file state), preserve that " +
  "evidence, and keep looking for safe progress while budget remains.";

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

import { SESSION_OVERRIDES_KEY, DEFAULT_SESSION_CONFIG } from "./lib/config.ts";

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

  // Create a bound getEffectiveConfig for use within the extension
  const getEffective = getEffectiveConfig({
    piHasUI: pi.hasUI,
    fileConfig,
    sessionOverrides,
    envInt,
    envStringArray,
    DEFAULT_SESSION_CONFIG,
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
      note(`goal set: ${text.slice(0, 120)}`);
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

  // Every note() lands in the event log (JSONL, one line per event) that
  // resumeFromLog replays, and in graph.lines, the projection the jump-cannon
  // canvas imports.
  const statusFile =
    process.env.OMP_AUTO_LOOP_STATUS_FILE ??
    `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? ""}/.local/state`}/omp-auto-loop/events.jsonl`;
  const sessionLabel = `${basename(process.cwd())}#${process.pid}`;
  const stateDir = dirname(statusFile);
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
      gates: getEffective().gateCommands,
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

  function sessionIdle(): boolean {
    const isIdle = loopState.lastCtx?.isIdle;
    return typeof isIdle === "function" && isIdle.call(loopState.lastCtx) === true;
  }

  pi.on("session_start", async (event, ctx) => {
    loopState.lastCtx = ctx; // Set lastCtx in loopState
    // Replay overrides
    const configEntries = await pi.readEntries("auto_loop_config");
    if (configEntries && configEntries.length > 0) {
        const latestConfig = configEntries[configEntries.length - 1].data as { overrides: Partial<SessionConfig>; disabled: boolean; paused: boolean; };
        if (latestConfig.overrides) {
            sessionOverrides.set(sessionKey(loopState.lastCtx, record, idPart), latestConfig.overrides);
        }
        loopState.disabled = latestConfig.disabled;
        loopState.paused = latestConfig.paused;
    }

    // Replay goal if exists
    const goalEntries = await pi.readEntries("auto_loop_goal");
    if (goalEntries && goalEntries.length > 0) {
        loopState.goal = goalEntries[goalEntries.length - 1].data as GoalState;
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

    if (loopState.goal.status === "active" && !loopState.paused && !loopState.disabled) {
      const stopReason = lastAssistantText(event);
      const decision = await shouldContinue({
        loopState,
        stopReason,
        gateCommands: currentConfig.gateCommands,
        gateMaxRetries: DEFAULT_GATE_RETRIES, // Use DEFAULT for gate retries
        gateTimeoutMs: DEFAULT_GATE_TIMEOUT_MS, // Use DEFAULT for gate timeout
        cwd: ctxCwd(),
        fs: nodeFs,
        exec: nodeExec,
        git: nodeGit,
        note,
        gateAttemptLedger,
      });

      if (decision.continue) {
        loopState.continuations++;
        loopState.goal.continuationsUsed++;
        pi.sendMessage(CONTINUATION_DIRECTIVE);
        loopState.scheduledContinuation = true;
        note(
          `autonomous continuation: ${loopState.continuations}/${currentConfig.maxContinuations}. ${decision.reason}`,
        );
      } else {
        note(`settled: ${decision.reason}`);
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
