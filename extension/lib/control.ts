// The loop's control channel: how a human steering from outside the terminal
// reaches a running session.
//
// The dashboard is one process per omp session and only one of them can hold
// the port, so an action must not be applied by whichever session happened to
// win it. Commands go to an append-only file instead and every session reads
// the same one, applying what is addressed to it. The file is the shared
// medium; the port is only a way in.
//
// Pure: parsing and selection take text and return data. The caller owns the
// filesystem, the clock and the effects.

/**
 * `guide` delivers operator text into the session's next turn; `reopen` puts a
 * settled goal back to work after a human overturned its completion.
 */
export type ControlAction = "pause" | "resume" | "disable" | "enable" | "goal" | "guide" | "reopen";

export interface ControlCommand {
  /** ms since the epoch, so ordering survives a clock that steps. */
  readonly at: number;
  /** Session label, or "*" for every session on this host. */
  readonly target: string;
  readonly action: ControlAction;
  /** The objective for `goal`, the text for `guide`, the reason for `reopen`. */
  readonly value?: string;
  /** How the command got here, for the audit line. */
  readonly by?: string;
}

export const ACTIONS: readonly ControlAction[] = ["pause", "resume", "disable", "enable", "goal", "guide", "reopen"];

/** Actions that are meaningless without text. */
export const NEEDS_VALUE: readonly ControlAction[] = ["goal", "guide"];

/** The broadcast target. A literal "*" cannot collide with a session label. */
export const ALL_SESSIONS = "*";

/**
 * Serialize one command as a line. Newlines are stripped from the value: the
 * file is line-oriented, and an objective containing one would otherwise
 * become a second, unparseable record.
 */
export function encodeCommand(command: ControlCommand): string {
  return `${JSON.stringify({ ...command, value: command.value?.replace(/[\r\n]+/g, " ").trim() })}\n`;
}

/** Parse a command line, or null when it is not one. Never throws. */
export function parseCommand(line: string): ControlCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const { at, target, action, value, by } = record;
  if (typeof at !== "number" || typeof target !== "string") return null;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return null;
  if (value !== undefined && typeof value !== "string") return null;

  return {
    at,
    target,
    action: action as ControlAction,
    value: typeof value === "string" ? value : undefined,
    by: typeof by === "string" ? by : undefined,
  };
}

export interface Selected {
  /** Commands for this session that have not been applied yet. */
  readonly commands: readonly ControlCommand[];
  /**
   * Highest `at` seen in the whole file, this session's or not. Stored as the
   * cursor so a restart skips everything already on disk rather than replaying
   * a day of steering onto a fresh session.
   */
  readonly cursor: number;
}

/**
 * Commands addressed to this session (or everyone) after `cursor`.
 *
 * A session answers to more than one name: the event log labels it
 * `repo#pid`, the graph and the dashboard label it `repo#<session key>`.
 * Matching only one of them makes steering from the other surface silently
 * reach nobody.
 *
 * Filtering on `at > cursor` rather than on an index keeps the reader correct
 * when another session appends while this one is reading: a line count would
 * shift under it, a timestamp does not.
 */
export function selectCommands(text: string, session: string | readonly string[], cursor: number): Selected {
  const names: readonly string[] = typeof session === "string" ? [session] : session;
  const commands: ControlCommand[] = [];
  let highest = cursor;

  for (const line of text.split("\n")) {
    const command = parseCommand(line);
    if (!command) continue;
    if (command.at > highest) highest = command.at;
    if (command.at <= cursor) continue;
    if (command.target !== ALL_SESSIONS && !names.includes(command.target)) continue;
    commands.push(command);
  }
  return { commands: commands.sort((a, b) => a.at - b.at), cursor: highest };
}
