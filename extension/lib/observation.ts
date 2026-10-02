// Serialized asynchronous observation sink + importer-safe graph projection.
//
// Why async and serialized: the settle handler runs on the TUI event loop, and
// the shipped v1 wrote events and graph lines synchronously (sync writes plus
// three git subprocesses per settle). Here the sink serializes work through a
// single queue so ordering is preserved (the jump-cannon importer is
// order-sensitive) while the handler never blocks on disk.
//
// Graph shape (the data contract of the jump-cannon OMP Auto-Loop topos):
// sessions are keyed by omp session id, and link through shared nodes — the
// repository they work in, the goal they pursue, the gates they run, and the
// session that spawned them — so work on the same thing forms one connected
// component instead of one isolated star per process. Every node is upserted
// in place by id: the importer rejects a document with a duplicate id.

import type { FsPort } from "./ports.ts";

export type EventClass =
  | "continue"
  | "gate"
  | "goal"
  | "heartbeat"
  | "settled"
  | "other";

export function classify(msg: string): EventClass {
  if (msg.startsWith("autonomous continuation")) return "continue";
  // Anchor on the two gate messages the loop actually emits (see the note()
  // call sites in auto-loop.ts: "gate failed ... -- continuing" and "gates
  // passed -- settling"). A bare includes("gate") also matched any goal whose
  // objective merely mentioned a gate, so real goal events were typed as gate
  // events -- which silently corrupts anything keyed on the event class.
  if (msg.startsWith("gate failed") || msg.startsWith("gates passed")) {
    return "gate";
  }
  if (msg.startsWith("goal")) return "goal";
  if (msg.startsWith("heartbeat")) return "heartbeat";
  if (msg.startsWith("settled")) return "settled";
  return "other";
}

/** Grammar-safe atom: the pest field/atom rules exclude , ; = | and newline. */
export function atom(text: string, max = 80): string {
  return text.replace(/[,;|=\r\n]/g, " ").slice(0, max);
}

/** Grammar- and URL-safe id fragment (no `#`, which truncates /node/<id>). */
export function idPart(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "");
}

/** Stable short id for shared nodes (FNV-1a, 32-bit, hex). */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The body carries raw content; presentation belongs to the jump-cannon topos
 * (knowledge/OMP Auto-Loop Topos.md), never this producer. The pest body_text
 * rule stops at the first newline, so newlines collapse; an empty body is
 * omitted because body_text needs at least one character.
 */
function withBody(record: string, text: string): string {
  const body = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return body.length > 0 ? `${record}|${body}` : record;
}

export interface RepoRef {
  /** Absolute root of the shared git dir, so worktrees of one repo coincide. */
  readonly root: string;
  readonly name: string;
}

export interface GoalRef {
  readonly objective: string;
  readonly status: "active" | "paused" | "complete";
}

/** Everything the projection knows about one session at one event. */
export interface SessionState {
  /** omp session id (sanitized); stable across restarts and resumes. */
  readonly key: string;
  readonly label: string;
  readonly cwd: string;
  readonly agent: "main" | "sub";
  /** Session key of the spawning session, when it is known to this process. */
  readonly parentKey: string | null;
  readonly repo: RepoRef | null;
  readonly goal: GoalRef | null;
  readonly gates: readonly string[];
  readonly model: string | null;
  readonly continuations: number;
  readonly maxContinuations: number;
  /** Idle nudges so far; heartbeats are counted here, not emitted as nodes. */
  readonly heartbeats: number;
  /** How the last cycle settled (e.g. `verified`, `headless`, `error`). */
  readonly outcome: string | null;
}

export const ids = {
  session: (key: string) => `s${key}`,
  event: (key: string, seq: number) => `e${key}_${seq}`,
  repo: (repo: RepoRef) => `r${stableHash(repo.root)}`,
  goal: (objective: string) => `g${stableHash(objective.trim())}`,
  gate: (command: string) => `c${stableHash(command.trim())}`,
};

export interface GraphProjection {
  /**
   * Apply one event to the document: upsert the session hub and the shared
   * repo/goal/gate nodes it links to, add the event (heartbeats only bump the
   * hub's count), and chain it to the session's previous event.
   */
  apply(existing: string, session: SessionState, msg: string, ts: string): string;
  /**
   * Head-preserving compaction: drop the oldest EVENT nodes, never a hub or a
   * shared node, and never keep an edge whose endpoint was dropped.
   */
  compact(existing: string, maxLines: number): string;
}

const nodeId = (line: string) => line.split("|")[1]!;
const nodeKind = (line: string) => line.split("|")[3]!;

/**
 * The importer's `field` rule matches one or more characters, so a node with
 * an empty id, title, or kind rejects the entire document and the canvas
 * refuses to start. Producers must not write one.
 */
function representable(line: string): boolean {
  const [, id, title, kind] = line.split("|");
  return Boolean(id && title && kind);
}
/** Edge kinds, declared as `[[schema.edge_types]]` in the omp-auto-loop package. */
export type EdgeKind = "in_repo" | "pursues" | "runs_gate" | "spawned" | "emitted" | "next";

/** The kind an edge between these node kinds carries (see apply()). */
export function inferEdgeKind(source: string | undefined, target: string | undefined): EdgeKind | null {
  if (source === "event") return target === "event" ? "next" : null;
  if (source !== "session") return null;
  switch (target) {
    case "repo":
      return "in_repo";
    case "goal":
      return "pursues";
    case "gate":
      return "runs_gate";
    case "session":
      return "spawned";
    case "event":
      return "emitted";
    default:
      return null;
  }
}

const endpoints = (edge: string) => edge.split("|").slice(1, 3) as [string, string];

/** A document as ordered node lines (upsert by id) plus a deduped edge list. */
class Doc {
  private readonly nodes: string[] = [];
  private readonly nodeIndex = new Map<string, number>();
  private readonly edges: string[] = [];
  private readonly edgeIndex = new Map<string, number>();

  constructor(text: string) {
    const lines = text.split("\n");
    for (const line of lines) if (line.startsWith("N|")) this.upsert(line);
    const kindOf = new Map(this.nodes.map((l) => [nodeId(l), nodeKind(l)]));
    for (const line of lines) {
      if (!line.startsWith("E|")) continue;
      const [source, target] = endpoints(line);
      // A record the importer would reject is dropped on read, so a document
      // already poisoned on disk heals on the next write instead of keeping
      // the canvas down forever.
      if (!kindOf.has(source) || !kindOf.has(target)) continue;
      // An untyped line (written by an older extension) gets the kind its
      // endpoint kinds imply, so the document heals on the next write.
      const kind =
        (line.split("|")[3] as EdgeKind | undefined) ??
        inferEdgeKind(kindOf.get(source), kindOf.get(target));
      this.link(source, target, kind);
    }
  }

  has(id: string): boolean {
    return this.nodeIndex.has(id);
  }

  /**
   * Upsert a node, or drop it when a required field is empty. Returns whether
   * the node is in the document, so a caller never links an edge to a node the
   * importer will reject.
   */
  upsert(line: string): boolean {
    if (!representable(line)) return false;
    const id = nodeId(line);
    const at = this.nodeIndex.get(id);
    if (at === undefined) {
      this.nodeIndex.set(id, this.nodes.length);
      this.nodes.push(line);
    } else {
      this.nodes[at] = line;
    }
    return true;
  }


  /** One edge per (source, target); the kind is an attribute, not identity. */
  link(source: string, target: string, kind: EdgeKind | null): void {
    const key = `${source}|${target}`;
    const edge = kind ? `E|${key}|${kind}` : `E|${key}`;
    const at = this.edgeIndex.get(key);
    if (at === undefined) {
      this.edgeIndex.set(key, this.edges.length);
      this.edges.push(edge);
    } else if (kind) {
      // A typed edge supersedes a legacy untyped line for the same endpoints.
      this.edges[at] = edge;
    }
  }

  /** Highest event sequence this session has on file (0 when none). */
  lastSeq(key: string): number {
    const prefix = `e${key}_`;
    let max = 0;
    for (const id of this.nodeIndex.keys()) {
      if (!id.startsWith(prefix)) continue;
      const seq = Number.parseInt(id.slice(prefix.length), 10);
      if (seq > max) max = seq;
    }
    return max;
  }

  toString(): string {
    // Nodes precede edges so every edge's endpoints are declared first.
    return [...this.nodes, ...this.edges].join("\n") + "\n";
  }
}

export function createGraphProjection(): GraphProjection {
  return {
    apply(existing, s, msg, ts) {
      const doc = new Doc(existing);
      const hub = ids.session(s.key);
      const cls = classify(msg);

      const tags = [
        s.goal?.status === "active" ? "active-goal" : "no-goal",
        s.agent,
        ...(s.outcome ? [atom(s.outcome, 40)] : []),
      ];
      const props = [
        `cwd=${atom(s.cwd, 200)}`,
        `continuations=${s.continuations}`,
        `max_continuations=${s.maxContinuations}`,
        `heartbeats=${s.heartbeats}`,
        ...(s.model ? [`model=${atom(s.model)}`] : []),
      ];
      doc.upsert(
        withBody(
          `N|${hub}|${atom(s.label)}|session|${tags.join(",")}|${props.join(";")}`,
          s.goal?.objective ?? "",
        ),
      );

      if (s.repo) {
        const repo = ids.repo(s.repo);
        doc.upsert(`N|${repo}|${atom(s.repo.name)}|repo|${atom(s.repo.name)}|root=${atom(s.repo.root, 200)}`);
        doc.link(hub, repo, "in_repo");
      }
      // An edge to a node the importer would reject is itself rejected, so
      // every link below is conditional on the node having been stored. Blank
      // text is not a record: `atom` keeps spaces, which the grammar admits
      // but which names nothing.
      if (s.goal && s.goal.objective.trim()) {
        const goal = ids.goal(s.goal.objective);
        if (doc.upsert(withBody(`N|${goal}|${atom(s.goal.objective)}|goal|${s.goal.status}|`, s.goal.objective))) {
          doc.link(hub, goal, "pursues");
        }
      }
      for (const command of s.gates) {
        if (!command.trim()) continue;
        const gate = ids.gate(command);
        if (doc.upsert(withBody(`N|${gate}|${atom(command)}|gate||`, command))) {
          doc.link(hub, gate, "runs_gate");
        }
      }
      // Only link a parent the document already has: no dangling edges.
      if (s.parentKey && doc.has(ids.session(s.parentKey))) {
        doc.link(ids.session(s.parentKey), hub, "spawned");
      }

      if (cls !== "heartbeat") {
        const last = doc.lastSeq(s.key);
        const event = ids.event(s.key, last + 1);
        if (
          doc.upsert(
            withBody(`N|${event}|${atom(msg)}|event|${cls}|ts=${atom(ts)};sess=${atom(s.label)}`, msg),
          )
        ) {
          doc.link(hub, event, "emitted");
          const previous = ids.event(s.key, last);
          if (last > 0 && doc.has(previous)) doc.link(previous, event, "next");
        }
      }
      return doc.toString();
    },

    compact(existing, maxLines) {
      const lines = existing.split("\n").filter((l) => l.length > 0);
      if (lines.length <= maxLines) return existing;
      const nodes = lines.filter((l) => l.startsWith("N|"));
      const edges = lines.filter((l) => l.startsWith("E|"));
      const persistent = nodes.filter((l) => nodeKind(l) !== "event");
      const events = nodes.filter((l) => nodeKind(l) === "event");
      const persistentIds = new Set(persistent.map(nodeId));
      // Edges among persistent nodes always survive; count them up front.
      const fixedEdges = edges.filter((e) => endpoints(e).every((id) => persistentIds.has(id)));
      const edgesByTarget = new Map<string, number>();
      for (const e of edges) {
        const [, target] = endpoints(e);
        if (!persistentIds.has(target)) edgesByTarget.set(target, (edgesByTarget.get(target) ?? 0) + 1);
      }
      // Newest events first, each paying for itself plus its incoming edges,
      // so the result stays within maxLines.
      let budget = maxLines - persistent.length - fixedEdges.length;
      const keptIds = new Set(persistentIds);
      for (let i = events.length - 1; i >= 0; i--) {
        const id = nodeId(events[i]!);
        const cost = 1 + (edgesByTarget.get(id) ?? 0);
        if (cost > budget) break;
        budget -= cost;
        keptIds.add(id);
      }
      const keptEvents = events.filter((l) => keptIds.has(nodeId(l)));
      const keptEdges = edges.filter((e) => endpoints(e).every((id) => keptIds.has(id)));
      return [...persistent, ...keptEvents, ...keptEdges].join("\n") + "\n";
    },
  };
}

export interface ObservationConfig {
  readonly stateDir: string;
  readonly sessionLabel: string;
  readonly maxGraphLines: number;
}

/**
 * A single-slot writer that serializes all observation work. `emit` never
 * blocks the caller; ordering is preserved because the queue is FIFO and each
 * drain awaits the previous task.
 */
export class ObservationSink {
  private queue: Promise<void> = Promise.resolve();
  private lastEventTs = "";
  private startedAtMs: number;
  private readonly fs: FsPort;
  private readonly cfg: ObservationConfig;
  private readonly graph: GraphProjection;

  constructor(fs: FsPort, cfg: ObservationConfig, graph: GraphProjection, nowMs: number) {
    this.fs = fs;
    this.cfg = cfg;
    this.graph = graph;
    this.startedAtMs = nowMs;
  }

  private get eventsFile(): string {
    return `${this.cfg.stateDir}/events.jsonl`;
  }
  private get graphFile(): string {
    return `${this.cfg.stateDir}/graph.lines`;
  }

  /**
   * Enqueue an observation write; returns immediately. `session` is captured
   * now, so the hub shows the state as of this event even if it changes
   * before the queue drains.
   */
  emit(msg: string, nowMs: number, session: SessionState): void {
    this.lastEventTs = new Date(nowMs).toISOString();
    const msgCopy = msg;
    const ts = this.lastEventTs;
    const state = { ...session };
    this.queue = this.queue.then(async () => {
      await this.fs.mkdirp(this.cfg.stateDir).catch(() => {});
      await this.fs.appendFile(
        this.eventsFile,
        JSON.stringify({
          ts,
          session: this.cfg.sessionLabel,
          kind: classify(msgCopy),
          msg: msgCopy,
        }) + "\n",
      );
      // Every session (and every subagent instance in one process) rewrites
      // this one file; without the lock, concurrent rewrites drop each
      // other's events. The rename keeps the importer's watcher from reading
      // a half-written document.
      await withLock(this.fs, `${this.graphFile}.lock`, async () => {
        const existing = (await this.fs.readFile(this.graphFile)) ?? "";
        const next = this.graph.compact(this.graph.apply(existing, state, msgCopy, ts), this.cfg.maxGraphLines);
        const tmp = `${this.graphFile}.${this.cfg.sessionLabel.replace(/[^A-Za-z0-9_-]/g, "")}.${nowMs}.tmp`;
        await this.fs.writeFile(tmp, next);
        await this.fs.rename(tmp, this.graphFile);
      });
    }).catch(() => {});
  }

  /** Await drain — for tests and shutdown. */
  async drain(): Promise<void> {
    await this.queue;
  }

  get startedAt(): number {
    return this.startedAtMs;
  }
}

/** A lock older than this is from a crashed writer and is broken. */
const LOCK_STALE_MS = 10_000;
/** Give up (skip this graph write; the event log still has it) after this. */
const LOCK_WAIT_MS = 5_000;

/** Run `fn` holding an exclusive lock file; skip it if the lock never frees. */
export async function withLock(fs: FsPort, path: string, fn: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await fs.createExclusive(path))) {
    const st = await fs.stat(path);
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      await fs.unlink(path);
      continue;
    }
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  }
  try {
    await fn();
  } finally {
    await fs.unlink(path);
  }
}
