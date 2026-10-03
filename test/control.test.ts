// The control channel: how steering written by a human reaches a session.
// Pure — the caller owns the filesystem and the effects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SESSIONS, encodeCommand, parseCommand, selectCommands } from "../extension/lib/control.ts";

test("a command round-trips", () => {
  const line = encodeCommand({ at: 5, target: "a#1", action: "goal", value: "ship it", by: "dash" });
  assert.deepEqual(parseCommand(line), { at: 5, target: "a#1", action: "goal", value: "ship it", by: "dash" });
});

test("an objective containing a newline cannot become a second record", () => {
  const line = encodeCommand({ at: 1, target: ALL_SESSIONS, action: "goal", value: "one\ntwo\r\nthree" });
  assert.equal(line.trimEnd().split("\n").length, 1);
  assert.equal(parseCommand(line)?.value, "one two three");
});

test("malformed lines are dropped, never thrown on", () => {
  for (const line of ["", "   ", "not json", "{}", '{"at":"x","target":"a","action":"pause"}',
                      '{"at":1,"target":"a"}', '{"at":1,"target":"a","action":"nope"}',
                      '{"at":1,"target":"a","action":"goal","value":42}', "null", "[]"]) {
    assert.equal(parseCommand(line), null, `should reject: ${line}`);
  }
});

test("a command reaches its session and not others", () => {
  const text = encodeCommand({ at: 1, target: "a#1", action: "pause" })
    + encodeCommand({ at: 2, target: "b#2", action: "disable" });

  const mine = selectCommands(text, "a#1", 0);
  assert.deepEqual(mine.commands.map((c) => c.action), ["pause"]);
});

test("a broadcast reaches every session", () => {
  const text = encodeCommand({ at: 1, target: ALL_SESSIONS, action: "disable" })
    + encodeCommand({ at: 2, target: "b#2", action: "pause" });

  assert.deepEqual(selectCommands(text, "a#1", 0).commands.map((c) => c.action), ["disable"]);
  assert.deepEqual(selectCommands(text, "b#2", 0).commands.map((c) => c.action), ["disable", "pause"]);
});

test("the cursor moves past other sessions' commands too", () => {
  // Otherwise a session re-reads a file that only ever grew with someone
  // else's steering.
  const text = encodeCommand({ at: 7, target: "b#2", action: "pause" })
    + encodeCommand({ at: 9, target: "a#1", action: "pause" });

  const first = selectCommands(text, "a#1", 0);
  assert.equal(first.commands.length, 1);
  assert.equal(first.cursor, 9);

  assert.deepEqual(selectCommands(text, "a#1", first.cursor).commands, []);
});

test("commands apply oldest first", () => {
  const text = encodeCommand({ at: 30, target: "a#1", action: "resume" })
    + encodeCommand({ at: 10, target: "a#1", action: "pause" });

  assert.deepEqual(selectCommands(text, "a#1", 0).commands.map((c) => c.at), [10, 30]);
});

test("a cursor past everything selects nothing", () => {
  const text = encodeCommand({ at: 5, target: ALL_SESSIONS, action: "pause" });
  assert.deepEqual(selectCommands(text, "a#1", 5).commands, []);
});
