// The reflect pass: the loop proposing a change to itself.
//
// After cycles settle, a model reads how they ended and the operator's
// feedback, and proposes exactly one change to the loop's prompts or limits.
// The proposal lands in policy.jsonl as pending; nothing changes until a human
// accepts it on the dashboard. One pending proposal at a time, so the queue is
// a decision, not a backlog.
//
// Pure except for the injected ChatPort.

import type { ChatPort } from "./model.ts";
import {
  PROMPTS,
  promptText,
  validValue,
  type LogEvent,
  type Policy,
  type PolicyOp,
  type ProposalTarget,
} from "./policy.ts";

export interface Cycle {
  readonly session: string;
  readonly goal: string;
  readonly reason: string;
  /** What the loop said during the cycle, oldest first. */
  readonly trail: readonly string[];
}

export interface ReflectInput {
  readonly prompts: Readonly<Record<string, string>>;
  readonly limits: { readonly maxContinuations: number; readonly timeoutMs: number };
  readonly mix: readonly { readonly reason: string; readonly count: number }[];
  readonly cycles: readonly Cycle[];
  /** Human overturns of "done": the strongest signal the loop gets. */
  readonly overturned: readonly { readonly goal: string; readonly note: string }[];
  /** Each rejected change in the same target names and units the model proposes in. */
  readonly rejected: readonly { readonly proposal: string; readonly rationale: string }[];
}

export interface Reflection {
  readonly target: ProposalTarget;
  readonly after: string | number;
  readonly rationale: string;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The cycles that settled most recently, each with the messages that led to its settle. */
export function recentCycles(events: readonly LogEvent[], limit: number): Cycle[] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const open = new Map<string, { goal: string; trail: string[] }>();
  const cycles: Cycle[] = [];
  for (const e of sorted) {
    const cur = open.get(e.session) ?? { goal: "", trail: [] };
    if (e.msg.startsWith("goal set: ")) {
      open.set(e.session, { goal: e.msg.slice("goal set: ".length), trail: [] });
      continue;
    }
    if (e.msg.startsWith("settled: ")) {
      cycles.push({ session: e.session, goal: cur.goal, reason: e.msg.slice("settled: ".length).trim(), trail: cur.trail.slice(-8) });
      open.set(e.session, { goal: cur.goal, trail: [] });
      continue;
    }
    cur.trail.push(clip(e.msg, 160));
    open.set(e.session, cur);
  }
  return cycles.slice(-limit);
}

export function reflectInput(
  events: readonly LogEvent[],
  policy: Policy,
  limits: ReflectInput["limits"],
  mix: ReflectInput["mix"],
): ReflectInput {
  const goals = new Map<string, string>();
  for (const e of events) if (e.msg.startsWith("goal set: ")) goals.set(e.session, e.msg.slice("goal set: ".length));
  const overturned = Object.entries(policy.ratifications)
    .filter(([, r]) => r.decision === "overturned")
    .slice(-5)
    .map(([id, r]) => ({ goal: goals.get(id.slice(0, id.lastIndexOf("@"))) ?? "", note: r.note ?? "" }));
  return {
    prompts: Object.fromEntries(PROMPTS.map((p) => [p.key, promptText(policy, p.key)])),
    limits,
    mix,
    cycles: recentCycles(events, 8),
    overturned,
    rejected: policy.proposals
      .filter((p) => p.status === "rejected")
      .slice(0, 5)
      .map((p) => ({ proposal: describe(p.target, p.after), rationale: p.rationale })),
  };
}

/** A change as the model would have written it: its target name, its units. */
function describe(target: ProposalTarget, after: string | number): string {
  const [name, spec] = Object.entries(TARGETS).find(([, s]) => s.target.kind === target.kind && s.target.key === target.key) ?? [
    `${target.kind}:${target.key}`,
    { scale: 1 },
  ];
  return target.kind === "prompt" ? `${name} = "${clip(String(after), 160)}"` : `${name} = ${Number(after) / spec.scale}`;
}

/**
 * What the model may name, and how its value maps onto the policy. The time
 * limit is offered in minutes: a small model reading a millisecond figure
 * proposed 60 minutes while its own rationale said 10.
 */
const TARGETS: Readonly<Record<string, { target: ProposalTarget; scale: number }>> = {
  ...Object.fromEntries(PROMPTS.map((p) => [`prompt:${p.key}`, { target: { kind: "prompt", key: p.key }, scale: 1 }])),
  "param:maxContinuations": { target: { kind: "param", key: "maxContinuations" }, scale: 1 },
  "param:timeoutMinutes": { target: { kind: "param", key: "timeoutMs" }, scale: 60_000 },
};

export function buildReflectPrompt(input: ReflectInput): string {
  const lines = [
    "You improve an autonomous coding loop. The loop sends the CONTINUATION DIRECTIVE to an agent",
    "each time it decides the agent should keep working. When an agent claims completion, a judge",
    "checks the evidence, applying the EXTRA JUDGE CRITERIA on top of its fixed rubric.",
    "",
    "Propose exactly ONE change most likely to raise the share of cycles that end in corroborated",
    "completion (judged_complete, verified_complete) and lower cycle_timeout, continuation_limit and",
    "claimed_unverified. Ground the change in the evidence below; do not repeat a rejected proposal.",
    "",
    "--- CONTINUATION DIRECTIVE ---",
    input.prompts.continuation ?? "",
    "",
    "--- EXTRA JUDGE CRITERIA ---",
    input.prompts.judgeCriteria || "(none)",
    "",
    "--- LIMITS ---",
    `maxContinuations: ${input.limits.maxContinuations} (continuations per cycle)`,
    `timeoutMinutes: ${Math.round(input.limits.timeoutMs / 60_000)} (minutes per cycle)`,
    "",
    "--- HOW CYCLES ENDED (last 24h) ---",
    input.mix.map((m) => `${m.reason}: ${m.count}`).join("\n") || "(none)",
    "",
    "--- RECENT CYCLES ---",
    ...input.cycles.map(
      (c) => `* goal: ${clip(c.goal || "(none)", 200)}\n  ended: ${c.reason}\n  trail: ${c.trail.join(" | ") || "(none)"}`,
    ),
  ];
  if (input.overturned.length > 0) {
    lines.push("", "--- COMPLETIONS THE OPERATOR OVERTURNED ---", ...input.overturned.map((o) => `* ${clip(o.goal, 200)} — ${o.note || "no note"}`));
  }
  if (input.rejected.length > 0) {
    lines.push("", "--- PROPOSALS THE OPERATOR REJECTED ---", ...input.rejected.map((r) => `* ${r.proposal} — ${clip(r.rationale, 200)}`));
  }
  lines.push(
    "",
    `Allowed targets: ${Object.keys(TARGETS).join(", ")}.`,
    "For a prompt target, \"after\" is the complete new text. For maxContinuations, an integer 0-50.",
    "For timeoutMinutes, an integer number of minutes 1-360.",
    "Reply with only one JSON object and nothing else:",
    '{"target": "<target>", "after": <new value>, "rationale": "<one or two sentences citing the evidence>"}',
  );
  return lines.join("\n");
}

/** Parse the model's reply into a valid proposal, or null. Never throws. */
export function parseReflection(text: string): Reflection | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { target, after, rationale } = raw as Record<string, unknown>;
  const spec = typeof target === "string" ? TARGETS[target] : undefined;
  if (!spec) return null;
  if (typeof rationale !== "string" || !rationale.trim()) return null;
  const value =
    spec.target.kind === "param"
      ? Number(after) * spec.scale
      : after;
  if (!validValue(spec.target, value)) return null;
  if (spec.target.kind === "prompt" && !(value as string).trim()) return null;
  return { target: spec.target, after: value, rationale: rationale.trim() };
}

export async function reflect(port: ChatPort, input: ReflectInput): Promise<{ ok: true; reflection: Reflection } | { ok: false; error: string }> {
  const reply = await port.complete(buildReflectPrompt(input), 900);
  if (!reply.ok) return { ok: false, error: reply.error };
  const reflection = parseReflection(reply.text);
  return reflection ? { ok: true, reflection } : { ok: false, error: `unusable reply: ${clip(reply.text.trim(), 200)}` };
}

/** True when no proposal is waiting on the operator. */
export function canPropose(policy: Policy): boolean {
  return !policy.proposals.some((p) => p.status === "pending");
}

/**
 * Reflect over the log and file the result as a pending proposal. Refuses
 * while one is already pending, so the operator decides one change at a time.
 */
export async function proposeImprovement(deps: {
  readonly chat: ChatPort;
  readonly policy: Policy;
  readonly events: readonly LogEvent[];
  readonly limits: ReflectInput["limits"];
  readonly mix: ReflectInput["mix"];
  readonly append: (op: PolicyOp) => void;
  readonly source: string;
  readonly nowMs: number;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!canPropose(deps.policy)) return { ok: false, error: "a proposal is already waiting for review" };
  const result = await reflect(deps.chat, reflectInput(deps.events, deps.policy, deps.limits, deps.mix));
  if (!result.ok) return result;
  const id = `p-${deps.nowMs.toString(36)}`;
  const { target, after, rationale } = result.reflection;
  deps.append({ op: "proposal", id, source: deps.source, target, after, rationale });
  return { ok: true, id };
}
