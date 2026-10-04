// The loop's policy: everything an operator can change about how the loop
// behaves, kept as one append-only log (`policy.jsonl`) and folded into the
// current state on read.
//
// Same medium as control.jsonl and for the same reason: every session on the
// host reads it and the dashboard appends to it, so a read-modify-write file
// would drop whichever change landed in the window. O_APPEND makes one op one
// write, and the file doubles as the audit trail of who changed what.
//
// Pure: text in, data out. The caller owns the filesystem and the clock.

import {
  DECISION_KINDS,
  EDGE_KINDS,
  EVENT_CLASSES,
  SETTLE_REASONS,
  classify,
  type Term,
} from "./taxonomy.ts";

// -- Vocabulary of the policy itself ----------------------------------------

/** Loop parameters the dashboard can change while sessions run. */
export const PARAMS = [
  {
    key: "maxContinuations",
    label: "Continuations per cycle",
    description: "How many times the loop pushes an agent onward before it stops.",
    unit: "count",
    min: 0,
    max: 50,
    proposable: true,
  },
  {
    key: "timeoutMs",
    label: "Cycle time limit",
    description: "Elapsed cap on one cycle; the loop settles cycle_timeout past it.",
    unit: "ms",
    min: 60_000,
    max: 6 * 3_600_000,
    proposable: true,
  },
  {
    key: "queueAutoPull",
    label: "Pull the next queued goal on settle",
    description: "When a cycle settles, the session claims the top queued goal for its repo.",
    unit: "flag",
    min: 0,
    max: 1,
    proposable: false,
  },
  {
    key: "reflect",
    label: "Propose improvements after settles",
    description: "Run the reflect pass after a settle; it files at most one pending proposal.",
    unit: "flag",
    min: 0,
    max: 1,
    proposable: false,
  },
] as const;

export type ParamKey = (typeof PARAMS)[number]["key"];

/** Prompt text the loop sends, editable and proposable. */
export const PROMPTS = [
  {
    key: "continuation",
    label: "Continuation directive",
    description: "Sent to the agent each time the loop continues instead of stopping.",
  },
  {
    key: "judgeCriteria",
    label: "Extra judge criteria",
    description: "Appended to the judge rubric. The verdict-token contract stays fixed.",
  },
] as const;

export type PromptKey = (typeof PROMPTS)[number]["key"];

/** Adapted from prime-agent DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptKey, string>> = {
  continuation:
    "No human input is available while the autonomous loop is running. " +
    "Continue working until the task is complete or the loop's limits stop " +
    "the run. If you were about to ask the user a question, make a reasonable " +
    "assumption and verify it. If you believe you are blocked, prove it with " +
    "host-observable evidence (command output, file state), preserve that " +
    "evidence, and keep looking for safe progress while budget remains.",
  judgeCriteria: "",
};

/** Flag defaults; numeric loop limits default through SessionConfig instead. */
export const DEFAULT_FLAGS: Readonly<Partial<Record<ParamKey, number>>> = {
  queueAutoPull: 0,
  reflect: 1,
};

export const VOCABULARIES = {
  event: { label: "Event classes", terms: EVENT_CLASSES },
  settle: { label: "Settle reasons", terms: SETTLE_REASONS },
  decision: { label: "Decision kinds", terms: DECISION_KINDS },
  edge: { label: "Edge kinds", terms: EDGE_KINDS },
} as const;

export type Vocabulary = keyof typeof VOCABULARIES;

const VOCAB_IDS: readonly string[] = Object.keys(VOCABULARIES);

/**
 * Vocabularies whose term set may grow from the dashboard. Event classes and
 * settle reasons are labels nothing branches on once recorded; decision kinds
 * are switched on by the loop and edge kinds must match the canvas schema, so
 * those two take display edits only.
 */
export const EXTENSIBLE: readonly Vocabulary[] = ["event", "settle"];

// -- State -------------------------------------------------------------------

export type Decision = "accepted" | "overturned";
export type ProposalStatus = "pending" | "accepted" | "rejected";

export type ProposalTarget =
  | { readonly kind: "prompt"; readonly key: PromptKey }
  | { readonly kind: "param"; readonly key: ParamKey };

export interface Proposal {
  readonly id: string;
  readonly at: number;
  /** Session whose settle prompted it, or "dashboard". */
  readonly source: string;
  readonly target: ProposalTarget;
  readonly before: string | number | null;
  readonly after: string | number;
  readonly rationale: string;
  readonly status: ProposalStatus;
  readonly decidedAt?: number;
}

export interface QueueItem {
  readonly id: string;
  readonly objective: string;
  /** Lower runs first. */
  readonly priority: number;
  /** Repo name a session must be in to claim it; absent means any repo. */
  readonly repo?: string;
  readonly category?: string;
  readonly status: "queued" | "claimed" | "retired";
  readonly claimedBy?: string;
  readonly addedAt: number;
}

export interface TermEdit {
  readonly label?: string;
  readonly description?: string;
  /** Hidden terms are dropped from the decision feed, never from the log. */
  readonly hidden?: boolean;
}

export interface CustomTerm {
  readonly vocab: Vocabulary;
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface ClassRule {
  /** Message prefix; matched only against events the built-in classifier calls "other". */
  readonly prefix: string;
  readonly cls: string;
}

export interface GoalCategory {
  readonly id: string;
  readonly label: string;
  /** Case-insensitive substrings of an objective; first category to match wins. */
  readonly keywords: readonly string[];
}

export interface Ratification {
  readonly decision: Decision;
  readonly note?: string;
  readonly at: number;
}

export interface Policy {
  readonly params: Readonly<Partial<Record<ParamKey, number>>>;
  /** Gate commands per repo name. */
  readonly gates: Readonly<Record<string, readonly string[]>>;
  /** Done criteria per repo name: prose the judge checks a claim against. */
  readonly criteria: Readonly<Record<string, string>>;
  readonly prompts: Readonly<Partial<Record<PromptKey, string>>>;
  /** Keyed `${vocab}:${id}`. */
  readonly terms: Readonly<Record<string, TermEdit>>;
  readonly customTerms: readonly CustomTerm[];
  readonly rules: readonly ClassRule[];
  readonly categories: readonly GoalCategory[];
  readonly queue: readonly QueueItem[];
  /** Keyed by verdict id (`${session}@${ts}` of the settle event). */
  readonly ratifications: Readonly<Record<string, Ratification>>;
  readonly proposals: readonly Proposal[];
}

export const EMPTY_POLICY: Policy = {
  params: {},
  gates: {},
  criteria: {},
  prompts: {},
  terms: {},
  customTerms: [],
  rules: [],
  categories: [],
  queue: [],
  ratifications: {},
  proposals: [],
};

// -- Ops ---------------------------------------------------------------------

export type PolicyOp =
  | { readonly op: "param"; readonly key: ParamKey; readonly value: number | null }
  | { readonly op: "gates"; readonly repo: string; readonly commands: readonly string[] }
  | { readonly op: "criteria"; readonly repo: string; readonly text: string | null }
  | { readonly op: "prompt"; readonly key: PromptKey; readonly text: string | null }
  | {
      readonly op: "term";
      readonly vocab: Vocabulary;
      readonly id: string;
      readonly label?: string;
      readonly description?: string;
      readonly hidden?: boolean;
    }
  | { readonly op: "term.add"; readonly vocab: Vocabulary; readonly id: string; readonly label: string; readonly description: string }
  | { readonly op: "rule"; readonly prefix: string; readonly cls: string | null }
  | { readonly op: "category"; readonly id: string; readonly label: string; readonly keywords: readonly string[] }
  | { readonly op: "category.remove"; readonly id: string }
  | {
      readonly op: "queue.add";
      readonly id: string;
      readonly objective: string;
      readonly priority: number;
      readonly repo?: string;
      readonly category?: string;
    }
  | { readonly op: "queue.priority"; readonly id: string; readonly priority: number }
  | { readonly op: "queue.retire"; readonly id: string }
  | { readonly op: "queue.claim"; readonly id: string; readonly session: string }
  | { readonly op: "ratify"; readonly verdict: string; readonly decision: Decision; readonly note?: string }
  | {
      readonly op: "proposal";
      readonly id: string;
      readonly source: string;
      readonly target: ProposalTarget;
      readonly after: string | number;
      readonly rationale: string;
    }
  | { readonly op: "proposal.decide"; readonly id: string; readonly decision: "accepted" | "rejected" };

export type PolicyRecord = PolicyOp & { readonly at: number; readonly by: string };

const MAX_TEXT = 8_000;
const MAX_SHORT = 400;
const ID = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const short = (v: unknown): v is string => str(v, MAX_SHORT) && v.trim().length > 0;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/**
 * A term id. Settle reasons are matched by the exact reason the loop wrote,
 * and older logs wrote some with spaces ("turn ended error"), so a settle term
 * takes any single-line text; other vocabularies keep identifier ids.
 */
export function termId(vocab: unknown, v: unknown): v is string {
  if (vocab === "settle") return typeof v === "string" && /^[^\s|][^|\n\r]{0,79}$/.test(v);
  return isId(v);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const paramSpec = (key: unknown) => PARAMS.find((p) => p.key === key);
const isPromptKey = (key: unknown): key is PromptKey => PROMPTS.some((p) => p.key === key);
const isVocab = (v: unknown): v is Vocabulary => typeof v === "string" && VOCAB_IDS.includes(v);

function parseTarget(raw: unknown): ProposalTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, key } = raw as Record<string, unknown>;
  if (kind === "prompt" && isPromptKey(key)) return { kind, key };
  if (kind === "param" && paramSpec(key)?.proposable) return { kind, key: key as ParamKey };
  return null;
}

/** A value that fits its target: in-bounds integer for a param, bounded text for a prompt. */
export function validValue(target: ProposalTarget, value: unknown): value is string | number {
  if (target.kind === "prompt") return str(value, MAX_TEXT);
  const spec = paramSpec(target.key);
  return !!spec && finite(value) && Number.isInteger(value) && value >= spec.min && value <= spec.max;
}

/**
 * Validate an op from an untrusted source (the dashboard POST body, or a line
 * of the log). Returns the op with only its declared fields, or an error.
 */
export function validateOp(raw: unknown): { op: PolicyOp } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "op must be an object" };
  const r = raw as Record<string, unknown>;
  switch (r.op) {
    case "param": {
      const spec = paramSpec(r.key);
      if (!spec) return { error: `unknown param: ${String(r.key)}` };
      if (r.value === null) return { op: { op: "param", key: spec.key, value: null } };
      if (!validValue({ kind: "param", key: spec.key }, r.value)) {
        return { error: `${spec.key} must be an integer in [${spec.min}, ${spec.max}]` };
      }
      return { op: { op: "param", key: spec.key, value: r.value as number } };
    }
    case "gates": {
      if (!short(r.repo)) return { error: "gates needs a repo" };
      if (!Array.isArray(r.commands) || !r.commands.every((c) => short(c))) {
        return { error: "gates.commands must be a list of non-empty commands" };
      }
      return { op: { op: "gates", repo: r.repo.trim(), commands: r.commands.map((c: string) => c.trim()) } };
    }
    case "criteria": {
      if (!short(r.repo)) return { error: "criteria needs a repo" };
      if (r.text !== null && r.text !== undefined && !str(r.text, MAX_TEXT)) return { error: "criteria text too long" };
      // Empty or absent text clears: saving a blank field means "no criteria".
      const text = typeof r.text === "string" && r.text.trim() ? r.text.trim() : null;
      return { op: { op: "criteria", repo: r.repo.trim(), text } };
    }
    case "prompt": {
      if (!isPromptKey(r.key)) return { error: `unknown prompt: ${String(r.key)}` };
      if (r.text !== null && !str(r.text, MAX_TEXT)) return { error: "prompt text too long" };
      return { op: { op: "prompt", key: r.key, text: r.text as string | null } };
    }
    case "term": {
      if (!isVocab(r.vocab) || !termId(r.vocab, r.id)) return { error: "term needs a vocab and an id" };
      if (r.label !== undefined && !short(r.label)) return { error: "term.label must be short text" };
      if (r.description !== undefined && !str(r.description, MAX_SHORT)) return { error: "term.description too long" };
      if (r.hidden !== undefined && typeof r.hidden !== "boolean") return { error: "term.hidden must be boolean" };
      return {
        op: {
          op: "term",
          vocab: r.vocab,
          id: r.id,
          ...(r.label !== undefined ? { label: (r.label as string).trim() } : {}),
          ...(r.description !== undefined ? { description: r.description as string } : {}),
          ...(r.hidden !== undefined ? { hidden: r.hidden as boolean } : {}),
        },
      };
    }
    case "term.add": {
      if (!isVocab(r.vocab) || !EXTENSIBLE.includes(r.vocab)) return { error: "only event classes and settle reasons take new terms" };
      if (!termId(r.vocab, r.id) || !short(r.label) || !str(r.description, MAX_SHORT)) return { error: "term.add needs id, label, description" };
      return { op: { op: "term.add", vocab: r.vocab, id: r.id, label: r.label.trim(), description: r.description } };
    }
    case "rule": {
      if (!short(r.prefix)) return { error: "rule needs a prefix" };
      if (r.cls !== null && !isId(r.cls)) return { error: "rule.cls must be a class id or null" };
      if (EVENT_CLASSES.some((t) => t.id === r.cls && t.usage === "branch")) {
        return { error: `${String(r.cls)} is a branch class; rules may only re-label into label classes` };
      }
      return { op: { op: "rule", prefix: r.prefix, cls: r.cls as string | null } };
    }
    case "category": {
      if (!isId(r.id) || !short(r.label)) return { error: "category needs id and label" };
      if (!Array.isArray(r.keywords) || r.keywords.length === 0 || !r.keywords.every((k) => short(k))) {
        return { error: "category.keywords must be a non-empty list" };
      }
      return { op: { op: "category", id: r.id, label: r.label.trim(), keywords: r.keywords.map((k: string) => k.trim()) } };
    }
    case "category.remove":
      return isId(r.id) ? { op: { op: "category.remove", id: r.id } } : { error: "category.remove needs an id" };
    case "queue.add": {
      if (!isId(r.id)) return { error: "queue.add needs an id" };
      if (!str(r.objective, 4_000) || !r.objective.trim()) return { error: "queue.add needs an objective" };
      if (r.priority !== undefined && !finite(r.priority)) return { error: "priority must be a number" };
      if (r.repo !== undefined && r.repo !== "" && !short(r.repo)) return { error: "repo must be short text" };
      if (r.category !== undefined && r.category !== "" && !isId(r.category)) return { error: "category must be an id" };
      return {
        op: {
          op: "queue.add",
          id: r.id,
          objective: r.objective.trim(),
          priority: (r.priority as number | undefined) ?? 100,
          ...(typeof r.repo === "string" && r.repo.trim() ? { repo: r.repo.trim() } : {}),
          ...(typeof r.category === "string" && r.category ? { category: r.category } : {}),
        },
      };
    }
    case "queue.priority":
      return isId(r.id) && finite(r.priority)
        ? { op: { op: "queue.priority", id: r.id, priority: r.priority } }
        : { error: "queue.priority needs id and priority" };
    case "queue.retire":
      return isId(r.id) ? { op: { op: "queue.retire", id: r.id } } : { error: "queue.retire needs an id" };
    case "queue.claim":
      return isId(r.id) && short(r.session)
        ? { op: { op: "queue.claim", id: r.id, session: r.session } }
        : { error: "queue.claim needs id and session" };
    case "ratify": {
      if (!short(r.verdict)) return { error: "ratify needs a verdict id" };
      if (r.decision !== "accepted" && r.decision !== "overturned") return { error: "decision must be accepted or overturned" };
      if (r.note !== undefined && !str(r.note, MAX_SHORT)) return { error: "note too long" };
      return {
        op: {
          op: "ratify",
          verdict: r.verdict,
          decision: r.decision,
          ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
        },
      };
    }
    case "proposal": {
      const target = parseTarget(r.target);
      if (!isId(r.id) || !short(r.source) || !target) return { error: "proposal needs id, source, target" };
      if (!validValue(target, r.after)) return { error: "proposal.after does not fit its target" };
      if (!str(r.rationale, 2_000) || !r.rationale.trim()) return { error: "proposal needs a rationale" };
      return { op: { op: "proposal", id: r.id, source: r.source, target, after: r.after, rationale: r.rationale.trim() } };
    }
    case "proposal.decide":
      return isId(r.id) && (r.decision === "accepted" || r.decision === "rejected")
        ? { op: { op: "proposal.decide", id: r.id, decision: r.decision } }
        : { error: "proposal.decide needs id and accepted|rejected" };
    default:
      return { error: `unknown op: ${String(r.op)}` };
  }
}

/** Serialize one op as a log line. */
export function encodeOp(op: PolicyOp, at: number, by: string): string {
  return `${JSON.stringify({ ...op, at, by })}\n`;
}

/** Parse a log line, or null when it is not a valid op. Never throws. */
export function parseOp(line: string): PolicyRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { at, by } = raw as Record<string, unknown>;
  if (!finite(at)) return null;
  const checked = validateOp(raw);
  if ("error" in checked) return null;
  return { ...checked.op, at, by: typeof by === "string" ? by : "" } as PolicyRecord;
}

// -- Fold --------------------------------------------------------------------

/**
 * Fold the log into the current policy. Order is file order: O_APPEND gives a
 * total order across writers, which is what makes "first claim wins" safe
 * without a lock.
 */
export function foldPolicy(text: string): Policy {
  const params: Partial<Record<ParamKey, number>> = {};
  const gates: Record<string, readonly string[]> = {};
  const criteria: Record<string, string> = {};
  const prompts: Partial<Record<PromptKey, string>> = {};
  const terms: Record<string, TermEdit> = {};
  const customTerms = new Map<string, CustomTerm>();
  const rules = new Map<string, ClassRule>();
  const categories = new Map<string, GoalCategory>();
  const queue = new Map<string, QueueItem>();
  const ratifications: Record<string, Ratification> = {};
  const proposals = new Map<string, Proposal>();

  const currentValue = (target: ProposalTarget): string | number | null =>
    target.kind === "prompt" ? (prompts[target.key] ?? DEFAULT_PROMPTS[target.key]) : (params[target.key] ?? null);

  for (const line of text.split("\n")) {
    const rec = parseOp(line);
    if (!rec) continue;
    switch (rec.op) {
      case "param":
        if (rec.value === null) delete params[rec.key];
        else params[rec.key] = rec.value;
        break;
      case "gates":
        if (rec.commands.length === 0) delete gates[rec.repo];
        else gates[rec.repo] = rec.commands;
        break;
      case "criteria":
        if (rec.text === null) delete criteria[rec.repo];
        else criteria[rec.repo] = rec.text;
        break;
      case "prompt":
        if (rec.text === null) delete prompts[rec.key];
        else prompts[rec.key] = rec.text;
        break;
      case "term": {
        const key = `${rec.vocab}:${rec.id}`;
        const prev = terms[key] ?? {};
        terms[key] = {
          ...prev,
          ...(rec.label !== undefined ? { label: rec.label } : {}),
          ...(rec.description !== undefined ? { description: rec.description } : {}),
          ...(rec.hidden !== undefined ? { hidden: rec.hidden } : {}),
        };
        break;
      }
      case "term.add":
        customTerms.set(`${rec.vocab}:${rec.id}`, { vocab: rec.vocab, id: rec.id, label: rec.label, description: rec.description });
        break;
      case "rule":
        if (rec.cls === null) rules.delete(rec.prefix);
        else rules.set(rec.prefix, { prefix: rec.prefix, cls: rec.cls });
        break;
      case "category":
        categories.set(rec.id, { id: rec.id, label: rec.label, keywords: rec.keywords });
        break;
      case "category.remove":
        categories.delete(rec.id);
        break;
      case "queue.add":
        if (!queue.has(rec.id)) {
          queue.set(rec.id, {
            id: rec.id,
            objective: rec.objective,
            priority: rec.priority,
            ...(rec.repo ? { repo: rec.repo } : {}),
            ...(rec.category ? { category: rec.category } : {}),
            status: "queued",
            addedAt: rec.at,
          });
        }
        break;
      case "queue.priority": {
        const item = queue.get(rec.id);
        if (item) queue.set(rec.id, { ...item, priority: rec.priority });
        break;
      }
      case "queue.retire": {
        const item = queue.get(rec.id);
        if (item) queue.set(rec.id, { ...item, status: "retired" });
        break;
      }
      case "queue.claim": {
        // First claim wins; a later one lost the race and changes nothing.
        const item = queue.get(rec.id);
        if (item?.status === "queued") queue.set(rec.id, { ...item, status: "claimed", claimedBy: rec.session });
        break;
      }
      case "ratify":
        ratifications[rec.verdict] = { decision: rec.decision, at: rec.at, ...(rec.note ? { note: rec.note } : {}) };
        break;
      case "proposal":
        if (!proposals.has(rec.id)) {
          proposals.set(rec.id, {
            id: rec.id,
            at: rec.at,
            source: rec.source,
            target: rec.target,
            before: currentValue(rec.target),
            after: rec.after,
            rationale: rec.rationale,
            status: "pending",
          });
        }
        break;
      case "proposal.decide": {
        const p = proposals.get(rec.id);
        if (!p || p.status !== "pending") break;
        proposals.set(rec.id, { ...p, status: rec.decision, decidedAt: rec.at });
        // Accepting is applying: the proposal's value becomes the policy's.
        if (rec.decision === "accepted") {
          if (p.target.kind === "prompt") prompts[p.target.key] = String(p.after);
          else params[p.target.key] = Number(p.after);
        }
        break;
      }
    }
  }

  return {
    params,
    gates,
    criteria,
    prompts,
    terms,
    customTerms: [...customTerms.values()],
    rules: [...rules.values()],
    categories: [...categories.values()],
    queue: [...queue.values()].sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt),
    ratifications,
    proposals: [...proposals.values()].sort((a, b) => b.at - a.at),
  };
}

// -- Readers -----------------------------------------------------------------

export function promptText(policy: Policy, key: PromptKey): string {
  return policy.prompts[key] ?? DEFAULT_PROMPTS[key];
}

export function flag(policy: Policy, key: "queueAutoPull" | "reflect"): boolean {
  return (policy.params[key] ?? DEFAULT_FLAGS[key] ?? 0) === 1;
}

/** Gate commands configured for a repo, or [] when it has none. */
export function gatesFor(policy: Policy, repo: string | undefined): readonly string[] {
  return repo ? (policy.gates[repo] ?? []) : [];
}

/** Done criteria for a repo, or "" when it has none. */
export function criteriaFor(policy: Policy, repo: string | undefined): string {
  return repo ? (policy.criteria[repo] ?? "") : "";
}

/**
 * A gate line that reads as a sentence rather than a command: it is run with
 * a shell and would fail every claim. Heuristic, so the page warns, never refuses.
 */
export function looksLikeProse(command: string): boolean {
  const words = command.trim().split(/\s+/);
  return words.length >= 6 && /^[A-Z][a-z]/.test(command.trim()) && /[.!?]$/.test(command.trim());
}

/**
 * Classify with operator rules layered under the built-in classifier. Rules
 * only re-label what the loop itself calls "other", so a rule can never turn
 * a branch class (continue, gate, goal, settled) into something the budget
 * replay would misread.
 */
export function classifyWith(policy: Policy, msg: string): string {
  const builtin = classify(msg);
  if (builtin !== "other") return builtin;
  let best: ClassRule | undefined;
  for (const rule of policy.rules) {
    if (msg.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best?.cls ?? builtin;
}

export function categorize(policy: Policy, objective: string): GoalCategory | undefined {
  const text = objective.toLowerCase();
  return policy.categories.find((c) => c.keywords.some((k) => text.includes(k.toLowerCase())));
}

/** A vocabulary's terms with operator edits and additions applied. */
export function vocabulary(
  policy: Policy,
  vocab: Vocabulary,
): (Term<string> & { readonly hidden: boolean; readonly custom: boolean })[] {
  const declared = (VOCABULARIES[vocab].terms as readonly Term<string>[]).map((t) => ({ ...t, custom: false }));
  const added = policy.customTerms
    .filter((t) => t.vocab === vocab && !declared.some((d) => d.id === t.id))
    .map((t) => ({ id: t.id, label: t.label, description: t.description, usage: "label" as const, custom: true }));
  return [...declared, ...added].map((t) => {
    const edit = policy.terms[`${vocab}:${t.id}`] ?? {};
    return {
      ...t,
      label: edit.label ?? t.label,
      description: edit.description ?? t.description,
      hidden: edit.hidden ?? false,
    };
  });
}

export function nextQueued(policy: Policy, repo: string | undefined): QueueItem | undefined {
  return policy.queue.find((q) => q.status === "queued" && (!q.repo || q.repo === repo));
}

// -- Review queue ------------------------------------------------------------

/** Settle reasons a human reviews: the loop's two ways of saying "done". */
export const REVIEWABLE = ["judged_complete", "claimed_unverified"] as const;

export interface LogEvent {
  readonly ts: string;
  readonly session: string;
  readonly msg: string;
}

export interface Verdict {
  /** `${session}@${ts}` of the settle event: unique per settle, stable across reads. */
  readonly id: string;
  readonly ts: string;
  readonly session: string;
  readonly reason: (typeof REVIEWABLE)[number];
  /** Most recent goal this session set before settling; "" when the log has none. */
  readonly goal: string;
  /** The judge's stated reason, when one was recorded. */
  readonly judge: string;
  readonly ratification?: Ratification;
}

/**
 * Every "done" the loop recorded, newest first, joined to the goal it closed
 * and the judge's words. Joined by session label and order in the log, which
 * is how the loop wrote them.
 */
export function reviewQueue(events: readonly LogEvent[], policy: Policy): Verdict[] {
  const goal = new Map<string, string>();
  const judge = new Map<string, string>();
  const out: Verdict[] = [];
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const e of sorted) {
    if (e.msg.startsWith("goal set: ")) {
      goal.set(e.session, e.msg.slice("goal set: ".length));
      judge.delete(e.session);
    } else if (e.msg.startsWith("judge verdict: ")) {
      judge.set(e.session, e.msg.slice("judge verdict: ".length));
    } else if (e.msg.startsWith("settled: ")) {
      const reason = e.msg.slice("settled: ".length).trim();
      if ((REVIEWABLE as readonly string[]).includes(reason)) {
        const id = `${e.session}@${e.ts}`;
        out.push({
          id,
          ts: e.ts,
          session: e.session,
          reason: reason as Verdict["reason"],
          goal: goal.get(e.session) ?? "",
          judge: reason === "judged_complete" ? (judge.get(e.session) ?? "") : "",
          ...(policy.ratifications[id] ? { ratification: policy.ratifications[id] } : {}),
        });
      }
      judge.delete(e.session);
    }
  }
  return out.reverse();
}
