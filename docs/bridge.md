# omp-auto-loop ↔ imp agent bridge

The omp-auto-loop extension (this repo) and the imp agent board
(`nixos-config/packages/imp-agent`, a Phoenix app) talk in both directions:

```
omp (this repo)                          imp agent (packages/imp-agent)
┌────────────────────┐   HTTP POST       ┌──────────────────────────────┐
│ extension/         │ ────────────────▶ │ ImpAgentWeb.API.MessageCtrl  │
│ imp-bridge.ts      │  JSON, 204/4xx    │   └─ ImpAgent.Bus            │
└────────────────────┘                   │      └─ BoardLive (messages) │
                                         ├──────────────────────────────┤
        ▲                                │ ImpAgent.Fleet (SSH dial-out)│
        └────────── run_command ─────────┤   └─ Host.run_line           │
                   host executes omp     └──────────────────────────────┘
```

## omp → imp: session summaries onto the board

### Entry and config

`extension/imp-bridge.ts` is a standalone omp extension entry
(`export default function (pi): void`). It shares no code with
`auto-loop.ts` — that runs as a separate extension instance — and is
registered by the Nix module alongside it.

It reads one file, once, at load:

```
${XDG_CONFIG_HOME:-~/.config}/omp-auto-loop/config.json
```

Contract (rendered by the Nix module):

```json
{
  "impBridge": {
    "enable": true,
    "url": "http://127.0.0.1:4010",
    "room": "ops"
  }
}
```

| key      | meaning                                                     |
| -------- | ----------------------------------------------------------- |
| `enable` | falsy → the bridge registers nothing                         |
| `url`    | board base URL (trailing slashes stripped)                   |
| `room`   | board room name; posted URL-escaped, used as-is by the server |

These come from the `impBridge` options this flake's `nix/module.nix`
defines (`local.omp.autoLoop.impBridge.{enable,url,room}`; defaults
`false`, `http://127.0.0.1:4010`, `kitchen`), rendered into the
`config.json` overlay (`PI_CONFIG_FILES`) that carries the auto-loop
settings.

### What fires

Only `pi.on("session_stop", ...)`. The handler derives a minimal summary
from the stop event's last assistant message (first 160 chars) and prefixes
it `[omp-auto-loop] <cwd basename>#<session[:8]>: settled|continued` —
`settled` when that text carries the `AUTOLOOP:DONE` marker, `continued`
otherwise. Scope is deliberately just this one event, `kind:
"settle-or-continue"`; no goal-transition hookups.

### HTTP contract

```
POST {url}/api/rooms/{room}/messages
Content-Type: application/json

{"name": "omp", "text": "...", "meta": {"kind": "settle-or-continue", ...}}
```

- `204` on success
- `422` `%{"errors": [...]}` on a blank/missing name, a non-string `text`,
  a non-map `meta`, or a blank room
- `400` on a body that is not valid JSON

Server side: `ImpAgentWeb.Router` routes it through the `:api` pipeline
(`accepts: ["json"]` only — no CSRF, which stays in `:browser`) to
`ImpAgentWeb.API.MessageController.create/2`, which publishes exactly one

```elixir
ImpAgent.Bus.publish_chatroom(room, :message, %{
  name: name, at: System.system_time(:millisecond), text: text, meta: meta
})
```

That lands on the `"chatroom:" <> room` topic (`ImpAgent.Bus.chatroom_topic/1`),
the same topic `BoardLive` subscribes to (`board_live.ex`,
`Bus.subscribe_chatroom/1`), so the summary appears in the board's messages
panel like any agent message — name, timestamp, body.

### Failure semantics

Fire-and-forget. The handler enqueues and calls `void drain()`; it never
blocks or throws. Delivery: in-memory queue (max 50, drop-oldest), `fetch`
with a 2s `AbortSignal.timeout`, exponential backoff (500ms base, max 5
attempts per message) — then the message is dropped. One `console.warn`
per 10 consecutive dropped messages, nothing otherwise. A down board costs
an omp session nothing.

## imp → omp: fleet runs dispatched to omp (fleet-level)

The board does not call omp over HTTP; it dials **out** over SSH to a
configured host and lets that host run its own command:

1. The board's `fleet-run` event calls `ImpAgent.Fleet.schedule(host, prompt)`
   (`fleet.ex:138`), refused with `{:error, :link_dropped | :unknown_host |
   :empty_prompt | :fleet_down}` if the host's last probe failed.
2. `Fleet.handle_call({:schedule, ...})` (`fleet.ex:185`) → `start_run/4`
   (`fleet.ex:308`) builds the command line with `ImpAgent.Fleet.Host.run_line/2`
   (`host.ex:193`): `<run_command> ' '<shell-quoted prompt>` —
   `Host.shell_quote/1` (`host.ex:187`) single-quotes the prompt.
3. The line executes on the host via `ImpAgent.Fleet.SSHTransport.exec/3`
   (`ssh_transport.ex:61`, one `:ssh` connection per run). The transport is
   `Application.get_env(:imp_agent, :fleet_transport, ImpAgent.Fleet.SSHTransport)`
   (`fleet.ex:165`), run under the fleet's `Task.Supervisor`.
4. The run's default command is `"imp run"` (`@default_run_command`,
   `host.ex:81`). A host operator who wants scheduled prompts to drive an
   omp session points `run_command` at omp instead — the prompt arrives as
   one argument, so a one-shot omp invocation is the right shape:

```elixir
# host config (Application env :imp_agent → :fleet_hosts, one entry per host)
%{
  name: "m2",
  hostname: "m2.lan",
  port: 22,
  user: "casazza",
  # default is "imp run"; aim it at omp to dispatch omp work from the board:
  run_command: "omp -p"
}
```

5. Outcome is honest, never invented: `:fleet_job_started` and
   `:fleet_job_finished` broadcast on the room topic (`fleet.ex:315,324-341`,
   via the `publish/3` helper that maps host → `Bus.publish_chatroom/3`,
   `fleet.ex:352`). A run whose channel dies or times out broadcasts that
   its outcome is unknown.

So the loop closes: an omp session settles → the bridge posts to the board;
an operator schedules a prompt on a host from the board → that host's omp
picks the work up.

## Where the pieces live

| piece                        | file                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| bridge extension             | `extension/imp-bridge.ts` (this repo)                                          |
| config reader keys           | `impBridge.{enable,url,room}` in `~/.config/omp-auto-loop/config.json`         |
| Nix options                  | `local.omp.autoLoop.impBridge.*` (`modules/home/omp/auto-loop/module.nix`)     |
| HTTP endpoint                | `lib/imp_agent_web/controllers/api/message_controller.ex`                      |
| route / pipeline             | `lib/imp_agent_web/router.ex` (`:api` pipeline, `POST /api/rooms/:room/messages`) |
| publish path (cited)         | `ImpAgent.Bus.publish_chatroom/3` (`lib/imp_agent/bus.ex`)                     |
| board render                 | `lib/imp_agent_web/board_live.ex` (`handle_info` → `record` → `insert`)        |
| fleet run path (cited)       | `fleet.ex:138,185,308-315` · `host.ex:81,187,193` · `ssh_transport.ex:61`      |
