// v2 pure loop core — extracted from omp-auto-loop.ts so the decision is
// testable without a TUI, a filesystem, or a model.
//
// Upstream lineage: PrimeIntellect-ai/prime-agent core/{autonomous.ts,
// goals.ts, cron-jobs.ts} (Apache-2.0); settle-gate lineage from
// DraconDev/opencode-auto-continue (AGPL-3.0).
//
// Research grounding (see .specs/research/literature.json):
//   - Let's Verify Step by Step (2305.20050) and ReVeal (2506.11442):
//     self-reported completion is unreliable evidence; process-level
//     verification is what makes a verdict trustworthy. Hence two-key
//     completion — a claim is never "verified".
//   - FineVerify (2606.00660): a global pass/fail is a weaker judgment than
//     per-check local judgments. Hence one typed LocalResult per gate, with
//     the aggregate derived mechanically from them.
//   - Self-Refine (2303.17651): a small fixed iteration budget is the
//     operative control. Hence `maxContinuations` and the elapsed cap are
//     independent termination conditions, not one shared budget.
//   - Is Self-Repair a Silver Bullet? (2306.09896): self-repair gains are
//     bounded and variable. Hence every path terminates explicitly and
//     records whether the outcome was verified or merely claimed.
//
// No imports. Everything here is pure: ports are injected by the caller.

export type DecisionKind =
  | "continue"
  | "settle"
  | "verify"
  | "no-op";

export type SettleReason =
  | "headless"
  | "scheduled_continuation"
  | "error"
  | "aborted"
  | "verified_complete"
  | "claimed_unverified"
  | "continuation_limit"
  | "cycle_timeout"
  | "gate_retries_exhausted"
  | "gate_deadline"
  | "gate_unavailable"
  | "stale_result";

export interface Decision {
  readonly kind: DecisionKind;
  readonly reason?: SettleReason;
  /** Cycle continuation count AFTER this decision. */
  readonly continuations: number;
}

export interface GoalView {
  readonly status: "idle" | "active" | "paused" | "complete";
  readonly objective: string;
  readonly continuationsUsed: number;
}

export interface Limits {
  readonly maxContinuations: number;
  readonly timeoutMs: number;
}

export interface CycleState {
  readonly continuations: number;
  readonly startedAtMs: number;
  readonly cycleId: string;
}

/** One gate's local judgment. The aggregate is derived, never asserted. */
/**
 * One gate's local judgment. Non-passing variants carry the worktree digest
 * that justified the verdict, so the decision is auditable after the fact
 * without the caller having to remember it.
 */
export type LocalResult =
  | { readonly kind: "pass"; readonly command: string }
  | { readonly kind: "fail"; readonly command: string; readonly exitText: string; readonly output: string; readonly attempt: number; readonly digest?: string }
  | { readonly kind: "timeout"; readonly command: string; readonly attempt: number; readonly digest?: string }
  | { readonly kind: "not-run"; readonly command: string; readonly attempt: number; readonly digest?: string };

export type GateFailure = Extract<
  LocalResult,
  { kind: "fail" | "timeout" | "not-run" }
>;

export interface GateSetOutcome {
  /** "passed" only when every command produced a local pass. */
  readonly aggregate: "passed" | "failed" | "exhausted" | "unavailable";
  readonly local: readonly LocalResult[];
  /** First failing local result, for the continuation text. */
  readonly failure?: GateFailure;
}

export interface SettleInput {
  readonly headless: boolean;
  readonly headlessOptIn: boolean;
  readonly scheduledContinuation: boolean;
  readonly stopReason: string | undefined;
  /** True when the assistant reply contains the completion marker. */
  readonly claimsCompletion: boolean;
  readonly configuredGates: readonly string[];
  /** Most recent gate outcome for this cycle, if any. */
  readonly gateOutcome?: GateSetOutcome;
  /** Identity fence: a result from a prior run/cycle is ignored. */
  readonly gateResultIsStale: boolean;
  readonly nowMs: number;
}

export interface DecideArgs {
  readonly state: CycleState;
  readonly limits: Limits;
  readonly goal: GoalView;
  readonly input: SettleInput;
}

function limitReason(
  state: CycleState,
  limits: Limits,
  nowMs: number,
): SettleReason | undefined {
  if (state.continuations >= limits.maxContinuations) return "continuation_limit";
  if (nowMs - state.startedAtMs >= limits.timeoutMs) return "cycle_timeout";
  return undefined;
}

/**
 * The pure settle decision. Precedence, in order (this is the normative
 * table; T1..T10 in the design are its literal triples):
 *
 *  1. headless without opt-in        -> no-op
 *  2. scheduled continuation          -> no-op, one-shot flag consumed
 *  3. error / aborted turn            -> settle
 *  4. stale gate result identity      -> no-op (diagnostic only)
 *  5. claim + gates configured        -> verify (pending), run the gate set
 *  6. gate aggregate passed           -> settle(verified_complete)
 *  7. gate failed, budget remains     -> continue with local failure evidence
 *  8. gate timeout/exhausted/unavailable, or a cap tripped -> settle, never verified
 *  9. claim without gates             -> settle(claimed_unverified)
 * 10. no claim and a cap tripped      -> settle(cap reason)
 * 11. otherwise                       -> continue
 */
export function shouldContinue(args: DecideArgs): Decision {
  const { state, limits, input } = args;
  const settle = (reason: SettleReason): Decision => ({
    kind: "settle",
    reason,
    continuations: state.continuations,
  });

  if (input.headless && !input.headlessOptIn) {
    return { kind: "no-op", reason: "headless", continuations: state.continuations };
  }
  if (input.scheduledContinuation) {
    return {
      kind: "no-op",
      reason: "scheduled_continuation",
      continuations: state.continuations,
    };
  }
  if (input.stopReason === "error") return settle("error");
  if (input.stopReason === "aborted") return settle("aborted");
  if (input.gateResultIsStale) {
    return { kind: "no-op", reason: "stale_result", continuations: state.continuations };
  }

  if (input.configuredGates.length > 0) {
    const outcome = input.gateOutcome;
    if (outcome) {
      if (outcome.aggregate === "passed") return settle("verified_complete");
      const exhausted = outcome.aggregate === "exhausted";
      const unavailable = outcome.aggregate === "unavailable";
      if (exhausted || unavailable) {
        return settle(exhausted ? "gate_retries_exhausted" : "gate_unavailable");
      }
      // failed: continue while budget remains, else settle explicitly.
      const capped = limitReason(state, limits, input.nowMs);
      if (capped) return settle(capped);
      return {
        kind: "continue",
        continuations: state.continuations + 1,
      };
    }
    // A claim (or a bare settle) with gates configured and no outcome yet:
    // the caller must run the gate set and decide again.
    if (input.claimsCompletion) {
      return { kind: "verify", continuations: state.continuations };
    }
  }

  if (input.claimsCompletion) {
    // No gates configured: a claim settles the session, but explicitly
    // unverified. This is the live production path today (ReVeal 2506.11442:
    // self-verification is not evidence).
    return settle("claimed_unverified");
  }

  const capped = limitReason(state, limits, input.nowMs);
  if (capped) return settle(capped);
  return { kind: "continue", continuations: state.continuations + 1 };
}

/** Derive the aggregate from local judgments (FineVerify 2606.00660). */
export function aggregate(local: readonly LocalResult[]): GateSetOutcome["aggregate"] {
  if (local.length === 0) return "unavailable";
  if (local.some((r) => r.kind === "not-run" || r.kind === "timeout")) {
    return local.every((r) => r.kind === "pass") ? "passed" : "unavailable";
  }
  if (local.every((r) => r.kind === "pass")) return "passed";
  if (local.some((r) => r.kind === "fail")) return "failed";
  return "failed";
}

export function buildGateOutcome(
  local: readonly LocalResult[],
  exhausted: boolean,
  unavailable = false,
): GateSetOutcome {
  // Two distinct reasons a set cannot be trusted, and neither is a pass:
  //  - `unavailable`: the workspace could not be attested, so a green gate
  //    says nothing about the state of the tree (absence of evidence).
  //  - `exhausted`: the retry budget is spent (no further progress allowed).
  // Conflating them produced a fail-open verified_complete; keep them apart.
  const derived = aggregate(local);
  const aggregateResult: GateSetOutcome["aggregate"] = unavailable
    ? "unavailable"
    : exhausted && derived !== "passed"
      ? "exhausted"
      : derived;
  const outcome: GateSetOutcome = { aggregate: aggregateResult, local };
  const failing = local.find((r) => r.kind !== "pass");
  return failing ? { ...outcome, failure: failing as GateFailure } : outcome;
}

/** The goal prefix injected into continuation context, if any. */
export function goalPrefix(goal: GoalView, goalId?: string): string {
  return goal.status === "active" && goal.objective
    ? `Active goal (${goalId ?? "?"}): ${goal.objective}. `
    : "";
}
