// The panel-kit site API: GET /api/trace and GET /api/site, and the writes the
// panel-kit host POSTs back (examples/autoloop.rs against this server).
//
// The conformance target is panel-kit's own fixture, copied into test/fixtures/
// from panel-kit nix/data/ (the grammars there parse what these routes serve):
// projecting the fixture's policy, events and projection must reproduce the
// fixture record for record, and a write must land as the PolicyOp the loop
// already understands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeOp, type PolicyOp } from "../extension/lib/policy.ts";

const TRACE_LINES = readFileSync(new URL("./fixtures/autoloop-trace.lines", import.meta.url), "utf8");

const withDashboard = async (
  options: {
    readProjection?: () => string;
    readEvents?: () => string;
    readPolicy?: () => string;
    writePolicy?: (op: PolicyOp) => void;
    steer?: (c: { target: string; action: string; value?: string }) => void;
    limits?: () => { maxContinuations: number; timeoutMs: number };
  },
  run: (base: string) => Promise<void>,
) => {
  const { createDashboard } = await import("../extension/lib/dashboard.ts"); // mirrors dashboard.test.ts: the module lazy-imports node:http itself
  const http = await import("node:http");
  // Take a port the way the other route tests do: bind a probe, free it, reuse it.
  const probe = http.createServer(() => {});
  const bound = Promise.withResolvers<void>();
  probe.listen(0, "127.0.0.1", () => bound.resolve());
  await bound.promise;
  const address = probe.address() as { port: number }; // a TCP listen always answers with AddressInfo
  const { port } = address;
  const freed = Promise.withResolvers<void>();
  probe.close(() => freed.resolve());
  await freed.promise;

  const listening = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  const dashboard = createDashboard({
    port,
    readProjection: () => "",
    ...options,
    // The real signal, not a guessed delay: the port is actually bound.
    onListening: () => listening.resolve(),
    onError: (message) => failed.reject(new Error(message)),
  });
  try {
    await Promise.race([listening.promise, failed.promise]);
    await run(`http://127.0.0.1:${port}`);
  } finally {
    dashboard.close();
  }
};

test("GET /api/trace returns the projection text the trace grammar parses", async () => {
  await withDashboard({ readProjection: () => TRACE_LINES }, async (base) => {
    const response = await fetch(`${base}/api/trace`);

    assert.equal(response.status, 200);
    assert.ok((response.headers.get("content-type") ?? "").includes("text/plain"));
    assert.equal(await response.text(), TRACE_LINES);
  });
});
