// Pure session-config resolution: per-session override > env > config.json
// > default. Kept out of the extension entry so tests and the imp bridge can
// import it without pulling @oh-my-pi/omptype (which only the entry needs,
// and which resolves only inside omp's runtime).

export interface SessionConfig {
  version?: number;
  dashboardPort: number;
  maxContinuations: number;
  timeoutMs: number;
  heartbeatMs: number;
  gateCommands: string[] | null;
  headless: boolean;
  disabled: boolean;
  paused: boolean;
}

const DEFAULT_MAX_CONTINUATIONS = 3;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_HEARTBEAT_MS = 10 * 60 * 1000; // 10 minutes

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  // 8799 is the jump-cannon graph-api's port, so the loop dashboard cannot
  // claim it: both would be the default and the second to start would lose.
  dashboardPort: 8798, // Default if not in config.json or env
  maxContinuations: DEFAULT_MAX_CONTINUATIONS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
  gateCommands: null, // Default to no gates
  headless: false, // Will be overridden by pi.hasUI
  disabled: false, // Default to enabled
  paused: false, // Default to not paused
};

export const SESSION_OVERRIDES_KEY = Symbol.for("omp-auto-loop.session-overrides");

export interface LoopActions {
  newCycle(): void;
  disable(): void;
  enable(): void;
  setGoal(text: string): void;
  setPaused(paused: boolean): void;
}

export function getEffectiveConfig({
  piHasUI,
  fileConfig,
  sessionOverrides,
  envInt,
  envStringArray,
  DEFAULT_SESSION_CONFIG,
}: {
  piHasUI: boolean;
  fileConfig: Partial<SessionConfig>;
  sessionOverrides: Map<string, Partial<SessionConfig>>;
  envInt: (name: string, fallback: number) => number;
  envStringArray: (name: string) => string[];
  DEFAULT_SESSION_CONFIG: SessionConfig;
}): (sessionId: string) => SessionConfig {
  return (sessionId: string): SessionConfig => {
    const overrides = sessionOverrides.get(sessionId) || {};

    const config: SessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ...fileConfig,
      // env > file > default: the env resolver's fallback is the file-provided
      // value (or the default when the file is silent on that key).
      maxContinuations: envInt("OMP_AUTO_LOOP_MAX_CONTINUATIONS", fileConfig.maxContinuations ?? DEFAULT_SESSION_CONFIG.maxContinuations),
      timeoutMs: envInt("OMP_AUTO_LOOP_TIMEOUT_MS", fileConfig.timeoutMs ?? DEFAULT_SESSION_CONFIG.timeoutMs),
      heartbeatMs: envInt("OMP_AUTO_LOOP_HEARTBEAT_MS", fileConfig.heartbeatMs ?? DEFAULT_SESSION_CONFIG.heartbeatMs),
      gateCommands: envStringArray("OMP_AUTO_LOOP_GATES").length > 0 ? envStringArray("OMP_AUTO_LOOP_GATES") : fileConfig.gateCommands ?? DEFAULT_SESSION_CONFIG.gateCommands,
      headless: !piHasUI,
      ...overrides,
    };
    return config;
  };
}
