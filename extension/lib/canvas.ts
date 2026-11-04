// Session-scoped lifecycle for the jump-cannon canvas launchd agent
// (local.omp.autoLoop.jumpCannon.lifecycle = "omp"): the canvas runs while
// at least one interactive omp session holds a lease, and stops when the last
// one releases.
//
// Leases are files named `<pid>-<instance>` in one directory, so several
// extension instances in one process (subagents) each count, and a crashed
// session's lease is pruned by pid liveness instead of pinning the canvas up.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CanvasPorts {
  listLeases(): Promise<string[]>;
  addLease(name: string): Promise<void>;
  removeLease(name: string): Promise<void>;
  isAlive(pid: number): boolean;
  /** Start the agent if it is not running; a running agent is left alone. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function leasePid(name: string): number {
  return Number.parseInt(name.split("-", 1)[0]!, 10);
}

export class CanvasLifecycle {
  private held = false;
  private readonly ports: CanvasPorts;
  private readonly lease: string;

  constructor(ports: CanvasPorts, lease: string) {
    this.ports = ports;
    this.lease = lease;
  }

  async acquire(): Promise<void> {
    if (this.held) return;
    this.held = true;
    await this.ports.addLease(this.lease);
    await this.ports.start();
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await this.ports.removeLease(this.lease);
    if ((await this.liveLeases()).length > 0) return;
    await this.ports.stop();
    // A session that acquired between our check and the stop would be left
    // without a canvas; restart for it.
    if ((await this.liveLeases()).length > 0) await this.ports.start();
  }

  /** Live leases, removing those whose process has exited. */
  private async liveLeases(): Promise<string[]> {
    const live: string[] = [];
    for (const name of await this.ports.listLeases()) {
      if (this.ports.isAlive(leasePid(name))) live.push(name);
      else await this.ports.removeLease(name);
    }
    return live;
  }
}

/** Runs `launchctl` with the given arguments; rejects on a non-zero exit. */
export type Launchctl = (args: readonly string[]) => Promise<void>;

/**
 * Ports over a lease directory and the launchd agent `label` in the user's
 * GUI domain. `kickstart` without `-k` starts a stopped agent and leaves a
 * running one alone; the agent is KeepAlive=false under this lifecycle, so a
 * SIGTERM leaves it stopped.
 */
export function launchdCanvasPorts(opts: {
  label: string;
  leaseDir: string;
  uid: number;
  launchctl: Launchctl;
}): CanvasPorts {
  const target = `gui/${opts.uid}/${opts.label}`;
  return {
    async listLeases() {
      try {
        return await readdir(opts.leaseDir);
      } catch {
        return [];
      }
    },
    async addLease(name) {
      await mkdir(opts.leaseDir, { recursive: true });
      await writeFile(join(opts.leaseDir, name), "");
    },
    async removeLease(name) {
      await rm(join(opts.leaseDir, name), { force: true });
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    start: () => opts.launchctl(["kickstart", target]),
    stop: () => opts.launchctl(["kill", "SIGTERM", target]),
  };
}

/**
 * The canvas lifecycle for this extension instance, or undefined when the
 * module chose another lifecycle (no `canvas-agent` file holding the label).
 */
export function canvasFromConfig(opts: {
  canvasAgentFile: string;
  leaseDir: string;
  launchctl: Launchctl;
  readText?: (path: string) => string;
  pid?: number;
  uid?: number;
}): CanvasLifecycle | undefined {
  let label = "";
  try {
    label = (opts.readText ?? ((p) => readFileSync(p, "utf8")))(opts.canvasAgentFile).trim();
  } catch {
    return undefined;
  }
  if (!label) return undefined;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const ports = launchdCanvasPorts({ label, leaseDir: opts.leaseDir, uid, launchctl: opts.launchctl });
  return new CanvasLifecycle(ports, `${opts.pid ?? process.pid}-${randomUUID().slice(0, 8)}`);
}
