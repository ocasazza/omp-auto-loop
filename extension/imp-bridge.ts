// omp-auto-loop imp bridge — fire-and-forget notifier that lands a one-line
// session_stop summary on the imp agent board (packages/imp-agent) when an
// auto-loop session settles or schedules a continuation.
//
// Standalone by design: shares NOTHING with auto-loop.ts's runtime (that is a
// separate extension instance). It re-reads the same config.json, derives its
// own minimal summary from the stop event's last assistant text, and posts to
// the board's HTTP API. Delivery is best-effort: an in-memory queue (max 50,
// drop-oldest), exponential backoff (500ms base, max 5 attempts per message),
// then the message is dropped. The session_stop path never blocks on delivery
// and the bridge never throws.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// -- pi surface (structural, no @oh-my-pi import: the bridge is standalone) --

interface StopEvent {
	messages?: unknown;
}
interface StopCtx {
	sessionManager?: unknown;
}
interface PiLike {
	on(event: "session_stop", handler: (event: StopEvent, ctx: StopCtx) => void | Promise<void>): void;
}

interface ImpBridgeConfig {
	enable: boolean;
	url: string;
	room: string;
}

type QueueMessage = {
	name: string;
	text: string;
	meta: Record<string, unknown>;
};

// -- config --

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "omp-auto-loop");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** impBridge block of config.json, or null when absent/disabled/malformed. */
function readBridgeConfig(): ImpBridgeConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch {
		return null; // missing or unparseable config: the bridge stays off
	}
	const raw = record(parsed)?.impBridge;
	if (!record(raw)) return null;
	const { enable, url, room } = record(raw) as Record<string, unknown>;
	if (enable !== true) return null;
	if (typeof url !== "string" || url.length === 0) return null;
	if (typeof room !== "string" || room.length === 0) return null;
	return { enable: true, url: url.replace(/\/+$/, ""), room };
}

// -- summary --

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = record(messages[i]);
		if (msg?.role !== "assistant") continue;
		if (typeof msg.content === "string") return msg.content;
		if (!Array.isArray(msg.content)) return "";
		return msg.content
			.map((part) => {
				const p = record(part);
				return p?.type === "text" && typeof p.text === "string" ? p.text : "";
			})
			.join("");
	}
	return "";
}

function shortSession(ctx: StopCtx): string {
	const manager = record(ctx.sessionManager);
	const getId = manager?.getSessionId;
	if (typeof getId !== "function") return `p${process.pid}`;
	const id = String((getId.call(manager) as unknown) ?? "");
	return id ? id.slice(0, 8) : `p${process.pid}`;
}

// -- delivery --

const MAX_QUEUE = 50;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const WARN_EVERY = 10;

const queue: QueueMessage[] = [];
let draining = false;
let consecutiveFailures = 0;

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function postMessage(config: ImpBridgeConfig, message: QueueMessage): Promise<boolean> {
	const url = `${config.url}/api/rooms/${encodeURIComponent(config.room)}/messages`;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(2_000),
		});
		return response.status === 204;
	} catch {
		return false;
	}
}

async function drain(config: ImpBridgeConfig): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		while (queue.length > 0) {
			const message = queue[0];
			let delivered = false;
			for (let attempt = 0; attempt < MAX_ATTEMPTS && !delivered; attempt++) {
				if (attempt > 0) await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1));
				delivered = await postMessage(config, message);
			}
			// Drop-oldest on both success and give-up: the queue always advances.
			queue.shift();
			if (delivered) {
				consecutiveFailures = 0;
			} else {
				consecutiveFailures++;
				if (consecutiveFailures % WARN_EVERY === 0) {
					console.warn(`[imp-bridge] dropped ${WARN_EVERY} consecutive messages (board unreachable?)`);
				}
			}
		}
	} finally {
		draining = false;
	}
}

function enqueue(config: ImpBridgeConfig, message: QueueMessage): void {
	if (queue.length >= MAX_QUEUE) queue.shift(); // drop-oldest
	queue.push(message);
	void drain(config); // fire-and-forget: session_stop never awaits delivery
}

// -- extension entry --

export default function (pi: PiLike): void {
	const config = readBridgeConfig();
	if (!config) return; // disabled, or no config: register nothing

	pi.on("session_stop", (event, ctx) => {
		try {
			const text = lastAssistantText(event.messages).slice(0, 160);
			const decision = text.includes("AUTOLOOP:DONE") ? "settled" : "continued";
			const summary = `[omp-auto-loop] ${basename(process.cwd())}#${shortSession(ctx)}: ${decision} ${text}`.trimEnd();
			enqueue(config, {
				name: "omp",
				text: summary,
				meta: { kind: "settle-or-continue", cwd: process.cwd() },
			});
		} catch {
			// never throw from the stop path
		}
	});
}
