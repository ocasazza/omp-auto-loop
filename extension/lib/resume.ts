// Cycle resume: reconstruct a cycle's budget from a prior run's event log.
//
// The in-process loop keeps `continuations` and `cycleStart` in memory, so a
// session that dies mid-cycle restarts the budget from zero. The event log is
// already durable, so the cheapest correct "lease" is to replay it: a run
// adopts the budget its predecessor had spent, and a settled cycle is gone.

import { classify, type EventClass } from "./taxonomy.ts";

export interface LoopEvent {
  readonly ts: string;
  readonly session: string;
  /** Event class. Older logs predate this field; those replay by message. */
  readonly kind?: EventClass;
  readonly msg: string;
}

export interface ResumedCycle {
  readonly continuations: number;
  readonly cycleStartedAtMs: number;
}

export interface ReplayOptions {
  /** When set, only this session's events are considered. */
  readonly session?: string;
  /** Clock fallback when the log carries no usable timestamp. */
  readonly nowMs?: number;
}

// A recorded kind is authoritative; only logs that predate the field are
// classified from the message, and they use the same classifier the graph
// projection uses -- a second copy here had already diverged.
function classOf(event: LoopEvent): EventClass {
  return event.kind ?? classify(event.msg ?? "");
}

/**
 * Replay a session's events and return the budget in force at the end of the
 * log. A `continue` accumulates; a `settled` closes the cycle and restarts it.
 */
export function replayCycle(
  events: readonly LoopEvent[],
  options: ReplayOptions = {},
): ResumedCycle {
  const now = options.nowMs ?? Date.now();
  let continuations = 0;
  let cycleStartedAtMs = now;

  for (const event of events) {
    if (options.session !== undefined && event.session !== options.session) {
      continue;
    }
    const kind = classOf(event);
    if (kind === "continue") {
      if (continuations === 0) {
        const parsed = Date.parse(event.ts);
        cycleStartedAtMs = Number.isFinite(parsed) ? parsed : now;
      }
      continuations += 1;
    } else if (kind === "settled") {
      const parsed = Date.parse(event.ts);
      cycleStartedAtMs = Number.isFinite(parsed) ? parsed : now;
      continuations = 0;
    }
  }
  return { continuations, cycleStartedAtMs };
}
