// Canvas lifecycle (jumpCannon.lifecycle = "omp"): the agent runs while any
// interactive session holds a lease and stops after the last one releases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasLifecycle, type CanvasPorts } from "../extension/lib/canvas.ts";

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
