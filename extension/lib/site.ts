// The loop's control site for panel-kit: what `GET /api/site` serves and how a
// written edit becomes policy again.
//
// panel-kit's autoloop host (examples/autoloop.rs) reads `GET /api/trace` (the
// graph.lines projection, parsed by the autoloop-trace grammar) and this JSON
// (parsed by the autoloop-control grammar), glues the two sites along `repo`,
// and paints the loop's control tables. A written edit POSTs the emitter's
// revision of one record — fields stringly typed, exactly as the grammar's
// field model stores them — and `translateSiteEdit` turns it back into the
// PolicyOp (and, for an overturned claim, the reopen steering command) the
// loop already understands.
//
// The shape is fixed on the panel-kit side: nix/grammars/autoloop-control.nix
// declares the members and the field list (an undeclared field is dropped on
// parse, and the emitter refuses to write one), and nix/data/
// autoloop-control.json is the conformance fixture the site test compares
// against. The repo records mirror the projection's repo nodes exactly —
// id, title, tags and root — because the host's glue identifies equal-id repo
// objects and refuses a disagreement.
//
// Pure: text in, data out, like the rest of lib/.

import {
  DEFAULT_FLAGS,
  DEFAULT_PROMPTS,
  PARAMS,
  PROMPTS,
  reviewQueue,
  vocabulary,
  type Policy,
  type Vocabulary,
} from "./policy.ts";
import { classify } from "./taxonomy.ts";

/** The limits a session without its own override runs with, as the site shows them. */
export interface SiteLimits {
  readonly maxContinuations: number;
  readonly timeoutMs: number;
}

/** One record of the site: id/title/sort/tags, plus the grammar's stringly fields. */
export type SiteRecord = {
  readonly id: string;
  readonly title: string;
  readonly sort: string;
  readonly tags: readonly string[];
} & Readonly<Record<string, string | readonly string[]>>;

export interface SiteMorphism {
  readonly domain: string;
  readonly codomain: string;
  readonly sort: string;
}

export interface ControlSite {
  readonly objects: readonly SiteRecord[];
  readonly morphisms: readonly SiteMorphism[];
}

const VOCABULARY_ORDER: readonly Vocabulary[] = ["event", "settle", "decision", "edge"];

interface SiteEvent {
  readonly ts: string;
  readonly session: string;
  /** Absent in logs written before the field existed. */
  readonly kind: string | undefined;
  readonly msg: string;
}

/** The one parse of the event log the site needs; mirrors dashboard.ts's. */
function readSiteEvents(text: string): SiteEvent[] {
  const rows: SiteEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const { ts, session, kind, msg } = record;
    if (typeof ts !== "string" || typeof msg !== "string") continue;
    rows.push({
      ts,
      session: typeof session === "string" ? session : "",
      kind: typeof kind === "string" ? kind : undefined,
      msg,
    });
  }
  return rows;
}

interface RepoNode {
  readonly id: string;
  readonly tags: readonly string[];
  readonly root: string | undefined;
}

/** The projection's repo nodes, keyed by name — the records the host's glue must match. */
function readRepos(projection: string): Map<string, RepoNode> {
  const repos = new Map<string, RepoNode>();
  for (const line of projection.split("\n")) {
    if (!line.startsWith("N|")) continue;
    const parts = line.split("|");
    if (parts[3] !== "repo") continue;
    const name = parts[2] ?? "";
    if (!name || repos.has(name)) continue;
    const props = new Map(
      (parts[5] ?? "")
        .split(";")
        .filter(Boolean)
        .map((pair): [string, string] => {
          const at = pair.indexOf("=");
          return at === -1 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
        }),
    );
    repos.set(name, {
      id: parts[1] ?? "",
      tags: (parts[4] ?? "").split(",").filter(Boolean),
      root: props.get("root"),
    });
  }
  return repos;
}

/**
 * Build the control site from the loop's state files: the review queue as
 * claims, the folded policy as proposals, queue, repo policies, terms, params
 * and prompts, and the projection's repo nodes mirrored so the host can glue.
 */
export function projectSite(input: {
  projection: string;
  events: string;
  policy: Policy;
  limits: SiteLimits;
}): ControlSite {
  const { projection, policy, limits } = input;
  const events = readSiteEvents(input.events);
  const repos = readRepos(projection);

  // Live counts, the same fold taxonomyReport does: every event counts under
  // its class (the recorded kind is authoritative; pre-kind logs classify by
  // message), and a settle also counts under the reason it recorded.
  const classCounts = new Map<string, number>();
  const settleCounts = new Map<string, number>();
  for (const event of events) {
    const cls = event.kind ?? classify(event.msg);
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    if (event.msg.startsWith("settled: ")) {
      const reason = event.msg.slice("settled: ".length).trim();
      settleCounts.set(reason, (settleCounts.get(reason) ?? 0) + 1);
    }
  }

  const objects: SiteRecord[] = [];
  const revises: SiteMorphism[] = [];
  const targets: SiteMorphism[] = [];
  const governs: SiteMorphism[] = [];

  // Claims — the review queue, newest first, as reviewQueue orders it.
  for (const verdict of reviewQueue(events, policy)) {
    objects.push({
      id: `claim:${verdict.id}`,
      title: verdict.goal,
      sort: "claim",
      tags: [verdict.reason, verdict.ratification ? verdict.ratification.decision : "unreviewed"],
      session: verdict.session,
      ts: verdict.ts,
      reason: verdict.reason,
      judge: verdict.judge,
      decision: verdict.ratification?.decision ?? "",
      note: verdict.ratification?.note ?? "",
    });
  }

  // Proposals — titled by what they revise, with one revises edge each.
  for (const proposal of policy.proposals) {
    const spec =
      proposal.target.kind === "prompt"
        ? PROMPTS.find((p) => p.key === proposal.target.key)
        : PARAMS.find((p) => p.key === proposal.target.key);
    const target = `${proposal.target.kind}:${proposal.target.key}`;
    objects.push({
      id: `proposal:${proposal.id}`,
      title: spec?.label ?? target,
      sort: "proposal",
      tags: [proposal.status],
      status: proposal.status,
      target,
      before: proposal.before === null ? "" : String(proposal.before),
      after: String(proposal.after),
      rationale: proposal.rationale,
      source: proposal.source,
      at: new Date(proposal.at).toISOString(),
    });
    revises.push({ domain: `proposal:${proposal.id}`, codomain: target, sort: "revises" });
  }

  // Queued goals, in the fold's order (priority, then age).
  for (const item of policy.queue) {
    objects.push({
      id: `queued_goal:${item.id}`,
      title: item.objective,
      sort: "queued_goal",
      tags: [item.status],
      status: item.status,
      repo: item.repo ?? "",
      priority: String(item.priority),
      claimed_by: item.claimedBy ?? "",
      category: item.category ?? "",
    });
    const repo = item.repo ? repos.get(item.repo) : undefined;
    if (repo) targets.push({ domain: `queued_goal:${item.id}`, codomain: repo.id, sort: "targets" });
  }

  // Repos — exact mirrors of the projection's repo nodes, so the glue holds.
  const repoRecords = new Map<string, SiteRecord>();
  for (const [name, node] of [...repos].sort(([a], [b]) => a.localeCompare(b))) {
    const record: SiteRecord = {
      id: node.id,
      title: name,
      sort: "repo",
      tags: node.tags,
      ...(node.root !== undefined ? { root: node.root } : {}),
    };
    repoRecords.set(name, record);
    objects.push(record);
  }

  // Repo policies — one per repo name the loop knows from the projection or
  // the policy, with a governs edge when the repo object exists to receive it.
  const names = [...new Set([...repoRecords.keys(), ...Object.keys(policy.gates), ...Object.keys(policy.criteria)])].sort();
  for (const name of names) {
    const commands = policy.gates[name] ?? [];
    const criteria = policy.criteria[name] ?? "";
    objects.push({
      id: `repo_policy:${name}`,
      title: name,
      sort: "repo_policy",
      tags: commands.length > 0 ? ["gated"] : criteria ? ["judge-checked"] : [],
      gates: commands.join("\n"),
      criteria,
    });
    const repo = repoRecords.get(name);
    if (repo) governs.push({ domain: `repo_policy:${name}`, codomain: repo.id, sort: "governs" });
  }

  // Terms — every declared and operator-added word with its live count where
  // one exists; decision and edge kinds are never produced as events.
  for (const vocab of VOCABULARY_ORDER) {
    for (const term of vocabulary(policy, vocab)) {
      const count = vocab === "event" ? (classCounts.get(term.id) ?? 0) : vocab === "settle" ? (settleCounts.get(term.id) ?? 0) : null;
      objects.push({
        id: `term:${vocab}:${term.id}`,
        title: term.label,
        sort: "term",
        tags: [vocab, term.usage],
        hidden: String(term.hidden),
        vocabulary: vocab,
        term: term.id,
        description: term.description,
        count: count === null ? "" : String(count),
      });
    }
  }

  // Params — the value in effect for a session without its own override.
  for (const spec of PARAMS) {
    const set = policy.params[spec.key];
    objects.push({
      id: `param:${spec.key}`,
      title: spec.label,
      sort: "param",
      tags: [spec.unit, set === undefined ? "default" : "custom"],
      value: String(set ?? (spec.unit === "flag" ? (DEFAULT_FLAGS[spec.key] ?? 0) : limits[spec.key])),
      description: spec.description,
      min: String(spec.min),
      max: String(spec.max),
    });
  }

  // Prompts — the text the loop sends, default or operator-edited.
  for (const spec of PROMPTS) {
    objects.push({
      id: `prompt:${spec.key}`,
      title: spec.label,
      sort: "prompt",
      tags: [policy.prompts[spec.key] === undefined ? "default" : "custom"],
      text: policy.prompts[spec.key] ?? DEFAULT_PROMPTS[spec.key],
      description: spec.description,
    });
  }

  return { objects, morphisms: [...governs, ...targets, ...revises] };
}
