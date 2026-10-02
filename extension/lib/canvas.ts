// Session-scoped lifecycle for the jump-cannon canvas launchd agent
// (local.omp.autoLoop.jumpCannon.lifecycle = "omp"): the canvas runs while
// at least one interactive omp session holds a lease, and stops when the last
// one releases.
//
// Leases are files named `<pid>-<instance>` in one directory, so several
// extension instances in one process (subagents) each count, and a crashed
// session's lease is pruned by pid liveness instead of pinning the canvas up.

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
