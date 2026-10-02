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
