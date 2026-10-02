// Gate executor: runs a configured gate set through the injected ports and
// returns per-command LOCAL judgments; the aggregate is derived in core.ts,
// never asserted here (FineVerify 2606.00660).
//
// Ports: prime-agent autonomous.ts:447-511, including the unchanged-workspace
// no-progress skip (autonomous.ts:459) and the retry cap.

import type { LocalResult } from "./core.ts";
import type { ExecPort, GitPort } from "./ports.ts";

export interface GateAttempt {
  readonly command: string;
  readonly attempts: number;
  /** Digest captured at the last failure; compared on the next attempt. */
  readonly failureDigest?: string;
}

export interface GateExecutorOptions {
  readonly commands: readonly string[];
  readonly maxRetries: number;
  readonly perCommandTimeoutMs: number;
  /** Absolute deadline for the whole set; the aggregate never exceeds it. */
  readonly totalTimeoutMs: number;
  readonly cwd: string;
  readonly exec: ExecPort;
  readonly git: GitPort;
}

export interface GateRunResult {
  readonly local: LocalResult[];
  readonly exhausted: boolean;
  readonly unavailable: boolean;
}

/**
 * Execute the gate set. Budgets:
 *  - each command is clamped to min(perCommandTimeoutMs, remaining total)
 *  - a command whose worktree digest is unchanged since its last failure is
 *    NOT rerun; it reports not-run with the incremented attempt, so a
 *    no-op edit cannot burn the retry budget.
 */
export async function runGateSet(
  opts: GateExecutorOptions,
  attempts: Map<string, GateAttempt>,
): Promise<GateRunResult> {
  const started = opts.git.nowMs();
  const local: LocalResult[] = [];
  let exhausted = false;
  let unavailable = false;

  for (const command of opts.commands) {
    const entry = attempts.get(command) ?? { command, attempts: 0 };
    const remaining = opts.totalTimeoutMs - (opts.git.nowMs() - started);
    if (remaining <= 0) {
      unavailable = true;
      local.push({ kind: "timeout", command, attempt: entry.attempts + 1 });
      break;
    }

    const priorDigest = entry.failureDigest;
    const before = await opts.git.attest(opts.cwd, remaining);
    if (before.kind === "unavailable") {
      // Cannot prove no progress, so we cannot claim a verdict; run the gate
      // anyway but flag the set as evidence-incomplete.
      unavailable = true;
    }
    if (priorDigest !== undefined && before.kind === "available" && priorDigest === before.digest) {
      // No-progress: rerunning would produce the identical result.
      const attempt = entry.attempts + 1;
      attempts.set(command, { ...entry, attempts: attempt, failureDigest: priorDigest });
      local.push({
        kind: "not-run",
        command,
        attempt,
        digest: priorDigest,
      });
      if (attempt > opts.maxRetries) exhausted = true;
      break;
    }

    const budget = Math.min(opts.perCommandTimeoutMs, Math.max(0, remaining));
    const result = await opts.exec.run(command, opts.cwd, budget);
    if (result.ok) {
      attempts.set(command, { command, attempts: 0 });
      local.push({ kind: "pass", command });
      continue;
    }
    const attempt = entry.attempts + 1;
    const after = await opts.git.attest(opts.cwd, Math.max(0, opts.totalTimeoutMs - (opts.git.nowMs() - started)));
    attempts.set(command, {
      command,
      attempts: attempt,
      failureDigest: after.kind === "available" ? after.digest : undefined,
    });
    local.push({
      kind: "fail",
      command,
      exitText: result.exitText,
      output: result.output,
      attempt,
      digest: after.kind === "available" ? after.digest : undefined,
    });
    if (attempt > opts.maxRetries) exhausted = true;
    break;
  }
  return { local, exhausted, unavailable };
}

export interface GateEvidence {
  readonly kind: "pass" | "fail" | "not-run";
  readonly command: string;
  readonly attempt: number;
  readonly exitText: string;
  /** Worktree digest in force when the verdict was reached; "" when none. */
  readonly digest: string;
}

/**
 * The auditable record of one gate verdict: which command, which attempt,
 * what it exited with, and the worktree digest that justified it. A no-progress
 * skip is only defensible if the digest is retained — without it nobody can
 * tell a real skip from a bug.
 */
export function evidenceBundle(
  local: readonly LocalResult[],
  exhausted: boolean,
  command: string,
): GateEvidence {
  const result = local.find((r) => r.command === command) ?? local[0];
  if (!result) {
    return { kind: "not-run", command, attempt: 0, exitText: "", digest: "" };
  }
  if (result.kind === "pass") {
    return { kind: "pass", command: result.command, attempt: 0, exitText: "exited 0", digest: "" };
  }
  if (result.kind === "not-run" || result.kind === "timeout") {
    return {
      kind: "not-run",
      command: result.command,
      attempt: result.attempt,
      exitText: result.kind === "timeout" ? "timed out" : "not rerun: workspace unchanged",
      digest: result.digest ?? "",
    };
  }
  return {
    kind: "fail",
    command: result.command,
    attempt: result.attempt,
    exitText: result.exitText,
    digest: result.digest ?? "",
  };
}

/** Continuation text for a failed gate (buildAutonomousGateFailureContinuation). */
export function gateFailureContext(
  failure: Extract<LocalResult, { kind: "fail" | "timeout" | "not-run" }>,
  maxRetries: number,
  goalPrefix: string,
): string {
  const reason =
    failure.kind === "not-run"
      ? "not rerun: workspace unchanged since previous failed gate"
      : failure.kind === "timeout"
        ? "timed out"
        : failure.exitText;
  const explanation =
    failure.kind === "not-run"
      ? "The gate was not rerun because the workspace has not changed since this " +
        "failure. Edit source files, tests, or a blocker artifact before attempting " +
        "to finish again."
      : failure.kind === "timeout"
        ? "The gate exceeded its time budget."
        : failure.output || "(no output)";
  return (
    `[auto-loop: gate-failed]\n\n` +
    `Autonomous quality gate failed (attempt ${failure.attempt}/${maxRetries}): ` +
    `\`${failure.command}\` ${reason}.\n\n${explanation}\n\n` +
    `${goalPrefix}Continue working. Fix the failure, then produce terminal evidence.`
  );
}
