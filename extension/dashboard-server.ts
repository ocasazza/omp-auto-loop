// The loop's dashboard as its own process, for a supervisor to keep running
// (process-compose on this fleet). Same page and wiring as the copy an omp
// session serves (lib/dashboard.ts hostDashboard); set `dashboardService` in
// config.json so sessions leave the port to this one.
//
// Resolves its inputs exactly as a session does: the state dir from
// OMP_AUTO_LOOP_STATUS_FILE / XDG_STATE_HOME, the port from config.json, the
// limits through getEffectiveConfig, the model from OMP_AUTO_LOOP_JUDGE_*.
//
// Run: bun run dashboard-server.ts

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SESSION_CONFIG,
  envInt,
  envStringArray,
  getEffectiveConfig,
  parseFileConfig,
  type SessionConfig,
} from "./lib/config.ts";
import { hostDashboard } from "./lib/dashboard.ts";
import { chatFromEnv } from "./lib/model.ts";
import { foldPolicy } from "./lib/policy.ts";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const statusFile = process.env.OMP_AUTO_LOOP_STATUS_FILE ?? join(stateHome, "omp-auto-loop", "events.jsonl");
const configFile = join(configHome, "omp-auto-loop", "config.json");

let fileConfig: Partial<SessionConfig> = {};
try {
  fileConfig = parseFileConfig(readFileSync(configFile, "utf8"));
} catch (error) {
  console.error(`dashboard-server: ${configFile}: ${error instanceof Error ? error.message : String(error)}; using defaults`);
}

const effective = getEffectiveConfig({
  piHasUI: false,
  fileConfig,
  sessionOverrides: new Map(),
  envInt,
  envStringArray,
  DEFAULT_SESSION_CONFIG,
  livePolicy: () => {
    const { maxContinuations, timeoutMs } = foldPolicy(read(join(dirname(statusFile), "policy.jsonl"))).params;
    return {
      ...(maxContinuations !== undefined ? { maxContinuations } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  },
});

hostDashboard({
  port: effective("").dashboardPort,
  statusFile,
  files: {
    read,
    append: (file, text) => {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text);
    },
  },
  chat: chatFromEnv(process.env),
  limits: () => {
    const { maxContinuations, timeoutMs } = effective("");
    return { maxContinuations, timeoutMs };
  },
  // A port it cannot have is a failure for the supervisor to see and back
  // off from, not a page that silently never appears.
  onError: (message) => {
    console.error(`dashboard-server: ${message}`);
    process.exit(1);
  },
  onListening: (url) => console.log(`dashboard-server: ${url} (state ${dirname(statusFile)})`),
});
