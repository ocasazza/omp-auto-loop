// Canvas lifecycle (jumpCannon.lifecycle = "omp"): the agent runs while any
// interactive session holds a lease and stops after the last one releases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasLifecycle, canvasFromConfig, type CanvasPorts } from "../extension/lib/canvas.ts";

function host(alive: Set<number>) {
  const leases = new Set<string>();
  const calls: string[] = [];
  const ports: CanvasPorts = {
    listLeases: async () => [...leases],
    addLease: async (n) => void leases.add(n),
    removeLease: async (n) => void leases.delete(n),
    isAlive: (pid) => alive.has(pid),
    start: async () => void calls.push("start"),
    stop: async () => void calls.push("stop"),
  };
  return { ports, leases, calls };
}

test("the canvas stops only when the last live session releases", async () => {
  const h = host(new Set([1, 2]));
  const a = new CanvasLifecycle(h.ports, "1-a");
  const b = new CanvasLifecycle(h.ports, "2-b");
  await a.acquire();
  await b.acquire();
  await a.release();
  assert.deepEqual(h.calls, ["start", "start"], "another session still holds the canvas");
  await b.release();
  assert.deepEqual(h.calls, ["start", "start", "stop"]);
  assert.equal(h.leases.size, 0);
});

test("two instances in one process (a subagent) hold separate leases", async () => {
  const h = host(new Set([1]));
  const main = new CanvasLifecycle(h.ports, "1-main");
  const sub = new CanvasLifecycle(h.ports, "1-sub");
  await main.acquire();
  await sub.acquire();
  await sub.release();
  assert.ok(!h.calls.includes("stop"), "the subagent exiting must not stop the main session's canvas");
});

test("a crashed session's lease is pruned instead of keeping the canvas up", async () => {
  const h = host(new Set([2]));
  h.leases.add("1-crashed");
  const b = new CanvasLifecycle(h.ports, "2-b");
  await b.acquire();
  await b.release();
  assert.deepEqual(h.calls, ["start", "stop"]);
  assert.equal(h.leases.size, 0);
});

test("release without acquire is a no-op; acquire is idempotent", async () => {
  const h = host(new Set([1]));
  const a = new CanvasLifecycle(h.ports, "1-a");
  await a.release();
  await a.acquire();
  await a.acquire();
  assert.deepEqual(h.calls, ["start"]);
});

test("no canvas-agent file means the module chose another lifecycle", () => {
  const canvas = canvasFromConfig({
    canvasAgentFile: "/nonexistent/canvas-agent",
    leaseDir: "/nonexistent/leases",
    launchctl: async () => assert.fail("launchctl must not run"),
  });
  assert.equal(canvas, undefined);
});

test("launchd ports lease, kickstart, and stop the labelled agent in the GUI domain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-"));
  const calls: string[][] = [];
  const launchctl = async (args: readonly string[]) => void calls.push([...args]);
  const make = (pid: number) =>
    canvasFromConfig({
      canvasAgentFile: "label-file",
      readText: () => "local.omp-auto-loop-jump-cannon\n",
      leaseDir: dir,
      launchctl,
      pid,
      uid: 501,
    })!;
  const target = "gui/501/local.omp-auto-loop-jump-cannon";
  const first = make(process.pid);
  const second = make(process.pid);

  await first.acquire();
  await second.acquire();
  assert.equal(readdirSync(dir).length, 2);
  assert.deepEqual(calls, [["kickstart", target], ["kickstart", target]]);

  await first.release();
  assert.deepEqual(calls.at(-1), ["kickstart", target], "a live lease keeps the canvas running");
  await second.release();
  assert.deepEqual(calls.at(-1), ["kill", "SIGTERM", target]);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
