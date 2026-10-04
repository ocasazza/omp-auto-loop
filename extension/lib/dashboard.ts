// The auto-loop's own dashboard: the human surface for "what is the loop doing".
//
// `dashboardPort` was reserved in config from the start and nothing ever served
// it — `/autoloop open-dashboard` opened the jump-cannon canvas, which is a
// graph of five thousand nodes and answers a different question. This serves
// the port the command already points at.
//
// Stdlib only, like the rest of the extension. Everything reads graph.lines,
// which already carries both halves of the answer: session nodes hold the live
// state (goal, continuations, status, outcome) and event nodes hold the
// decision history. Parsing is pure and separate from serving so it can be
// tested without a socket or a filesystem.

import { ALL_SESSIONS } from "./control.ts";
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

export interface DashboardState {
  readonly sessions: readonly SessionRow[];
  readonly decisions: readonly DecisionRow[];
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
  const decisions: DecisionRow[] = eventsText === undefined ? [] : parseEvents(eventsText);

  for (const line of text.split("\n")) {
    if (!line.startsWith("N|")) continue;
    const node = splitNode(line);

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
        lastSeen: "",
      });
    }
  }

  // Newest first: a feed is read from the top.
  decisions.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  // A fresh install accumulates a session hub per process ever seen. Ordering
  // by what is working now, then by when each was last heard from, keeps the
  // page about the loop rather than about its history.
  const lastSeen = new Map<string, string>();
  for (const d of decisions) {
    if (!d.session) continue;
    if (!lastSeen.has(d.session)) lastSeen.set(d.session, d.ts);
  }

  for (const s of sessions) {
    (s as { lastSeen: string }).lastSeen = lastSeen.get(s.label) ?? "";
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

/** The actions a caller may send. Anything else is refused, not ignored. */
const SENDABLE: readonly string[] = ["pause", "resume", "disable", "enable", "goal"];

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
  return message;
}

const chip = (kind: string): string => `<span class="chip ${escapeHtml(kind)}">${escapeHtml(kind)}</span>`;

export function renderDashboard(state: DashboardState): string {
  const working = state.sessions.filter((s) => s.activeGoal).length;
  // The honest number is the recent one. All-time is shown beside it rather
  // than instead of it, because a rate dragged down by settles from before the
  // judge existed says nothing about whether the judge works now.
  const rateOf = (mix: readonly { reason: string; count: number }[]) => {
    const judged = mix.find((v) => v.reason === "judged_complete")?.count ?? 0;
    const claimed = mix.find((v) => v.reason === "claimed_unverified")?.count ?? 0;
    return judged + claimed === 0 ? null : Math.round((judged / (judged + claimed)) * 100);
  };
  const recentRate = rateOf(state.recent.verdicts);
  const allTimeRate = rateOf(state.verdicts);

  const chips = (mix: readonly { reason: string; count: number }[]) =>
    mix
      .map((v) => `<span class="chip v-${escapeHtml(v.reason)}">${escapeHtml(v.reason.replace(/_/g, " "))} <b>${v.count}</b></span>`)
      .join(" ");

  const actions = (target: string, label: string) => `<div class="acts" data-target="${escapeHtml(target)}">
      <button data-act="pause">pause</button>
      <button data-act="resume">resume</button>
      <button data-act="disable">disable</button>
      <button data-act="enable">enable</button>
      <button data-act="goal" data-prompt="new objective for ${escapeHtml(label)}">set goal</button>
    </div>`;
  // Working sessions first, then the most recently heard from. Capped: the
  // projection keeps a hub per process ever seen, and a wall of long-dead
  // sessions buries the handful that matter.
  const shown = state.sessions.slice(0, 25);
  const hidden = state.sessions.length - shown.length;

  const now = Date.now();
  const rows = shown
    .map((s) => {
      const seen = ago(s.lastSeen, now);
      const budget = s.maxContinuations ? `${s.continuations}/${s.maxContinuations}` : "—";
      return `<tr class="${s.activeGoal ? "live" : ""}">
      <td class="who"><b>${escapeHtml(s.label)}</b><br><span class="dim">${escapeHtml(s.model || "no model")}</span></td>
      <td class="state">${s.activeGoal ? '<span class="chip active">working</span>' : '<span class="chip idle">idle</span>'}
        <br><span class="dim">${escapeHtml(seen || "not seen this run")}</span></td>
      <td class="budget">${budget}<br><span class="dim">${s.heartbeats} nudges</span></td>
      <td class="goal" title="${escapeHtml(clamp(s.goal, 400))}">${escapeHtml(clamp(s.goal) || "—")}</td>
      <td class="acts-col">${actions(s.label, s.label)}</td>
    </tr>`;
    })
    .join("");

  const feed = state.decisions
    .slice(0, 60)
    .map(
      (d) => `<li><span class="dim">${escapeHtml(shortTime(d.ts))}</span> ${chip(d.kind)}
      <span class="said">${escapeHtml(humanise(d))}</span>
      <span class="dim sess">${escapeHtml(clamp(d.session, 40))}</span></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>omp auto-loop</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root { color-scheme: dark; }
 * { box-sizing: border-box; }
 body { margin: 0; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #0e1014; color: #d7dae0; }
 header { padding: 12px 20px; border-bottom: 1px solid #1d212b; display: flex;
          gap: 20px; align-items: baseline; position: sticky; top: 0; background: #0e1014; z-index: 2; }
 h1 { font-size: 12px; margin: 0; letter-spacing: .14em; text-transform: uppercase; color: #6c7387; }
 .stat { color: #6c7387; }
 .stat b { color: #e8ebf2; font-size: 14px; }
 main { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
 @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
 section { padding: 14px 20px; min-width: 0; }
 section + section { border-left: 1px solid #1d212b; }
 h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .14em;
      color: #6c7387; margin: 0 0 10px; }
 table { border-collapse: collapse; width: 100%; table-layout: fixed; }
 td { padding: 8px 10px 8px 0; border-bottom: 1px solid #171b23; vertical-align: top; }
 tr.live td { background: #12161d; }
 .who { width: 30%; overflow-wrap: anywhere; }
 .state { width: 18%; }
 .budget { width: 13%; color: #b9bfcc; }
 .goal { color: #aeb5c4; overflow-wrap: anywhere; }
 ul { list-style: none; margin: 0; padding: 0; }
 li { padding: 7px 0; border-bottom: 1px solid #171b23; }
 .said { color: #cfd4df; }
 .sess { display: block; }
 time { color: #6c7387; }
 .dim { color: #5f6678; }
 .chip { font-size: 10px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
         letter-spacing: .06em; background: #1d212b; color: #98a0b3; white-space: nowrap; }
 .chip.active { background: #16351f; color: #79dd9b; }
 .chip.settled { background: #241f36; color: #a99aee; }
 .chip.goal { background: #16293a; color: #74bcf0; }
 .chip.continue { background: #332c17; color: #ddc472; }
 .chip.gate { background: #341b1b; color: #ef8b85; }
 .empty { color: #5f6678; padding: 6px 0; }
 .verdicts { padding: 10px 20px; border-bottom: 1px solid #1d212b; display: flex;
             gap: 10px; align-items: baseline; flex-wrap: wrap; }
 .verdicts h2 { margin: 0 8px 0 0; }
 .period { font-size: 10px; text-transform: uppercase; letter-spacing: .12em;
           color: #6c7387; margin-left: 4px; }
 .period.alltime { margin-left: 16px; padding-left: 16px; border-left: 1px solid #1d212b; }
 .v-claimed_unverified { background: #341b1b; color: #ef8b85; }
 .v-judged_complete { background: #16351f; color: #79dd9b; }
 .v-judge_unavailable { background: #332c17; color: #ddc472; }
 .acts-col { width: 15%; }
 .acts { display: flex; gap: 3px; flex-wrap: wrap; }
 .acts button { font: inherit; font-size: 10px; padding: 2px 6px; cursor: pointer;
                background: #1d212b; color: #aeb5c4; border: 1px solid #2a3040;
                border-radius: 3px; }
 .acts button:hover { background: #262c39; color: #e8ebf2; }
 .acts button:disabled { opacity: .5; cursor: default; }
</style></head>
<body>
<header>
  <h1>omp auto-loop</h1>
  <span class="stat"><b>${state.sessions.length}</b> sessions</span>
  <span class="stat"><b>${working}</b> working</span>
  <span class="stat"><b>${state.decisions.length}</b> events</span>
  ${recentRate === null ? "" : `<span class="stat">corroborated <b>${recentRate}%</b> in ${state.recent.windowHours}h</span>`}
</header>
<div class="verdicts">
  <h2>how claims settled</h2>
  <span class="period">last ${state.recent.windowHours}h</span>
  ${chips(state.recent.verdicts) || '<span class="empty">nothing has settled recently</span>'}
  <span class="period alltime">all time${allTimeRate === null ? "" : ` · ${allTimeRate}% corroborated`}</span>
  ${chips(state.verdicts)}
</div>
<main>
  <section>
    <h2>sessions — working first</h2>
    ${rows ? `<table>${rows}</table>` : '<p class="empty">no sessions recorded yet</p>'}
    ${hidden > 0 ? `<p class="empty">and ${hidden} older session${hidden === 1 ? "" : "s"} not shown</p>` : ""}
  </section>
  <section>
    <h2>decisions — newest first</h2>
    ${feed ? `<ul>${feed}</ul>` : '<p class="empty">no events recorded yet</p>'}
  </section>
</main>
<script>
 document.addEventListener("click", async (clicked) => {
   const button = clicked.target.closest("button[data-act]");
   if (!button) return;
   const action = button.dataset.act;
   const target = button.closest("[data-target]").dataset.target;
   let value;
   if (action === "goal") {
     value = prompt(button.dataset.prompt || "new objective");
     if (!value || !value.trim()) return;
   }
   button.disabled = true;
   try {
     const response = await fetch("/api/action", {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ target, action, value }),
     });
     const body = await response.json();
     button.textContent = response.ok ? "sent" : (body.error || "failed");
     setTimeout(() => location.reload(), 700);
   } catch (error) {
     button.textContent = "failed";
   }
 });
</script></body></html>
`;
}

/**
 * Serve the dashboard on loopback. Read-only: the routes are the page and its
 * state, and nothing here writes. A missing projection renders an empty page
 * rather than an error, because "nothing has run yet" is the honest first
 * thing a fresh install shows.
 */
export function createDashboard(options: {
  port: number;
  readProjection: () => string;
  /** The event log, which is the record rather than the projection. */
  readEvents?: () => string;
  /** Append a steering command. Absent means the page is read-only. */
  steer?: (command: { target: string; action: string; value?: string }) => void;
  host?: string;
  onError?: (message: string) => void;
  /** Fired only once the port is actually bound, so nobody announces a URL that never came up. */
  onListening?: (url: string) => void;
}): { close: () => void; url: string } {
  const host = options.host ?? "127.0.0.1";
  // Imported lazily so the pure half of this module stays importable without
  // a runtime that has http, exactly like the rest of lib/.
  const http = require("node:http") as typeof import("node:http");

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    let projection = "";
    let events = "";
    try {
      projection = options.readProjection();
    } catch {
      projection = "";
    }
    try {
      events = options.readEvents?.() ?? "";
    } catch {
      events = "";
    }

    // Steering is the one route that changes anything, so it is the one that
    // has to be hard to reach by accident. Three gates, none of them optional:
    //
    //   * POST only — a GET can be triggered by an <img> tag on any page.
    //   * `application/json` required, and no CORS headers ever sent, so a
    //     cross-origin caller cannot send it: a JSON content type is not a
    //     CORS-simple request, the preflight fails, and the browser never
    //     sends the POST. That is what stops another page steering the loop.
    //   * loopback bind, so it is not reachable off the machine at all.
    if (path === "/api/action") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "POST only" }));
        return;
      }
      if (!(req.headers["content-type"] ?? "").includes("application/json")) {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "content-type must be application/json" }));
        return;
      }
      if (!options.steer) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "steering is not enabled" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        // A steering command is a few hundred bytes; a large body is not one.
        if (body.length > 8_192) req.destroy();
      });
      req.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "malformed json" }));
          return;
        }
        const record = (parsed ?? {}) as Record<string, unknown>;
        const action = typeof record.action === "string" ? record.action : "";
        const target = typeof record.target === "string" && record.target ? record.target : ALL_SESSIONS;
        if (!SENDABLE.includes(action)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `unknown action: ${action}` }));
          return;
        }
        // An objective with no text would leave the loop with an active goal
        // that names nothing, which is the shape of record the projection
        // refuses to write.
        if (action === "goal" && !(typeof record.value === "string" && record.value.trim())) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "goal needs a non-empty objective" }));
          return;
        }
        try {
          options.steer?.({
            target,
            action,
            value: typeof record.value === "string" ? record.value : undefined,
          });
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, target, action }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
      return;
    }
    if (path === "/api/state") {
      const state = parseProjection(projection, events);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    if (path === "/api/taxonomy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(taxonomyReport(events)));
      return;
    }
    if (path !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(parseProjection(projection, events)));
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
