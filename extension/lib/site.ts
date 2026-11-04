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
  readonly parkAfter: number;
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

// -- Writes ------------------------------------------------------------------

/** A revised record as the emitter writes it: the object's id, sort and stringly fields. */
export interface SiteWriteRecord {
  readonly id: string;
  readonly sort: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Parse the emitter's write: `{ objects: [record...], morphisms: [...] }`. */
export function parseSiteWrite(body: unknown): { records: SiteWriteRecord[] } | { error: string } {
  if (typeof body !== "object" || body === null || !("objects" in body)) return { error: "the write needs an objects array" };
  if (!Array.isArray(body.objects)) return { error: "the write's objects must be an array" };
  const records: SiteWriteRecord[] = [];
  for (const raw of body.objects) {
    if (typeof raw !== "object" || raw === null) return { error: "each record must be an object" };
    if (!("id" in raw) || typeof raw.id !== "string" || !raw.id) return { error: "each record needs a string id" };
    if (!("sort" in raw) || typeof raw.sort !== "string" || !raw.sort) return { error: `record ${raw.id} needs a string sort` };
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "id" || key === "sort" || key === "tags") continue;
      if (typeof value !== "string") return { error: `record ${raw.id} field ${key} must be a string` };
      fields[key] = value;
    }
    records.push({ id: raw.id, sort: raw.sort, fields });
  }
  return { records };
}

/** The steering a site edit can imply: an overturned claim goes back to work. */
export interface SiteSteer {
  readonly target: string;
  readonly action: "reopen";
  readonly value?: string;
}

export type SiteEditResult = { ops: PolicyOp[]; steer?: SiteSteer } | { error: string; status: 400 | 404 };

const isVocabulary = (value: string): value is Vocabulary => VOCABULARY_ORDER.some((vocab) => vocab === value);

/**
 * Translate one revised record into the PolicyOp(s) it names. The record
 * carries every field the object has; only a field that differs from the
 * served site is the edit's change — volatile fields (counts, the at stamp)
 * are never settable, so they cannot read as one. The route validates each op
 * through validateOp before anything is appended.
 */
export function translateSiteEdit(record: SiteWriteRecord, site: ControlSite): SiteEditResult {
  const current = site.objects.find((object) => object.id === record.id);
  if (!current) return { error: `no ${record.sort} with id ${record.id} in the site`, status: 404 };
  const changed = (name: string): boolean => {
    const value = current[name];
    return record.fields[name] !== undefined && record.fields[name] !== (typeof value === "string" ? value : "");
  };

  switch (record.sort) {
    case "claim": {
      const verdict = record.id.startsWith("claim:") ? record.id.slice("claim:".length) : "";
      if (!verdict) return { error: `a claim record needs id claim:<verdict>, got ${record.id}`, status: 400 };
      if (!changed("decision")) {
        // The ratify edit always sets a decision; a note-only write is not one of the loop's intents.
        return changed("note") ? { error: "ratifying a claim needs a decision: accepted or overturned", status: 400 } : { ops: [] };
      }
      const decision = record.fields.decision;
      if (decision !== "accepted" && decision !== "overturned") {
        return { error: "a claim's decision must be accepted or overturned", status: 400 };
      }
      const note = record.fields.note?.trim() || undefined;
      const at = verdict.lastIndexOf("@");
      return {
        ops: [{ op: "ratify", verdict, decision, ...(note ? { note } : {}) }],
        // Overturning is only half a decision until the session hears it.
        ...(decision === "overturned" && at > 0 ? { steer: { target: verdict.slice(0, at), action: "reopen" as const, ...(note ? { value: note } : {}) } } : {}),
      };
    }

    case "proposal": {
      const id = record.id.startsWith("proposal:") ? record.id.slice("proposal:".length) : "";
      if (!id) return { error: `a proposal record needs id proposal:<id>, got ${record.id}`, status: 400 };
      if (!changed("status")) return { ops: [] };
      const decision = record.fields.status;
      if (decision !== "accepted" && decision !== "rejected") {
        return { error: "a proposal's status is decided as accepted or rejected", status: 400 };
      }
      return { ops: [{ op: "proposal.decide", id, decision }] };
    }

    case "queued_goal": {
      const id = record.id.startsWith("queued_goal:") ? record.id.slice("queued_goal:".length) : "";
      if (!id) return { error: `a queued_goal record needs id queued_goal:<id>, got ${record.id}`, status: 400 };
      const ops: PolicyOp[] = [];
      if (changed("priority")) ops.push({ op: "queue.priority", id, priority: Number(record.fields.priority) });
      if (changed("status")) {
        // claimed and parked are the loop's own writes; the operator retires.
        if (record.fields.status !== "retired") {
          return { error: `a queued goal's status is retired by an edit, not ${record.fields.status}`, status: 400 };
        }
        ops.push({ op: "queue.retire", id });
      }
      return { ops };
    }

    case "repo_policy": {
      const repo = record.id.startsWith("repo_policy:") ? record.id.slice("repo_policy:".length) : "";
      if (!repo) return { error: `a repo_policy record needs id repo_policy:<repo>, got ${record.id}`, status: 400 };
      const ops: PolicyOp[] = [];
      if (changed("gates")) {
        ops.push({ op: "gates", repo, commands: record.fields.gates.split("\n").map((line) => line.trim()).filter(Boolean) });
      }
      if (changed("criteria")) ops.push({ op: "criteria", repo, text: record.fields.criteria });
      return { ops };
    }

    case "param": {
      const spec = PARAMS.find((p) => p.key === record.id.slice("param:".length));
      if (!spec) return { error: `no param record ${record.id} in the site`, status: 400 };
      if (!changed("value")) return { ops: [] };
      return { ops: [{ op: "param", key: spec.key, value: Number(record.fields.value) }] };
    }

    case "prompt": {
      const spec = PROMPTS.find((p) => p.key === record.id.slice("prompt:".length));
      if (!spec) return { error: `no prompt record ${record.id} in the site`, status: 400 };
      if (!changed("text")) return { ops: [] };
      // Blank text clears, like criteria: an empty custom prompt would be sent verbatim.
      const text = record.fields.text.trim() ? record.fields.text : null;
      return { ops: [{ op: "prompt", key: spec.key, text }] };
    }

    case "term": {
      const rest = record.id.startsWith("term:") ? record.id.slice("term:".length) : "";
      const at = rest.indexOf(":");
      const vocab = at === -1 ? "" : rest.slice(0, at);
      const id = at === -1 ? "" : rest.slice(at + 1);
      if (!isVocabulary(vocab) || !id) return { error: `a term record needs id term:<vocab>:<term>, got ${record.id}`, status: 400 };
      const edit: { op: "term"; vocab: Vocabulary; id: string; description?: string; hidden?: boolean } = { op: "term", vocab, id };
      if (changed("description")) edit.description = record.fields.description;
      if (changed("hidden")) {
        if (record.fields.hidden !== "true" && record.fields.hidden !== "false") {
          return { error: "a term's hidden is written as true or false", status: 400 };
        }
        edit.hidden = record.fields.hidden === "true";
      }
      return edit.description === undefined && edit.hidden === undefined ? { ops: [] } : { ops: [edit] };
    }

    default:
      return { error: `no edit accepts a ${record.sort} record`, status: 400 };
  }
}
