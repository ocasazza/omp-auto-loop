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

export interface DecisionRow {
  readonly ts: string;
  readonly session: string;
  readonly kind: string;
  readonly message: string;
}

export interface DashboardState {
  readonly sessions: readonly SessionRow[];
  readonly decisions: readonly DecisionRow[];
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
export function parseProjection(text: string): DashboardState {
  const sessions: SessionRow[] = [];
  const decisions: DecisionRow[] = [];

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
    } else if (node.kind === "event") {
      const ts = node.props.get("ts") ?? "";
      if (!ts) continue;
      decisions.push({
        ts,
        session: node.props.get("sess") ?? "",
        kind: node.tags[0] ?? "other",
        message: node.title,
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

  return { sessions, decisions };
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
  return message;
}

const chip = (kind: string): string => `<span class="chip ${escapeHtml(kind)}">${escapeHtml(kind)}</span>`;

export function renderDashboard(state: DashboardState): string {
  const working = state.sessions.filter((s) => s.activeGoal).length;
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
</style></head>
<body>
<header>
  <h1>omp auto-loop</h1>
  <span class="stat"><b>${state.sessions.length}</b> sessions</span>
  <span class="stat"><b>${working}</b> working</span>
  <span class="stat"><b>${state.decisions.length}</b> events</span>
</header>
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
</body></html>
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
  host?: string;
  onError?: (message: string) => void;
}): { close: () => void; url: string } {
  const host = options.host ?? "127.0.0.1";
  // Imported lazily so the pure half of this module stays importable without
  // a runtime that has http, exactly like the rest of lib/.
  const http = require("node:http") as typeof import("node:http");

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    let projection = "";
    try {
      projection = options.readProjection();
    } catch {
      projection = "";
    }

    if (path === "/api/state") {
      const state = parseProjection(projection);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    if (path !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(parseProjection(projection)));
  });

  // `listen` reports failure asynchronously, so a try/catch around this call
  // catches nothing: a taken port surfaces as an 'error' event, and an
  // unhandled one takes the whole process down — the loop dies because its
  // dashboard could not have a port. Report and stay up instead.
  server.on("error", (error: Error) => {
    options.onError?.(error.message);
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
    url: `http://${host}:${options.port}/`,
  };
}
