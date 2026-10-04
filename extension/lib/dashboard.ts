// The auto-loop's own dashboard: where a human reviews what the loop decided,
// steers what it works on and how, and manages the words it reasons in.
//
// Four views over the same files:
//   * Review   — accept or overturn each "done" the loop recorded, and accept
//                or reject the changes the loop proposes to itself.
//   * Steer    — the goal queue, live limits, gates per repo, the prompts the
//                loop sends, and guidance into a running session.
//   * Taxonomy — the loop's vocabularies with live counts: relabel, hide,
//                extend, classify unlabelled messages, define goal categories.
//   * Activity — sessions and the decision feed.
//
// Stdlib only, like the rest of the extension. Sessions come from graph.lines
// (live state), decisions from events.jsonl (the record), operator state from
// policy.jsonl (see policy.ts). Parsing and rendering are pure and separate
// from serving, so they test without a socket or a filesystem.

import type * as Http from "node:http";
import { ACTIONS, ALL_SESSIONS, NEEDS_VALUE, encodeCommand, type ControlAction } from "./control.ts";
import type { ChatPort } from "./model.ts";
import {
  EMPTY_POLICY,
  encodeOp,
  EXTENSIBLE,
  PARAMS,
  PROMPTS,
  VOCABULARIES,
  categorize,
  classifyWith,
  flag,
  foldPolicy,
  looksLikeProse,
  promptText,
  reviewQueue,
  validateOp,
  vocabulary,
  type Policy,
  type PolicyOp,
  type Proposal,
  type Verdict,
  type Vocabulary,
} from "./policy.ts";
import { proposeImprovement } from "./reflect.ts";
import {
  classify,
  DECISION_KINDS,
  EDGE_KINDS,
  EVENT_CLASSES,
  SETTLE_REASONS,
  type DecisionKind,
  type EdgeKind,
  type EventClass,
  type SettleReason,
  type Term,
} from "./taxonomy.ts";

export interface SessionRow {
  readonly id: string;
  readonly label: string;
  readonly goal: string;
  readonly activeGoal: boolean;
  readonly status: string;
  readonly outcome: string;
  readonly continuations: number;
  readonly maxContinuations: number;
  readonly heartbeats: number;
  readonly model: string;
  readonly cwd: string;
  /** Newest event for this session, so an idle row shows how stale it is. */
  readonly lastSeen: string;
}

/**
 * The event log is the record; the graph projection is best-effort.
 *
 * `graph.lines` is written under a lock that gives up when another session
 * holds it, so a settle can be in the log and absent from the projection —
 * measurably so: both `judged_complete` settles on this host are missing from
 * the graph. Sessions come from the projection, because that is where live
 * state lives; decisions come from the log, because that is what actually
 * happened.
 */
export function parseEvents(text: string): DecisionRow[] {
  return readEvents(text).map((event) => ({
    ts: event.ts,
    session: event.session,
    kind: event.kind ?? "other",
    message: event.msg,
  }));
}

interface RawEvent {
  readonly ts: string;
  readonly session: string;
  /** Absent in logs written before the field existed. */
  readonly kind: string | undefined;
  readonly msg: string;
}

/** The one parse of the event log; decisions and taxonomy counts both read it. */
function readEvents(text: string): RawEvent[] {
  const rows: RawEvent[] = [];
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

export interface DecisionRow {
  readonly ts: string;
  readonly session: string;
  readonly kind: string;
  readonly message: string;
}

export interface TaxonomyReport {
  readonly eventClasses: readonly (Term<EventClass> & { readonly count: number })[];
  readonly settleReasons: readonly (Term<SettleReason> & { readonly count: number })[];
  readonly decisionKinds: readonly Term<DecisionKind>[];
  readonly edgeKinds: readonly Term<EdgeKind>[];
  /**
   * Settle messages whose reason matches no declared term. The loop writes the
   * reason into the message and nothing validates it against the union, so this
   * is where that drift is reported instead of being silently dropped.
   */
  readonly settleUnmatched: readonly { readonly reason: string; readonly count: number }[];
}

/**
 * The declared vocabularies with live counts. A term at zero is a reason the
 * loop has never produced; an entry in `settleUnmatched` is one it produced
 * that the union does not name. Both are worth seeing, and neither is derivable
 * from the union alone.
 */
export function taxonomyReport(text: string): TaxonomyReport {
  const classCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const declared = new Set<string>(SETTLE_REASONS.map((term) => term.id));

  for (const event of readEvents(text)) {
    // A recorded class is authoritative; only pre-field logs classify by message.
    const cls = event.kind ?? classify(event.msg);
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    if (cls !== "settled" || !event.msg.startsWith("settled: ")) continue;
    const reason = event.msg.slice("settled: ".length).trim();
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const settleUnmatched = [...reasonCounts]
    .filter(([reason]) => !declared.has(reason))
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    eventClasses: EVENT_CLASSES.map((term) => ({ ...term, count: classCounts.get(term.id) ?? 0 })),
    settleReasons: SETTLE_REASONS.map((term) => ({ ...term, count: reasonCounts.get(term.id) ?? 0 })),
    decisionKinds: DECISION_KINDS,
    edgeKinds: EDGE_KINDS,
    settleUnmatched,
  };
}

export interface RepoRow {
  readonly name: string;
  readonly root: string;
}

export interface DashboardState {
  readonly sessions: readonly SessionRow[];
  readonly decisions: readonly DecisionRow[];
  /** Repos the loop has seen sessions in, from the projection's repo nodes. */
  readonly repos: readonly RepoRow[];
  /** How completion claims resolve, which is what the loop is here to improve. */
  readonly verdicts: readonly { readonly reason: string; readonly count: number }[];
  /**
   * The same mix over the last day. The all-time figure is dominated by settles
   * from before a judge existed, so a page that shows only that reports a rate
   * the loop can no longer produce — it reads as "the judge never works" when
   * the truth is "the judge is new". Both are shown, labelled.
   */
  readonly recent: {
    readonly windowHours: number;
    readonly verdicts: readonly { readonly reason: string; readonly count: number }[];
  };
}

/**
 * The signal the loop exists to move: of the claims that settled, how many were
 * corroborated rather than merely asserted. `claimed_unverified` is the loop
 * taking the agent's word; `judged_complete` is evidence; `judge_unavailable`
 * is the judge failing open, which is a defect in the judge and not in the
 * agent. A rising `claimed_unverified` share means steering is getting weaker.
 */
export function verdictMix(
  decisions: readonly DecisionRow[],
  nowMs?: number,
  windowHours?: number,
): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  const since = nowMs !== undefined && windowHours !== undefined ? nowMs - windowHours * 3_600_000 : undefined;
  for (const d of decisions) {
    if (!d.message.startsWith("settled: ")) continue;
    if (since !== undefined) {
      const at = Date.parse(d.ts);
      if (!Number.isFinite(at) || at < since) continue;
    }
    const reason = d.message.slice("settled: ".length).trim() || "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  // Count first, then name: ties would otherwise follow whichever order the
  // feed happened to be in, and a strip that reorders between refreshes reads
  // as though the numbers moved.
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** A node line is `N|id|title|kind|tags|props|body?` (see observation.ts). */
function splitNode(line: string): { id: string; title: string; kind: string; tags: string[]; props: Map<string, string>; body: string } {
  const parts = line.split("|");
  return {
    id: parts[1] ?? "",
    title: parts[2] ?? "",
    kind: parts[3] ?? "",
    tags: (parts[4] ?? "").split(",").filter(Boolean),
    props: new Map(
      (parts[5] ?? "")
        .split(";")
        .filter(Boolean)
        .map((kv) => {
          const at = kv.indexOf("=");
          return at === -1 ? [kv, ""] : [kv.slice(0, at), kv.slice(at + 1)];
        }),
    ),
    body: parts.slice(6).join("|"),
  };
}

const num = (props: Map<string, string>, key: string): number => {
  const value = Number(props.get(key) ?? 0);
  return Number.isFinite(value) ? value : 0;
};

/**
 * Parse the projection into the two panels. Total: a malformed line is skipped,
 * never thrown on, because the dashboard's job is to show what is there —
 * a writer mid-rename must cost a row, not the page.
 */
export function parseProjection(text: string, eventsText?: string): DashboardState {
  const sessions: SessionRow[] = [];
  const repos = new Map<string, RepoRow>();
  const decisions: DecisionRow[] = eventsText === undefined ? [] : parseEvents(eventsText);

  // Newest first: a feed is read from the top.
  decisions.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  // A fresh install accumulates a session hub per process ever seen. Ordering
  // by what is working now, then by when each was last heard from, keeps the
  // page about the loop rather than about its history.
  const lastSeen = new Map<string, string>();
  for (const d of decisions) {
    if (d.session && !lastSeen.has(d.session)) lastSeen.set(d.session, d.ts);
  }

  for (const line of text.split("\n")) {
    if (!line.startsWith("N|")) continue;
    const node = splitNode(line);

    if (node.kind === "repo" && node.title) {
      repos.set(node.title, { name: node.title, root: node.props.get("root") ?? "" });
    }
    if (node.kind === "session") {
      sessions.push({
        id: node.id,
        label: node.title,
        // The session hub carries the active objective as its body, so the
        // page never has to join back to the goal node for the common case.
        goal: node.body,
        activeGoal: node.tags.includes("active-goal"),
        status: node.tags.includes("active-goal") ? "working" : "idle",
        outcome: node.tags.find((t) => !["active-goal", "no-goal", "main", "sub"].includes(t)) ?? "",
        continuations: num(node.props, "continuations"),
        maxContinuations: num(node.props, "max_continuations"),
        heartbeats: num(node.props, "heartbeats"),
        model: node.props.get("model") ?? "",
        cwd: node.props.get("cwd") ?? "",
        lastSeen: lastSeen.get(node.title) ?? "",
      });
    }
  }

  sessions.sort(
    (a, b) =>
      Number(b.activeGoal) - Number(a.activeGoal) ||
      (lastSeen.get(b.label) ?? "").localeCompare(lastSeen.get(a.label) ?? "") ||
      a.label.localeCompare(b.label),
  );

  return {
    sessions,
    decisions,
    repos: [...repos.values()].sort((a, b) => a.name.localeCompare(b.name)),
    verdicts: verdictMix(decisions),
    recent: { windowHours: 24, verdicts: verdictMix(decisions, Date.now(), 24) },
  };
}

/**
 * A goal objective is a paragraph the model wrote; a table cell is not the
 * place for it. Truncated here rather than by CSS line-clamp, which does not
 * hold inside a fixed table layout and lets one long goal shove the columns
 * apart.
 */
export function clamp(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Everything on this page comes from model-written text. Escape all of it. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const shortTime = (ts: string): string => (ts.length >= 19 ? ts.slice(11, 19) : ts);

/** "3m ago" answers "is this live?" faster than a clock time does. */
export function ago(ts: string, nowMs: number): string {
  if (!ts) return "";
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Plain sentences, so a verdict reads as a verdict rather than a log token. */
export function humanise(row: DecisionRow): string {
  const message = row.message;
  if (message.startsWith("settled: ")) {
    const reason = message.slice("settled: ".length);
    const words: Record<string, string> = {
      claimed_unverified: "stopped — the agent claimed done, nothing verified it",
      judged_complete: "stopped — the judge corroborated the claim",
      judge_unavailable: "stopped — the judge could not be reached",
      verified_complete: "stopped — gates passed",
      continuation_limit: "stopped — out of continuations",
      cycle_timeout: "stopped — ran out of time",
      error: "stopped — the turn errored",
      aborted: "stopped — interrupted",
    };
    return words[reason] ?? `stopped — ${reason.replace(/_/g, " ")}`;
  }
  if (message.startsWith("judge verdict:")) return `judge: ${message.slice("judge verdict: ".length).toLowerCase()}`;
  if (message.startsWith("judge unavailable")) return "judge unreachable — claim not corroborated";
  if (message.startsWith("gate failed")) return "gate failed — still working";
  if (message.startsWith("gates passed")) return "gates passed";
  if (message.startsWith("heartbeat")) return "idle — re-checking the goal";
  if (message.startsWith("autonomous continuation")) {
    return `continuing — ${message.slice("autonomous continuation ".length)} used`;
  }
  if (message.startsWith("resumed:")) {
    return `resumed a prior run — ${message.replace(/^resumed: prior run had spent /, "")} already spent`;
  }
  if (message.startsWith("goal set: ")) return `new goal — ${message.slice("goal set: ".length)}`;
  if (message === "goal complete") return "goal marked complete";
  if (message.startsWith("steered: ")) return `operator — ${message.slice("steered: ".length)}`;
  return message;
}

// -- Control view ------------------------------------------------------------

/** Everything the control tabs need beyond the activity state. */
export interface ControlView {
  readonly policy: Policy;
  readonly review: readonly Verdict[];
  /** The limits a session without its own override runs with right now. */
  readonly limits: { readonly maxContinuations: number; readonly timeoutMs: number };
  /** Whether a reflect pass can run from this page (a model is configured). */
  readonly reflectAvailable: boolean;
  /** Event counts per class, with operator rules applied. */
  readonly classCounts: Readonly<Record<string, number>>;
  readonly settleCounts: Readonly<Record<string, number>>;
  /** Message prefixes still classed "other", most frequent first: what to classify next. */
  readonly unclassified: readonly { readonly prefix: string; readonly count: number }[];
}

/** The prefix a rule would match: up to the first colon, else the first three words. */
export function messagePrefix(msg: string): string {
  const colon = msg.indexOf(":");
  if (colon > 0 && colon <= 40) return msg.slice(0, colon + 1);
  return msg.split(/\s+/).slice(0, 3).join(" ");
}

export function controlView(
  state: DashboardState,
  policy: Policy,
  limits: ControlView["limits"],
  reflectAvailable: boolean,
): ControlView {
  const classCounts: Record<string, number> = {};
  const settleCounts: Record<string, number> = {};
  const prefixes = new Map<string, number>();
  for (const d of state.decisions) {
    const cls = d.kind === "other" ? classifyWith(policy, d.message) : d.kind;
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
    if (d.message.startsWith("settled: ")) {
      const reason = d.message.slice("settled: ".length).trim();
      settleCounts[reason] = (settleCounts[reason] ?? 0) + 1;
    }
    if (cls === "other") {
      const prefix = messagePrefix(d.message);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
  }
  return {
    policy,
    review: reviewQueue(
      state.decisions.map((d) => ({ ts: d.ts, session: d.session, msg: d.message })),
      policy,
    ),
    limits,
    reflectAvailable,
    classCounts,
    settleCounts,
    unclassified: [...prefixes.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

// -- Rendering ---------------------------------------------------------------

const chip = (kind: string, text = kind): string =>
  `<span class="chip ${escapeHtml(kind)}">${escapeHtml(text)}</span>`;

/** A button that POSTs `body` (plus any [data-field] values in its [data-scope]). */
const act = (label: string, body: unknown, opts: { url?: string; cls?: string; confirm?: string } = {}): string =>
  `<button type="button" class="${opts.cls ?? ""}" data-url="${opts.url ?? "/api/policy"}" data-body="${escapeHtml(JSON.stringify(body))}"${
    opts.confirm ? ` data-confirm="${escapeHtml(opts.confirm)}"` : ""
  }>${escapeHtml(label)}</button>`;

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

function renderProposal(p: Proposal, now: number, limits: ControlView["limits"]): string {
  const target = p.target.kind === "prompt" ? PROMPTS.find((x) => x.key === p.target.key)?.label : PARAMS.find((x) => x.key === p.target.key)?.label;
  // A param never set on the dashboard has `before: null`. While pending, what
  // is in effect is the env/default limit, the number the operator compares;
  // once decided, today's limit says nothing about what was replaced.
  const effective = p.target.kind === "param" && p.target.key === "timeoutMs" ? limits.timeoutMs : limits.maxContinuations;
  const value = (v: string | number | null) => {
    if (v === null && p.status !== "pending") return "(env/default)";
    const n = v === null ? effective : v;
    const shown = p.target.kind === "param" && p.target.key === "timeoutMs" ? minutes(Number(n)) : String(n);
    return v === null && p.target.kind === "param" ? `${shown} (env/default)` : shown;
  };
  const change =
    p.target.kind === "prompt"
      ? `<div class="diff"><div><h4>now</h4><pre class="before">${escapeHtml(value(p.before))}</pre></div><div><h4>proposed</h4><pre class="after">${escapeHtml(value(p.after))}</pre></div></div>`
      : `<p class="paramchange"><span class="before">${escapeHtml(value(p.before))}</span> → <span class="after">${escapeHtml(value(p.after))}</span></p>`;
  const decided =
    p.status === "pending"
      ? `<div class="row">${act("accept and apply", { op: "proposal.decide", id: p.id, decision: "accepted" }, { cls: "good" })} ${act("reject", { op: "proposal.decide", id: p.id, decision: "rejected" }, { cls: "bad" })}</div>`
      : chip(p.status === "accepted" ? "accepted" : "rejected", p.status);
  return `<article class="card proposal ${p.status}">
    <header><b>${escapeHtml(target ?? `${p.target.kind}:${p.target.key}`)}</b>
      <span class="dim">proposed by ${escapeHtml(p.source)} · ${escapeHtml(ago(new Date(p.at).toISOString(), now))}</span></header>
    <p class="why">${escapeHtml(p.rationale)}</p>
    ${change}
    ${decided}
  </article>`;
}

function renderVerdict(v: Verdict, now: number): string {
  const r = v.ratification;
  const state = r
    ? `${chip(r.decision === "accepted" ? "accepted" : "overturned", r.decision === "accepted" ? "you accepted" : "you overturned")}${
        r.note ? ` <span class="dim">— ${escapeHtml(r.note)}</span>` : ""
      }`
    : `<div class="row" data-scope>
        ${act("accept", { op: "ratify", verdict: v.id, decision: "accepted" }, { cls: "good" })}
        <input data-field="note" placeholder="why it is not done (sent to the session)" maxlength="400">
        ${act("overturn", { op: "ratify", verdict: v.id, decision: "overturned" }, { cls: "bad" })}
      </div>`;
  return `<article class="card verdict${r ? " decided" : ""}">
    <header>${chip(`v-${v.reason}`, v.reason === "judged_complete" ? "judge said done" : "agent said done, unverified")}
      <b>${escapeHtml(v.session)}</b> <span class="dim">${escapeHtml(ago(v.ts, now))}</span></header>
    <p class="goal">${escapeHtml(clamp(v.goal || "(no goal recorded)", 400))}</p>
    ${v.judge ? `<p class="why">judge: ${escapeHtml(v.judge)}</p>` : ""}
    ${state}
  </article>`;
}

function renderReview(view: ControlView, now: number): string {
  const pending = view.policy.proposals.filter((p) => p.status === "pending");
  const decided = view.policy.proposals.filter((p) => p.status !== "pending").slice(0, 10);
  const open = view.review.filter((v) => !v.ratification);
  const accepted = view.review.filter((v) => v.ratification?.decision === "accepted").length;
  const overturned = view.review.filter((v) => v.ratification?.decision === "overturned").length;
  return `<section class="pane" data-pane="review">
  <div class="cols">
  <div>
    <h2>proposals — changes the loop suggests to itself</h2>
    <p class="note">After cycles settle, a model reads how they ended and your overturns, and proposes one change to a prompt or limit. Nothing changes until you accept. One proposal waits at a time.</p>
    <div class="row">${
      view.reflectAvailable
        ? pending.length
          ? '<span class="dim">decide the waiting proposal before asking for another</span>'
          : act("propose an improvement now", {}, { url: "/api/reflect", cls: "primary" })
        : '<span class="dim">no model configured (OMP_AUTO_LOOP_JUDGE_MODEL), so the loop cannot propose</span>'
    }</div>
    ${pending.map((p) => renderProposal(p, now, view.limits)).join("") || '<p class="empty">nothing waiting for review</p>'}
    ${decided.length ? `<details><summary>${decided.length} decided</summary>${decided.map((p) => renderProposal(p, now, view.limits)).join("")}</details>` : ""}
  </div>
  <div>
    <h2>done claims — confirm or overturn</h2>
    <p class="note"><b>${open.length}</b> to review · <b>${accepted}</b> accepted · <b>${overturned}</b> overturned. Overturning sends the reason to the session and puts the goal back to work.</p>
    ${open.slice(0, 30).map((v) => renderVerdict(v, now)).join("") || '<p class="empty">every claim has been reviewed</p>'}
    ${open.length > 30 ? `<p class="empty">and ${open.length - 30} older</p>` : ""}
    ${
      view.review.length - open.length > 0
        ? `<details><summary>${view.review.length - open.length} reviewed</summary>${view.review
            .filter((v) => v.ratification)
            .slice(0, 30)
            .map((v) => renderVerdict(v, now))
            .join("")}</details>`
        : ""
    }
  </div>
  </div>
</section>`;
}

function renderSteer(state: DashboardState, view: ControlView, now: number): string {
  const p = view.policy;
  const live = state.sessions.filter((s) => s.activeGoal || (s.lastSeen && now - Date.parse(s.lastSeen) < 86_400_000));
  const sessionOptions = live.map((s) => `<option value="${escapeHtml(s.label)}">${escapeHtml(s.label)}${s.activeGoal ? " · working" : ""}</option>`).join("");
  const repoNames = [...new Set([...state.repos.map((r) => r.name), ...Object.keys(p.gates), ...Object.keys(p.criteria)])].sort();
  const categoryOptions = `<option value="">no category</option>${p.categories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("")}`;
  const queued = p.queue.filter((q) => q.status !== "retired");

  const queueRows = queued
    .map((q, i) => {
      const cat = q.category ? p.categories.find((c) => c.id === q.category)?.label ?? q.category : categorize(p, q.objective)?.label;
      return `<tr class="${q.status}">
        <td class="pri">${i + 1}</td>
        <td>${escapeHtml(clamp(q.objective, 240))}<br><span class="dim">${q.repo ? `repo ${escapeHtml(q.repo)}` : "any repo"}${cat ? ` · ${escapeHtml(cat)}` : ""}</span></td>
        <td>${q.status === "claimed" ? chip("claimed", `claimed by ${q.claimedBy ?? "?"}`) : chip("queued")}</td>
        <td class="ops" data-scope>${
          q.status === "queued"
            ? `${act("↑", { op: "queue.priority", id: q.id, priority: (queued[i - 1]?.priority ?? q.priority) - 1 })}
               ${act("↓", { op: "queue.priority", id: q.id, priority: (queued[i + 1]?.priority ?? q.priority) + 1 })}
               <select data-field="target"><option value="">dispatch to…</option>${sessionOptions}</select>
               ${act("send", { op: "queue.dispatch", id: q.id })}`
            : ""
        } ${act("retire", { op: "queue.retire", id: q.id })}</td>
      </tr>`;
    })
    .join("");

  const paramRows = PARAMS.map((spec) => {
    const set = p.params[spec.key];
    if (spec.unit === "flag") {
      const on = flag(p, spec.key as "queueAutoPull" | "reflect");
      return `<tr><td><b>${escapeHtml(spec.label)}</b><br><span class="dim">${escapeHtml(spec.description)}</span></td>
        <td>${chip(on ? "on" : "off", on ? "on" : "off")}</td>
        <td>${act(on ? "turn off" : "turn on", { op: "param", key: spec.key, value: on ? 0 : 1 })}</td></tr>`;
    }
    const effective = spec.key === "timeoutMs" ? view.limits.timeoutMs : view.limits.maxContinuations;
    const shown = spec.unit === "ms" ? Math.round(effective / 60_000) : effective;
    return `<tr data-scope><td><b>${escapeHtml(spec.label)}</b><br><span class="dim">${escapeHtml(spec.description)}</span></td>
      <td>${spec.unit === "ms" ? minutes(effective) : effective}${set === undefined ? ' <span class="dim">(env/default)</span>' : ' <span class="dim">(set here)</span>'}</td>
      <td><input data-field="value" data-type="${spec.unit === "ms" ? "minutes" : "int"}" type="number" value="${shown}" min="${spec.unit === "ms" ? spec.min / 60_000 : spec.min}" max="${spec.unit === "ms" ? spec.max / 60_000 : spec.max}">${spec.unit === "ms" ? " min" : ""}
        ${act("set", { op: "param", key: spec.key })} ${set === undefined ? "" : act("reset", { op: "param", key: spec.key, value: null })}</td></tr>`;
  }).join("");

  const gateRows = repoNames
    .map((name) => {
      const cmds = p.gates[name] ?? [];
      const criteria = p.criteria[name] ?? "";
      const status = cmds.length
        ? chip("on", `${cmds.length} gate${cmds.length === 1 ? "" : "s"}`)
        : criteria
          ? chip("claimed", "judge-checked")
          : chip("off", "unverifiable");
      const prose = cmds.filter(looksLikeProse);
      const warnings = prose
        .map(
          (line) => `<p class="warn">"${escapeHtml(clamp(line, 80))}" reads as a sentence, not a command: it would fail every claim.
            ${act("move to done criteria", { op: "gate.toCriteria", repo: name, line }, { cls: "primary" })}</p>`,
        )
        .join("");
      return `<div class="card repo">
        <header><b>${escapeHtml(name)}</b> ${status}</header>
        <div data-scope>
          <h4>gate commands — each must exit 0</h4>
          <textarea data-field="commands" data-type="lines" rows="${Math.max(2, cmds.length + 1)}" placeholder="one shell command per line, run in the session's cwd, e.g. bun test">${escapeHtml(cmds.join("\n"))}</textarea>
          ${warnings}
          <div class="row">${act("save gates", { op: "gates", repo: name })}${cmds.length ? ` ${act("clear", { op: "gates", repo: name, commands: [] })}` : ""}</div>
        </div>
        <div data-scope>
          <h4>done criteria — the judge checks a claim against these${cmds.length ? " (unused while gates are set: gates decide)" : ""}</h4>
          <textarea data-field="text" rows="2" placeholder="what done means in this repo, in words, e.g. changes pushed to a PR and CI green">${escapeHtml(criteria)}</textarea>
          <div class="row">${act("save criteria", { op: "criteria", repo: name })}${criteria ? ` ${act("clear", { op: "criteria", repo: name, text: null })}` : ""}</div>
        </div>
      </div>`;
    })
    .join("");

  const promptBlocks = PROMPTS.map((spec) => {
    const custom = p.prompts[spec.key] !== undefined;
    return `<div class="prompt" data-scope>
      <h3>${escapeHtml(spec.label)} ${custom ? chip("on", "edited") : chip("idle", "default")}</h3>
      <p class="dim">${escapeHtml(spec.description)}</p>
      <textarea data-field="text" rows="6">${escapeHtml(promptText(p, spec.key))}</textarea>
      <div class="row">${act("save", { op: "prompt", key: spec.key })}${custom ? ` ${act("reset to default", { op: "prompt", key: spec.key, text: null })}` : ""}</div>
    </div>`;
  }).join("");

  return `<section class="pane" data-pane="steer">
  <div class="cols">
  <div>
    <h2>goal queue — what the loop works on next</h2>
    <form class="card" data-scope onsubmit="return false">
      <textarea data-field="objective" rows="3" placeholder="objective, as you would give it to an agent" required></textarea>
      <div class="row">
        <input data-field="repo" list="repos" placeholder="repo (blank = any)">
        <datalist id="repos">${repoNames.map((r) => `<option value="${escapeHtml(r)}">`).join("")}</datalist>
        <select data-field="category">${categoryOptions}</select>
        ${act("add to queue", { op: "queue.add" }, { cls: "primary" })}
      </div>
    </form>
    ${queueRows ? `<table class="queue">${queueRows}</table>` : '<p class="empty">queue is empty</p>'}

    <h2>guide a running session</h2>
    <div class="card" data-scope>
      <div class="row"><select data-field="target"><option value="">session…</option>${sessionOptions}</select></div>
      <textarea data-field="value" rows="2" placeholder="a correction or hint, delivered as the operator's words on its next turn"></textarea>
      <div class="row">${act("send guidance", { action: "guide" }, { url: "/api/action", cls: "primary" })}</div>
    </div>

    <h2>limits</h2>
    <table class="params">${paramRows}</table>
  </div>
  <div>
    <h2>verification per repo</h2>
    <p class="note"><b>Gate commands</b> are run when an agent claims done; the claim settles <b>verified_complete</b> only if every one exits 0. <b>Done criteria</b> are words the judge checks the claim's evidence against, for repos with no gate commands. With neither, "done" is the agent's word.</p>
    ${gateRows || '<p class="empty">no repos seen yet</p>'}
    <div class="card" data-scope><div class="row"><input data-field="repo" placeholder="another repo name">
      <input data-field="commands" data-type="lines" placeholder="gate command">${act("add gate", { op: "gates" })}</div></div>

    <h2>prompts the loop sends</h2>
    ${promptBlocks}
  </div>
  </div>
</section>`;
}

function renderTaxonomy(state: DashboardState, view: ControlView): string {
  const p = view.policy;
  const counts = (vocab: Vocabulary, id: string): string => {
    if (vocab === "event") return String(view.classCounts[id] ?? 0);
    if (vocab === "settle") return String(view.settleCounts[id] ?? 0);
    return "";
  };
  const tables = (Object.keys(VOCABULARIES) as Vocabulary[])
    .map((vocab) => {
      const terms = vocabulary(p, vocab);
      const rows = terms
        .map(
          (t) => `<tr data-scope class="${t.hidden ? "hidden" : ""}">
          <td><code>${escapeHtml(t.id)}</code>${t.custom ? ` ${chip("custom")}` : ""}</td>
          <td><input data-field="label" value="${escapeHtml(t.label)}"></td>
          <td><input data-field="description" value="${escapeHtml(t.description)}"></td>
          <td>${chip(t.usage === "branch" ? "branch" : "label", t.usage)}</td>
          <td class="num">${counts(vocab, t.id)}</td>
          <td>${act("save", { op: "term", vocab, id: t.id })}${
            vocab === "event" ? ` ${act(t.hidden ? "show in feed" : "hide from feed", { op: "term", vocab, id: t.id, hidden: !t.hidden })}` : ""
          }</td></tr>`,
        )
        .join("");
      const add = EXTENSIBLE.includes(vocab)
        ? `<tr data-scope class="add"><td><input data-field="id" placeholder="new_id"></td><td><input data-field="label" placeholder="label"></td>
           <td><input data-field="description" placeholder="what it means"></td><td>${chip("label")}</td><td></td>
           <td>${act("add term", { op: "term.add", vocab })}</td></tr>`
        : "";
      return `<h3>${escapeHtml(VOCABULARIES[vocab].label)}</h3>
        <table class="terms"><tr class="th"><td>id</td><td>label</td><td>description</td><td>usage</td><td class="num">count</td><td></td></tr>${rows}${add}</table>`;
    })
    .join("");

  // Rules only re-label chatter, so they may only point at label classes: a
  // rule filing "resumed:" under "continue" would make the feed misreport.
  const classes = vocabulary(p, "event")
    .filter((t) => t.usage === "label")
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`)
    .join("");
  const unmatched = Object.entries(view.settleCounts)
    .filter(([reason]) => !vocabulary(p, "settle").some((t) => t.id === reason))
    .map(([reason, count]) => `<li data-scope><code>${escapeHtml(reason)}</code> × ${count}
        <input data-field="label" placeholder="label" value="${escapeHtml(reason.replace(/[_:]/g, " "))}">
        <input data-field="description" placeholder="what it means">
        ${act("name it", { op: "term.add", vocab: "settle", id: reason })}</li>`)
    .join("");
  const unclassified = view.unclassified
    .map(
      (u) => `<li data-scope><code>${escapeHtml(u.prefix)}</code> × ${u.count}
        <select data-field="cls">${classes}</select> ${act("classify", { op: "rule", prefix: u.prefix })}</li>`,
    )
    .join("");
  const rules = p.rules
    .map((r) => `<li><code>${escapeHtml(r.prefix)}</code> → ${chip(r.cls)} ${act("remove", { op: "rule", prefix: r.prefix, cls: null })}</li>`)
    .join("");
  const goals = [...state.sessions.map((s) => s.goal), ...p.queue.map((q) => q.objective)].filter(Boolean);
  const categories = p.categories
    .map((c) => {
      const n = goals.filter((g) => categorize(p, g)?.id === c.id).length;
      return `<tr><td><code>${escapeHtml(c.id)}</code></td><td>${escapeHtml(c.label)}</td><td>${escapeHtml(c.keywords.join(", "))}</td><td class="num">${n}</td>
        <td>${act("remove", { op: "category.remove", id: c.id })}</td></tr>`;
    })
    .join("");

  return `<section class="pane" data-pane="taxonomy">
  <div class="cols">
  <div>
    <h2>vocabularies</h2>
    <p class="note"><b>branch</b> terms are read by the loop to choose what to do, so only their label and description change here. <b>label</b> terms are written, never branched on; event classes and settle reasons take new terms.</p>
    ${tables}
  </div>
  <div>
    <h2>unclassified messages</h2>
    <p class="note">Messages the loop files as "other", by prefix. A rule re-labels only "other", so it can never change how the loop replays its budget.</p>
    ${unclassified ? `<ul class="list">${unclassified}</ul>` : '<p class="empty">every message has a class</p>'}
    <h3>rules</h3>
    ${rules ? `<ul class="list">${rules}</ul>` : '<p class="empty">no rules</p>'}
    <h2>settle reasons with no term</h2>
    ${unmatched ? `<ul class="list">${unmatched}</ul>` : '<p class="empty">every settle reason is named</p>'}
    <h2>goal categories</h2>
    <p class="note">A goal belongs to the first category whose keyword it contains. Categories show on sessions and queued goals.</p>
    ${categories ? `<table class="terms"><tr class="th"><td>id</td><td>label</td><td>keywords</td><td class="num">goals</td><td></td></tr>${categories}</table>` : '<p class="empty">no categories</p>'}
    <div class="card" data-scope><div class="row"><input data-field="id" placeholder="id, e.g. infra"><input data-field="label" placeholder="label">
      <input data-field="keywords" data-type="list" placeholder="keywords, comma separated">${act("add category", { op: "category" })}</div></div>
  </div>
  </div>
</section>`;
}

function renderActivity(state: DashboardState, view: ControlView, now: number): string {
  const p = view.policy;
  const hidden = new Set(vocabulary(p, "event").filter((t) => t.hidden).map((t) => t.id));
  // Working sessions first, then the most recently heard from. Capped: the
  // projection keeps a hub per process ever seen, and a wall of long-dead
  // sessions buries the handful that matter.
  const shown = state.sessions.slice(0, 25);
  const more = state.sessions.length - shown.length;
  const rows = shown
    .map((s) => {
      const seen = ago(s.lastSeen, now);
      const budget = s.maxContinuations ? `${s.continuations}/${s.maxContinuations}` : "—";
      const cat = categorize(p, s.goal);
      return `<tr class="${s.activeGoal ? "live" : ""}">
      <td class="who"><b>${escapeHtml(s.label)}</b><br><span class="dim">${escapeHtml(s.model || "no model")}</span></td>
      <td class="state">${s.activeGoal ? '<span class="chip active">working</span>' : '<span class="chip idle">idle</span>'}
        <br><span class="dim">${escapeHtml(seen || "not seen this run")}</span></td>
      <td class="budget">${budget}<br><span class="dim">${s.heartbeats} nudges</span></td>
      <td class="goal" title="${escapeHtml(clamp(s.goal, 400))}">${cat ? `${chip("cat", cat.label)} ` : ""}${escapeHtml(clamp(s.goal) || "—")}</td>
      <td class="acts-col" data-scope><input data-field="value" placeholder="guide this session…">
        ${act("send", { action: "guide", target: s.label }, { url: "/api/action" })}</td>
    </tr>`;
    })
    .join("");

  let filtered = 0;
  const feed = state.decisions
    .filter((d) => {
      const cls = d.kind === "other" ? classifyWith(p, d.message) : d.kind;
      if (hidden.has(cls)) {
        filtered++;
        return false;
      }
      return true;
    })
    .slice(0, 60)
    .map((d) => {
      const cls = d.kind === "other" ? classifyWith(p, d.message) : d.kind;
      return `<li><span class="dim">${escapeHtml(shortTime(d.ts))}</span> ${chip(cls)}
      <span class="said">${escapeHtml(humanise(d))}</span>
      <span class="dim sess">${escapeHtml(clamp(d.session, 40))}</span></li>`;
    })
    .join("");

  return `<section class="pane" data-pane="activity">
  <div class="cols">
  <div>
    <h2>sessions — working first</h2>
    ${rows ? `<table>${rows}</table>` : '<p class="empty">no sessions recorded yet</p>'}
    ${more > 0 ? `<p class="empty">and ${more} older session${more === 1 ? "" : "s"} not shown</p>` : ""}
  </div>
  <div>
    <h2>decisions — newest first</h2>
    ${filtered ? `<p class="note">${filtered} event${filtered === 1 ? "" : "s"} hidden by taxonomy settings</p>` : ""}
    ${feed ? `<ul>${feed}</ul>` : '<p class="empty">no events recorded yet</p>'}
  </div>
  </div>
</section>`;
}

const DEFAULT_LIMITS = { maxContinuations: 3, timeoutMs: 30 * 60 * 1000 };

export function renderDashboard(state: DashboardState, view?: ControlView): string {
  const v = view ?? controlView(state, EMPTY_POLICY, DEFAULT_LIMITS, false);
  const now = Date.now();
  const working = state.sessions.filter((s) => s.activeGoal).length;
  // The honest number is the recent one. All-time is shown beside it rather
  // than instead of it, because a rate dragged down by settles from before the
  // judge existed says nothing about whether the judge works now.
  const rateOf = (mix: readonly { reason: string; count: number }[]) => {
    const judged = mix.find((x) => x.reason === "judged_complete")?.count ?? 0;
    const claimed = mix.find((x) => x.reason === "claimed_unverified")?.count ?? 0;
    return judged + claimed === 0 ? null : Math.round((judged / (judged + claimed)) * 100);
  };
  const recentRate = rateOf(state.recent.verdicts);
  const allTimeRate = rateOf(state.verdicts);
  const chips = (mix: readonly { reason: string; count: number }[]) =>
    mix
      .map((x) => `<span class="chip v-${escapeHtml(x.reason)}">${escapeHtml(x.reason.replace(/_/g, " "))} <b>${x.count}</b></span>`)
      .join(" ");

  const toReview = v.review.filter((x) => !x.ratification).length;
  const proposals = v.policy.proposals.filter((x) => x.status === "pending").length;
  const queued = v.policy.queue.filter((x) => x.status === "queued").length;
  const verified = state.verdicts.find((x) => x.reason === "verified_complete")?.count ?? 0;
  const gated = Object.keys(v.policy.gates).length;
  const banner =
    gated === 0 && verified === 0
      ? `<div class="banner">The loop cannot verify itself: no gates are configured, so every "done" is the agent's word or the judge's, and <b>verified_complete</b> has never fired. <a href="#steer">Configure gates per repo</a> — until then, review claims by hand.</div>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>omp auto-loop</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root { color-scheme: dark; }
 * { box-sizing: border-box; }
 body { margin: 0; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #0e1014; color: #d7dae0; }
 header.top { padding: 12px 20px; border-bottom: 1px solid #1d212b; display: flex;
          gap: 20px; align-items: baseline; position: sticky; top: 0; background: #0e1014; z-index: 3; flex-wrap: wrap; }
 h1 { font-size: 12px; margin: 0; letter-spacing: .14em; text-transform: uppercase; color: #6c7387; }
 .stat { color: #6c7387; }
 .stat b { color: #e8ebf2; font-size: 14px; }
 nav { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid #1d212b; position: sticky; top: 43px; background: #0e1014; z-index: 2; }
 nav a { padding: 9px 14px; color: #8b93a7; text-decoration: none; text-transform: uppercase;
         letter-spacing: .12em; font-size: 11px; border-bottom: 2px solid transparent; }
 nav a.on { color: #e8ebf2; border-bottom-color: #74bcf0; }
 nav a .n { background: #2a1f3d; color: #c5b6ff; border-radius: 8px; padding: 0 6px; margin-left: 5px; font-size: 10px; }
 .banner { margin: 12px 20px 0; padding: 10px 14px; border: 1px solid #5a4417; background: #241c0c; color: #e9cf8c; border-radius: 4px; }
 .banner a { color: #ffd97a; }
 .pane { display: none; padding: 14px 20px; }
 .pane.on { display: block; }
 .cols { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 28px; }
 @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
 h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .14em; color: #6c7387; margin: 18px 0 8px; }
 h2:first-child { margin-top: 4px; }
 h3 { font-size: 11.5px; color: #b9bfcc; margin: 14px 0 6px; }
 h4 { font-size: 10px; color: #6c7387; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .1em; }
 .note { color: #8b93a7; margin: 0 0 10px; }
 table { border-collapse: collapse; width: 100%; table-layout: fixed; }
 td { padding: 7px 10px 7px 0; border-bottom: 1px solid #171b23; vertical-align: top; overflow-wrap: anywhere; }
 tr.th td { color: #6c7387; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
 tr.live td { background: #12161d; }
 tr.hidden td { opacity: .5; }
 .who { width: 26%; } .state { width: 14%; } .budget { width: 11%; color: #b9bfcc; } .acts-col { width: 22%; }
 .goal { color: #aeb5c4; }
 .num { width: 60px; text-align: right; color: #b9bfcc; }
 table.terms td:nth-child(1) { width: 22%; } table.terms td:nth-child(4) { width: 70px; } table.terms td:last-child { width: 150px; }
 table.queue td.pri { width: 26px; color: #6c7387; } table.queue td:nth-child(3) { width: 130px; } table.queue td.ops { width: 230px; }
 table.params td:nth-child(2) { width: 150px; } table.params td:nth-child(3) { width: 200px; }
 table.gates td:first-child { width: 150px; } table.gates td:last-child { width: 110px; }
 ul { list-style: none; margin: 0; padding: 0; }
 li { padding: 7px 0; border-bottom: 1px solid #171b23; }
 ul.list li { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
 .said { color: #cfd4df; }
 .sess { display: block; }
 .dim { color: #5f6678; }
 code { color: #c9d1e0; }
 .chip { font-size: 10px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
         letter-spacing: .06em; background: #1d212b; color: #98a0b3; white-space: nowrap; }
 .chip.active, .chip.on, .chip.accepted, .chip.queued { background: #16351f; color: #79dd9b; }
 .chip.off, .chip.overturned, .chip.rejected { background: #341b1b; color: #ef8b85; }
 .chip.settled { background: #241f36; color: #a99aee; }
 .chip.goal, .chip.cat, .chip.claimed { background: #16293a; color: #74bcf0; }
 .chip.continue, .chip.custom { background: #332c17; color: #ddc472; }
 .chip.gate, .chip.branch { background: #341b1b; color: #ef8b85; }
 .v-claimed_unverified { background: #341b1b; color: #ef8b85; }
 .v-judged_complete { background: #16351f; color: #79dd9b; }
 .v-judge_unavailable { background: #332c17; color: #ddc472; }
 .empty { color: #5f6678; padding: 6px 0; }
 .verdicts { padding: 10px 20px; border-bottom: 1px solid #1d212b; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
 .verdicts h2 { margin: 0 8px 0 0; }
 .period { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: #6c7387; margin-left: 4px; }
 .period.alltime { margin-left: 16px; padding-left: 16px; border-left: 1px solid #1d212b; }
 .card { border: 1px solid #1d212b; background: #12151b; border-radius: 4px; padding: 10px 12px; margin: 0 0 10px; }
 .card header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
 .card.decided { opacity: .7; }
 .card .goal { margin: 4px 0; }
 .why { color: #c8cdd8; margin: 4px 0 8px; }
 .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
 .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
 pre { white-space: pre-wrap; margin: 0; padding: 8px; border-radius: 3px; font: inherit; max-height: 260px; overflow: auto; }
 pre.before { background: #1d1416; color: #e5b0ad; } pre.after { background: #12201a; color: #a8e2bd; }
 .paramchange .before { color: #ef8b85; } .paramchange .after { color: #79dd9b; font-weight: bold; }
 .prompt { margin-bottom: 14px; }
 .card.repo > div { margin-top: 8px; }
 .warn { color: #e9cf8c; background: #241c0c; border: 1px solid #5a4417; border-radius: 3px; padding: 6px 8px; margin: 6px 0; }
 input, select, textarea { font: inherit; background: #0b0d11; color: #d7dae0; border: 1px solid #2a3040; border-radius: 3px; padding: 4px 6px; }
 textarea { width: 100%; resize: vertical; }
 input { min-width: 0; flex: 1; }
 input[type=number] { width: 70px; flex: none; }
 td input { width: 100%; }
 button { font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer; background: #1d212b; color: #c3c9d6;
          border: 1px solid #2a3040; border-radius: 3px; white-space: nowrap; }
 button:hover { background: #262c39; color: #e8ebf2; }
 button.primary { background: #173049; border-color: #24507a; color: #cfe6ff; }
 button.good { background: #15301d; border-color: #25573a; color: #a9eec0; }
 button.bad { background: #331a1a; border-color: #5c2a2a; color: #f3b1ad; }
 button:disabled { opacity: .5; cursor: default; }
 details { margin: 8px 0; } summary { cursor: pointer; color: #8b93a7; }
 #toast { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px; border-radius: 4px; background: #341b1b; color: #f3b1ad; display: none; max-width: 480px; z-index: 9; }
</style></head>
<body>
<header class="top">
  <h1>omp auto-loop</h1>
  <span class="stat"><b>${state.sessions.length}</b> sessions</span>
  <span class="stat"><b>${working}</b> working</span>
  <span class="stat"><b>${state.decisions.length}</b> events</span>
  ${recentRate === null ? "" : `<span class="stat">corroborated <b>${recentRate}%</b> in ${state.recent.windowHours}h</span>`}
  <span class="stat"><b>${toReview}</b> claims to review</span>
  <span class="stat"><b>${proposals}</b> proposals</span>
  <span class="stat"><b>${queued}</b> queued</span>
</header>
<nav>
  <a href="#review">review${toReview + proposals ? `<span class="n">${toReview + proposals}</span>` : ""}</a>
  <a href="#steer">steer${queued ? `<span class="n">${queued}</span>` : ""}</a>
  <a href="#taxonomy">taxonomy</a>
  <a href="#activity">activity</a>
</nav>
${banner}
<div class="verdicts">
  <h2>how claims settled</h2>
  <span class="period">last ${state.recent.windowHours}h</span>
  ${chips(state.recent.verdicts) || '<span class="empty">nothing has settled recently</span>'}
  <span class="period alltime">all time${allTimeRate === null ? "" : ` · ${allTimeRate}% corroborated`}</span>
  ${chips(state.verdicts)}
</div>
${renderReview(v, now)}
${renderSteer(state, v, now)}
${renderTaxonomy(state, v)}
${renderActivity(state, v, now)}
<div id="toast"></div>
<script>
 const show = () => {
   // Panes carry data-pane, not an id: an id matching the hash would make the
   // browser scroll past the header and banner to the pane.
   const id = (location.hash || "#review").slice(1);
   for (const pane of document.querySelectorAll(".pane")) pane.classList.toggle("on", pane.dataset.pane === id);
   for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.getAttribute("href") === "#" + id);
 };
 addEventListener("hashchange", show);
 show();

 const toast = (text) => {
   const t = document.getElementById("toast");
   t.textContent = text; t.style.display = "block";
   setTimeout(() => (t.style.display = "none"), 6000);
 };
 const convert = (el) => {
   const raw = el.type === "checkbox" ? el.checked : el.value;
   switch (el.dataset.type) {
     case "int": return raw === "" ? undefined : Number.parseInt(raw, 10);
     case "minutes": return raw === "" ? undefined : Math.round(Number(raw) * 60000);
     case "lines": return String(raw).split("\\n").map((s) => s.trim()).filter(Boolean);
     case "list": return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
     default: return typeof raw === "string" ? raw.trim() : raw;
   }
 };
 let dirty = false;
 document.addEventListener("input", () => { dirty = true; });

 document.addEventListener("click", async (clicked) => {
   const button = clicked.target.closest("button[data-body]");
   if (!button) return;
   const body = JSON.parse(button.dataset.body);
   const scope = button.closest("[data-scope]");
   if (scope) {
     for (const el of scope.querySelectorAll("[data-field]")) {
       const value = convert(el);
       if (value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0 && body[el.dataset.field] !== undefined)) {
         body[el.dataset.field] = value;
       }
     }
   }
   if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
   button.disabled = true;
   const label = button.textContent;
   if (button.dataset.url === "/api/reflect") button.textContent = "thinking…";
   try {
     const response = await fetch(button.dataset.url, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify(body),
     });
     const reply = await response.json().catch(() => ({}));
     if (!response.ok) throw new Error(reply.error || "HTTP " + response.status);
     button.textContent = "done";
     dirty = false;
     setTimeout(() => location.reload(), 350);
   } catch (error) {
     button.textContent = label;
     button.disabled = false;
     toast(String(error.message || error));
   }
 });

 // Live without fighting the operator: refresh only while nothing is being typed.
 setInterval(() => {
   if (!dirty && !document.querySelector("input:focus, textarea:focus, select:focus")) location.reload();
 }, 20000);
</script></body></html>
`;
}

// -- Serving -----------------------------------------------------------------

/** The actions a caller may send over /api/action. */
const SENDABLE: readonly string[] = ACTIONS;

type Json = Record<string, unknown>;

/**
 * Serve the dashboard on loopback. A missing file renders as empty rather than
 * an error, because "nothing has run yet" is the honest first thing a fresh
 * install shows.
 */
export function createDashboard(options: {
  port: number;
  readProjection: () => string;
  /** The event log, which is the record rather than the projection. */
  readEvents?: () => string;
  /** policy.jsonl text. Absent means an empty policy. */
  readPolicy?: () => string;
  /** Append a policy op. Absent means policy routes refuse. */
  writePolicy?: (op: PolicyOp) => void;
  /** Append a steering command. Absent means the page cannot steer. */
  steer?: (command: { target: string; action: string; value?: string }) => void;
  /** Run the reflect pass and file a proposal. Absent means no model. */
  reflect?: () => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Limits a session without its own override runs with now. */
  limits?: () => { maxContinuations: number; timeoutMs: number };
  host?: string;
  onError?: (message: string) => void;
  /** Fired only once the port is actually bound, so nobody announces a URL that never came up. */
  onListening?: (url: string) => void;
}): { close: () => void; url: string } {
  const host = options.host ?? "127.0.0.1";
  // Imported lazily so the pure half of this module stays importable without
  // a runtime that has http, exactly like the rest of lib/.
  const http = require("node:http") as typeof Http;

  const read = (f?: () => string): string => {
    try {
      return f?.() ?? "";
    } catch {
      return "";
    }
  };

  const reply = (res: Http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const projection = read(options.readProjection);
    const events = read(options.readEvents);
    const policy = foldPolicy(read(options.readPolicy));

    // Every route that changes anything has to be hard to reach by accident.
    // Three gates, none of them optional:
    //
    //   * POST only — a GET can be triggered by an <img> tag on any page.
    //   * `application/json` required, and no CORS headers ever sent, so a
    //     cross-origin caller cannot send it: a JSON content type is not a
    //     CORS-simple request, the preflight fails, and the browser never
    //     sends the POST. That is what stops another page steering the loop.
    //   * loopback bind, so it is not reachable off the machine at all.
    const writeRoute = (handle: (body: Json) => void | Promise<void>, enabled: boolean, what: string) => {
      if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
      if (!(req.headers["content-type"] ?? "").includes("application/json")) {
        return reply(res, 415, { error: "content-type must be application/json" });
      }
      if (!enabled) return reply(res, 403, { error: `${what} is not enabled` });
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        // A prompt is the largest legitimate body; anything far past it is not one.
        if (raw.length > 32_768) req.destroy();
      });
      req.on("end", async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          return reply(res, 400, { error: "malformed json" });
        }
        try {
          await handle((parsed ?? {}) as Json);
        } catch (error) {
          reply(res, 500, { error: String(error) });
        }
      });
    };

    if (path === "/api/action") {
      return writeRoute(
        (record) => {
          const action = typeof record.action === "string" ? record.action : "";
          const target = typeof record.target === "string" && record.target ? record.target : ALL_SESSIONS;
          if (!SENDABLE.includes(action)) return reply(res, 400, { error: `unknown action: ${action}` });
          // An objective or guidance with no text would leave the session with
          // an instruction that names nothing.
          const value = typeof record.value === "string" ? record.value : undefined;
          if ((NEEDS_VALUE as readonly string[]).includes(action) && !value?.trim()) {
            return reply(res, 400, { error: `${action === "goal" ? "goal needs a non-empty objective" : `${action} needs text`}` });
          }
          options.steer?.({ target, action, value });
          reply(res, 202, { ok: true, target, action });
        },
        !!options.steer,
        "steering",
      );
    }

    // GET reads the folded policy below; every other method is a write attempt
    // and goes through the write gates, which refuse anything but a JSON POST.
    if (path === "/api/policy" && req.method !== "GET") {
      return writeRoute(
        (record) => {
          // A prose line saved as a gate is a definition of done in the wrong
          // field: move it to the repo's criteria and out of its gate set.
          if (record.op === "gate.toCriteria") {
            const repo = typeof record.repo === "string" ? record.repo : "";
            const line = typeof record.line === "string" ? record.line : "";
            const gates = policy.gates[repo] ?? [];
            if (!gates.includes(line)) return reply(res, 404, { error: "no such gate line" });
            const existing = policy.criteria[repo] ?? "";
            options.writePolicy?.({ op: "criteria", repo, text: existing ? `${existing}\n${line}` : line });
            options.writePolicy?.({ op: "gates", repo, commands: gates.filter((g) => g !== line) });
            return reply(res, 202, { ok: true });
          }
          // Dispatch is two writes for one intent: claim the item, then hand
          // its objective to the chosen session.
          if (record.op === "queue.dispatch") {
            const item = policy.queue.find((q) => q.id === record.id);
            const target = typeof record.target === "string" ? record.target : "";
            if (!item || item.status !== "queued") return reply(res, 404, { error: "no queued item with that id" });
            if (!target) return reply(res, 400, { error: "choose a session to dispatch to" });
            if (!options.steer) return reply(res, 403, { error: "steering is not enabled" });
            options.writePolicy?.({ op: "queue.claim", id: item.id, session: target });
            options.steer({ target, action: "goal", value: item.objective });
            return reply(res, 202, { ok: true });
          }
          const body = record.op === "queue.add" && !record.id ? { ...record, id: `q-${Date.now().toString(36)}` } : record;
          const checked = validateOp(body);
          if ("error" in checked) return reply(res, 400, { error: checked.error });
          options.writePolicy?.(checked.op);
          // Overturning a "done" is only half a decision until the session
          // hears it: the same goal goes back to work, with the reason.
          if (checked.op.op === "ratify" && checked.op.decision === "overturned" && options.steer) {
            const session = checked.op.verdict.slice(0, checked.op.verdict.lastIndexOf("@"));
            if (session) options.steer({ target: session, action: "reopen", value: checked.op.note });
          }
          reply(res, 202, { ok: true });
        },
        !!options.writePolicy,
        "policy editing",
      );
    }

    if (path === "/api/reflect") {
      return writeRoute(
        async () => {
          const result = await options.reflect!();
          if (result.ok) reply(res, 201, result);
          else reply(res, 409, { error: result.error });
        },
        !!options.reflect,
        "the reflect pass",
      );
    }

    const state = parseProjection(projection, events);
    const view = () =>
      controlView(state, policy, options.limits?.() ?? DEFAULT_LIMITS, !!options.reflect);

    if (path === "/api/state") return reply(res, 200, state);
    if (path === "/api/taxonomy") return reply(res, 200, taxonomyReport(events));
    if (path === "/api/policy") return reply(res, 200, policy);
    if (path === "/api/review") return reply(res, 200, view().review);
    if (path !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(state, view()));
  });

  // `listen` reports failure asynchronously, so a try/catch around this call
  // catches nothing: a taken port surfaces as an 'error' event, and an
  // unhandled one takes the whole process down — the loop dies because its
  // dashboard could not have a port. Report and stay up instead.
  const url = `http://${host}:${options.port}/`;
  server.on("error", (error: Error) => {
    options.onError?.(error.message);
  });
  server.on("listening", () => {
    options.onListening?.(url);
  });
  server.listen(options.port, host);

  return {
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed, or never bound: nothing to release.
      }
    },
    url,
  };
}

/** Reads and appends files; each host binds it to node:fs. */
export interface DashboardFiles {
  /** File text, or "" when the file does not exist. */
  read(path: string): string;
  /** Append, creating the file and its directory as needed. */
  append(path: string, text: string): void;
}

/**
 * The dashboard over the loop's state files, wired the one way both hosts
 * use: an omp session (auto-loop.ts) and the supervised dashboard-server.ts.
 */
export function hostDashboard(options: {
  port: number;
  /** events.jsonl; policy.jsonl, control.jsonl and graph.lines sit beside it. */
  statusFile: string;
  files: DashboardFiles;
  /** The judge model, which the reflect pass also uses. Absent means no proposals. */
  chat?: ChatPort;
  limits: () => { maxContinuations: number; timeoutMs: number };
  onError?: (message: string) => void;
  onListening?: (url: string) => void;
}): { close: () => void; url: string } {
  const { files, statusFile, chat } = options;
  const stateDir = statusFile.slice(0, statusFile.lastIndexOf("/"));
  const policyFile = `${stateDir}/policy.jsonl`;
  const writePolicy = (op: PolicyOp) => files.append(policyFile, encodeOp(op, Date.now(), "dashboard"));
  return createDashboard({
    port: options.port,
    readProjection: () => files.read(`${stateDir}/graph.lines`),
    readEvents: () => files.read(statusFile),
    readPolicy: () => files.read(policyFile),
    writePolicy,
    limits: options.limits,
    reflect: chat
      ? () => {
          const rows = parseEvents(files.read(statusFile));
          return proposeImprovement({
            chat,
            policy: foldPolicy(files.read(policyFile)),
            events: rows.map((d) => ({ ts: d.ts, session: d.session, msg: d.message })),
            limits: options.limits(),
            mix: verdictMix(rows, Date.now(), 24),
            append: writePolicy,
            source: "dashboard",
            nowMs: Date.now(),
          });
        }
      : undefined,
    // Append, never rewrite: every session reads this file and appends to it,
    // so a read-modify-write would drop whichever steering landed in the window.
    steer: (command) =>
      files.append(
        `${stateDir}/control.jsonl`,
        encodeCommand({
          at: Date.now(),
          target: command.target,
          action: command.action as ControlAction,
          value: command.value,
          by: "dashboard",
        }),
      ),
    onError: options.onError,
    onListening: options.onListening,
  });
}
