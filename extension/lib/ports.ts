// Injected ports. Production adapters live in auto-loop.ts and bind these to
// node built-ins; tests bind them to deterministic fakes. No module under
// lib/ may import a production implementation (design rev.2, eval judges 1+3).

export interface ExecResult {
  readonly ok: boolean;
  readonly exitText: string;
  readonly output: string;
}

export interface ExecPort {
  /** Run a shell command. `timeoutMs` bounds the whole call. */
  run(command: string, cwd: string, timeoutMs: number): Promise<ExecResult>;
}

export interface GitAttestation {
  readonly kind: "available";
  readonly digest: string;
  readonly capturedAtMs: number;
}

export interface GitUnavailable {
  readonly kind: "unavailable";
  readonly reason: string;
}

export type Attestation = GitAttestation | GitUnavailable;

export interface GitPort {
  /**
   * Digest of tracked changes AND untracked file contents, within explicit
   * bounds. Exceeding a bound yields `unavailable`, never a false "stable".
   */
  attest(cwd: string, deadlineMs: number): Promise<Attestation>;
  /** Milliseconds since the epoch. */
  nowMs(): number;
}

export interface ClockPort {
  nowMs(): number;
}

export interface IdPort {
  /** Deterministic in tests. */
  newCycleId(): string;
  newCausationId(): string;
}

export interface FsPort {
  appendFile(path: string, data: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  mkdirp(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  /** Create `path` only if it does not exist; false when it already does. */
  createExclusive(path: string): Promise<boolean>;
  /** Atomically replace `to` with `from`. */
  rename(from: string, to: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Completion judge — corroborates a completion claim that gates cannot, on the
// no-gates path. Unusable answers surface as ok:false and are never a pass.
// ---------------------------------------------------------------------------

/** What the judge is asked to corroborate: goal, self-reported reply, evidence. */
export interface JudgeRequest {
  /** The active goal objective; "" when no goal is set. */
  readonly objective: string;
  /** Final assistant reply. An untrusted self-report, never evidence. */
  readonly reply: string;
  /** Command output / test results backing the claim; "" when none exists. */
  readonly evidence: string;
}

export interface JudgeVerdict {
  /** False when the judge could not run or its answer was unusable. */
  readonly ok: boolean;
  /** Meaningful only when `ok`: did the evidence substantiate the claim? */
  readonly done: boolean;
  /** Verdict rationale when `ok`; the failure reason otherwise. Never a pass on failure. */
  readonly rationale: string;
}

export interface JudgePort {
  /** Corroborate a completion claim. Unusable judge answers surface as ok:false, never done:true. */
  judge(request: JudgeRequest): Promise<JudgeVerdict>;
}
