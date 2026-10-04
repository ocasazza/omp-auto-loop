// Graph projection: importer-safe records, sessions linked through shared
// repo/goal/gate nodes, and head-preserving compaction.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atom,
  createGraphProjection,
  idPart,
  ids,
  type SessionState,
} from "../extension/lib/observation.ts";
import { classify } from "../extension/lib/taxonomy.ts";

const REPO = { root: "/src/envoy-ai-gateway", name: "envoy-ai-gateway" };

const base: SessionState = {
  key: "k1",
  label: "jaeger#k1",
  cwd: "/ws/jaeger",
  agent: "main",
  parentKey: null,
  repo: REPO,
  goal: { objective: "ship the cleanup", status: "active" },
  gates: [],
  model: null,
  continuations: 2,
  maxContinuations: 3,
  heartbeats: 0,
  outcome: null,
};

const p = createGraphProjection();
const nodes = (text: string) => text.split("\n").filter((l) => l.startsWith("N|"));
const nodeIds = (text: string) => nodes(text).map((l) => l.split("|")[1]!);
const edges = (text: string) => text.split("\n").filter((l) => l.startsWith("E|"));

/** Connected components over the document's edges (undirected). */
function components(text: string): string[][] {
  const parent = new Map(nodeIds(text).map((id) => [id, id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const e of edges(text)) {
    const [, a, b] = e.split("|");
    parent.set(find(a!), find(b!));
  }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()];
}

test("atom strips the grammar's delimiters; idPart keeps ids URL-safe", () => {
  assert.equal(atom("a,b;c=d|e\nf"), "a b c d e f");
  assert.equal(atom("x".repeat(100)).length, 80);
  assert.equal(idPart("nixos-config#123/ab:c"), "nixos-config123abc");
});

test("classify maps messages to the event classes", () => {
  assert.equal(classify("autonomous continuation 1/3"), "continue");
  assert.equal(classify("gate failed (t)"), "gate");
  assert.equal(classify("goal set: x"), "goal");
  assert.equal(classify("settled: model reported AUTOLOOP:DONE"), "settled");
  assert.equal(classify("heartbeat: nudging idle session toward active goal"), "heartbeat");
  assert.equal(classify("whatever"), "other");
  // A settle whose reason names a gate is still a settle. Matching
  // includes("gate") first types it as a gate event, and replay resets the
  // budget on "settled" -- so that reset would be missed entirely.
  assert.equal(classify("settled: gate_retries_exhausted"), "settled");
  // A goal that merely mentions a gate is a goal, not a gate event.
  assert.equal(classify("goal set: add a gate to the release flow"), "goal");
});

test("a goal whose text merely mentions a gate is still a goal event", () => {
  // Regression: classify() used to test includes("gate") before the anchored
  // prefixes, so any goal objective containing the word "gate" was typed as a
  // gate event. On the host's 806-event log that mis-typed 11 real goal events,
  // which quietly corrupts every metric keyed on the event class.
  assert.equal(
    classify("goal set: Close the one unverified gate on PR #87: get cargo test to pass"),
    "goal",
  );
  assert.equal(classify("goal complete"), "goal");
  assert.equal(classify("gates passed — settling"), "gate");
  assert.equal(classify("gate failed (pytest -q, attempt 1) — continuing"), "gate");
});

test("the hub carries the session's live state as data", () => {
  const text = p.apply("", { ...base, model: "anthropic/opus", heartbeats: 2, outcome: "headless" }, "goal set: x", "t");
  assert.equal(
    nodes(text)[0],
    "N|sk1|jaeger#k1|session|active-goal,main,headless|cwd=/ws/jaeger;continuations=2;max_continuations=3;heartbeats=2;model=anthropic/opus|ship the cleanup",
  );
});

test("sessions in worktrees of one repo, or on one goal, join one component", () => {
  let text = p.apply("", base, "goal set: ship the cleanup", "t");
  // Another worktree of the same repo, different goal.
  text = p.apply(text, { ...base, key: "k2", label: "pufferfish#k2", cwd: "/ws/pufferfish", goal: null }, "settled: headless", "t");
  // A different repo, same goal.
  text = p.apply(text, { ...base, key: "k3", label: "other#k3", repo: { root: "/src/other", name: "other" } }, "autonomous continuation 1/3", "t");
  // Unrelated: no repo, no goal.
  text = p.apply(text, { ...base, key: "k4", label: "tmp#k4", repo: null, goal: null }, "settled: error", "t");
  const comps = components(text);
  const withK1 = comps.find((c) => c.includes("sk1"))!;
  assert.ok(withK1.includes("sk2"), "same repo links k1 and k2");
  assert.ok(withK1.includes("sk3"), "same goal links k1 and k3");
  assert.ok(!withK1.includes("sk4"), "an unrelated session stays apart");
  assert.equal(nodeIds(text).filter((id) => id === ids.repo(REPO)).length, 1, "the shared repo node is emitted once");
});

test("re-applying upserts every node in place: no duplicate ids, state current", () => {
  let text = p.apply("", base, "goal set: ship the cleanup", "t");
  text = p.apply(text, { ...base, continuations: 3, goal: { objective: "ship the cleanup", status: "complete" } }, "goal complete", "t");
  const all = nodeIds(text);
  assert.equal(new Set(all).size, all.length, "the importer rejects duplicate ids");
  assert.match(nodes(text).find((l) => l.startsWith("N|sk1|"))!, /continuations=3;/);
  assert.match(nodes(text).find((l) => l.startsWith(`N|${ids.goal("ship the cleanup")}|`))!, /\|goal\|complete\|/);
});

test("events chain in order; heartbeats bump the hub instead of adding nodes", () => {
  let text = p.apply("", base, "autonomous continuation 1/3", "t");
  text = p.apply(text, { ...base, heartbeats: 1 }, "heartbeat: nudging idle session toward active goal", "t");
  text = p.apply(text, base, "autonomous continuation 2/3", "t");
  assert.deepEqual(nodeIds(text).filter((id) => id.startsWith("e")), ["ek1_1", "ek1_2"]);
  assert.ok(edges(text).includes("E|ek1_1|ek1_2|next"), "consecutive events are chained");
  assert.ok(edges(text).includes("E|sk1|ek1_2|emitted"));
});

test("a subagent links to its parent only when the parent hub exists", () => {
  const sub: SessionState = { ...base, key: "k9", agent: "sub", parentKey: "k1" };
  assert.ok(!edges(p.apply("", sub, "settled: headless", "t")).some((e) => e.startsWith("E|sk1|sk9")), "no dangling edge");
  const text = p.apply(p.apply("", base, "goal set: x", "t"), sub, "settled: headless", "t");
  assert.ok(edges(text).includes("E|sk1|sk9|spawned"));
});

test("gate commands become shared nodes", () => {
  const text = p.apply("", { ...base, gates: ["nix flake check"] }, "gate failed (nix flake check) — attempt 1", "t");
  const gate = ids.gate("nix flake check");
  assert.ok(nodes(text).some((l) => l.startsWith(`N|${gate}|nix flake check|gate||`)));
  assert.ok(edges(text).includes(`E|sk1|${gate}|runs_gate`));
});

test("a message with newlines and delimiters stays one record", () => {
  const text = p.apply("", base, "gate failed (t)\nstderr: boom | x=1", "2026-01-01T00:00:00.000Z");
  assert.equal(
    nodes(text).find((l) => l.startsWith("N|ek1_1|")),
    "N|ek1_1|gate failed (t) stderr: boom   x 1|event|gate|ts=2026-01-01T00:00:00.000Z;sess=jaeger#k1|gate failed (t) stderr: boom | x=1",
  );
});

test("event ids never repeat after compaction drops older events", () => {
  let text = "";
  const seen: string[] = [];
  for (let i = 1; i <= 30; i++) {
    text = p.compact(p.apply(text, base, `continuation ${i}`, "t"), 12);
    seen.push(nodeIds(text).filter((id) => id.startsWith("e")).at(-1)!);
  }
  assert.equal(new Set(seen).size, seen.length, `a duplicate id would reject the document: ${seen.join(",")}`);
  assert.equal(seen.at(-1), "ek1_30");
});

test("compaction keeps hubs and shared nodes, stays under the cap, leaves no dangling edge", () => {
  let text = "";
  for (let i = 1; i <= 20; i++) text = p.apply(text, base, `continuation ${i}`, "t");
  const compacted = p.compact(text, 10);
  const kept = compacted.split("\n").filter(Boolean);
  assert.ok(kept.length <= 10, `stays within maxLines, got ${kept.length}`);
  const keptIds = new Set(nodeIds(compacted));
  for (const id of ["sk1", ids.repo(REPO), ids.goal("ship the cleanup")]) assert.ok(keptIds.has(id), `${id} survives`);
  assert.ok(keptIds.has("ek1_20"), "the newest event survives");
  for (const e of edges(compacted)) {
    const [, a, b] = e.split("|");
    assert.ok(keptIds.has(a!) && keptIds.has(b!), `edge ${e} must have both endpoints`);
  }
});

test("compaction is a no-op under the cap", () => {
  const text = p.apply("", base, "goal set: x", "t");
  assert.equal(p.compact(text, 100), text);
});

test("every edge carries its declared kind; a typed edge supersedes a legacy untyped one", () => {
  const legacy = `N|sk1|x|session|no-goal|cwd=/x\nN|${ids.repo(REPO)}|r|repo|r|root=/r\nE|sk1|${ids.repo(REPO)}\n`;
  const text = p.apply(legacy, base, "goal set: ship the cleanup", "t");
  const kinds = new Set(["in_repo", "pursues", "runs_gate", "spawned", "emitted", "next"]);
  for (const e of edges(text)) assert.ok(kinds.has(e.split("|")[3]!), `untyped or unknown edge: ${e}`);
  assert.deepEqual(edges(text).filter((e) => e.startsWith(`E|sk1|${ids.repo(REPO)}`)), [`E|sk1|${ids.repo(REPO)}|in_repo`]);
});

test("untyped lines from an older extension are typed on the next write", () => {
  const legacy = [
    "N|sk7|old|session|no-goal|cwd=/o",
    "N|ek7_1|a|event|continue|ts=t",
    "N|ek7_2|b|event|continue|ts=t",
    "E|sk7|ek7_1",
    "E|ek7_1|ek7_2",
  ].join("\n") + "\n";
  const text = p.apply(legacy, base, "goal set: x", "t");
  assert.ok(edges(text).includes("E|sk7|ek7_1|emitted"));
  assert.ok(edges(text).includes("E|ek7_1|ek7_2|next"));
});

// Regression: a node with an empty title rejects the whole document under the
// importer's `field` rule (one or more characters), which is how the canvas
// stayed down until the record was removed by hand.
function grammarClean(text: string): string[] {
  const bad: string[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    if (!line.startsWith("N|")) continue;
    const [, id, title, kind] = line.split("|");
    if (!id || !title || !kind) bad.push(line);
  }
  return bad;
}

test("a goal with no objective produces no node and no edge", () => {
  const text = p.apply("", { ...base, goal: { objective: "", status: "paused" } }, "goal set: x", "t");
  expect(grammarClean(text)).toEqual([]);
  expect(!edges(text).some((e) => e.includes("|pursues"))).toBe(true);
  expect(nodes(text).some((l) => l.startsWith("N|sk1|"))).toBe(true);
});

test("a blank gate command is dropped, not emitted empty", () => {
  const text = p.apply("", { ...base, gates: ["  "] }, "gate failed", "t");
  expect(grammarClean(text)).toEqual([]);
  expect(!edges(text).some((e) => e.endsWith("|runs_gate"))).toBe(true);
});

test("a document already poisoned on disk heals on the next write", () => {
  const poisoned = [
    "N|sk1|jaeger#k1|session|no-goal|cwd=/ws/jaeger",
    "N|g811c9dc5||goal|paused|",
    "E|sk1|g811c9dc5|pursues",
    "",
  ].join("\n");
  const text = p.apply(poisoned, base, "goal set: ship the cleanup", "t");
  expect(grammarClean(text)).toEqual([]);
  expect(!nodes(text).some((l) => l.startsWith("N|g811c9dc5|"))).toBe(true);
  expect(!edges(text).some((e) => e.includes("g811c9dc5"))).toBe(true);
});
