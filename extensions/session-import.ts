/**
 * session-import — bring Claude Code / Codex CLI conversations into pi as pi sessions.
 *
 * Provides:
 *   tool    find_sessions    search both agents' sessions by content, cwd and recency
 *   tool    import_session   convert a chosen session into a pi session file
 *   command /resume-session  import by keywords or ref, then switch to the new session
 *   command /import-open     open the session imported most recently by the tool
 *
 * The command is deliberately not named /import: pi's interactive mode matches its
 * built-in /import (JSONL file import) before extension commands are dispatched, so a
 * command registered under that name is never reached. /resume-session is safe — the
 * built-in /resume is matched by exact equality, not by prefix.
 */
import { SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ImportMode = "compact" | "strict";
type AgentKind = "claude" | "codex";

type Candidate = {
	agent: AgentKind;
	id: string;
	file: string;
	cwd: string;
	branch: string;
	first: string;
	last: string;
	updatedMs: number;
	sizeBytes: number;
	haystack: string;
};

type Turn = { role: "user" | "assistant"; text: string; timestamp?: string };
type ParseResult = { turns: Turn[]; toolCalls: number; toolResults: number; cwd: string; branch: string };

const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const CODEX_ROOT = path.join(os.homedir(), ".codex");
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "cache", "session-import-index.json");
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 16 * 1024;
const TOOL_TEXT_CAP = 2000;
const PICKER_LIMIT = 5000;

/* ------------------------------------------------------------------ utils */

function readChunk(file: string, start: number, length: number): string {
	if (length <= 0) return "";
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(length);
		const read = fs.readSync(fd, buf, 0, length, start);
		return buf.subarray(0, read).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Read only the head and tail of a file. The tail's first (partial) line is dropped. */
function sampleLines(file: string, size: number): { head: string[]; tail: string[] } {
	const headRaw = readChunk(file, 0, Math.min(size, HEAD_BYTES));
	const head = headRaw.split("\n");
	if (size > HEAD_BYTES) head.pop(); // partial line at the cut point
	if (size <= HEAD_BYTES + TAIL_BYTES) return { head: head.filter(Boolean), tail: [] };
	const tailRaw = readChunk(file, size - TAIL_BYTES, TAIL_BYTES);
	const tail = tailRaw.split("\n").slice(1);
	return { head: head.filter(Boolean), tail: tail.filter(Boolean) };
}

function squash(text: string, cap = 220): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
}

function formatAge(whenMs: number): string {
	if (!whenMs) return "unknown";
	const minutes = Math.floor(Math.max(0, Date.now() - whenMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10}${units[unit]}`;
}

/** Harness-injected text that is not worth importing. */
function isNoiseUserText(text: string): boolean {
	const t = text.trimStart();
	if (!t) return true;
	return (
		// injected by Claude Code
		t.startsWith("<system-reminder>") ||
		t.startsWith("<command-name>") ||
		t.startsWith("<local-command-stdout>") ||
		t.startsWith("<local-command-caveat>") ||
		t.startsWith("<task-notification>") ||
		t.startsWith("[Request interrupted by user") ||
		t.startsWith("Caveat: The messages below were generated") ||
		// injected by Codex
		t.startsWith("<environment_context>") ||
		t.startsWith("<user_instructions>") ||
		t.startsWith("<skills_instructions>") ||
		t.startsWith("<recommended_plugins>") ||
		t.startsWith("<turn_aborted>") ||
		t.startsWith("<codex_internal_context") ||
		t.startsWith("# AGENTS.md instructions")
	);
}

function textFromContent(content: unknown, kinds: string[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const typed = item as Record<string, unknown>;
		if (kinds.includes(String(typed.type)) && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

/* --------------------------------------------------- candidate collection */

type CacheEntry = { mtimeMs: number; size: number; cwd: string; branch: string; first: string; last: string; bag: string };
type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
	} catch {
		return {};
	}
}

function saveCache(cache: Cache): void {
	try {
		fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
		fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
	} catch {
		// the index cache is an optimization; losing it is fine
	}
}

function summarizeClaudeFile(file: string, size: number): CacheEntry {
	const { head, tail } = sampleLines(file, size);
	let cwd = "";
	let branch = "";
	let first = "";
	let last = "";
	const bag: string[] = [];

	const scan = (lines: string[], isTail: boolean) => {
		for (const line of lines) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
			if (!branch && typeof entry.gitBranch === "string") branch = entry.gitBranch;
			const type = entry.type;
			if (type !== "user" && type !== "assistant") continue;
			const message = (entry.message ?? {}) as Record<string, unknown>;
			const text = squash(textFromContent(message.content, ["text"]), 400);
			if (!text) continue;
			if (type === "user") {
				if (isNoiseUserText(text)) continue;
				if (!first && !isTail) first = text;
				last = text;
			}
			if (bag.length < 24) bag.push(text);
		}
	};
	scan(head, false);
	scan(tail, true);
	return { mtimeMs: 0, size, cwd, branch, first, last, bag: bag.join("  ") };
}

function collectClaude(cache: Cache): Candidate[] {
	if (!fs.existsSync(CLAUDE_ROOT)) return [];
	const out: Candidate[] = [];
	for (const dir of fs.readdirSync(CLAUDE_ROOT)) {
		const projectDir = path.join(CLAUDE_ROOT, dir);
		let files: string[];
		try {
			if (!fs.statSync(projectDir).isDirectory()) continue;
			files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const abs = path.join(projectDir, file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(abs);
			} catch {
				continue;
			}
			const entry = cachedSummary(cache, abs, stat, summarizeClaudeFile);
			if (!entry) continue;
			const id = file.replace(/\.jsonl$/, "");
			const cwd = entry.cwd || `/${dir.replace(/^-/, "").replaceAll("-", "/")}`;
			out.push({
				agent: "claude",
				id,
				file: abs,
				cwd,
				branch: entry.branch,
				first: entry.first,
				last: entry.last,
				updatedMs: stat.mtimeMs,
				sizeBytes: stat.size,
				haystack: `${entry.bag} ${cwd} ${entry.branch} ${id}`.toLowerCase(),
			});
		}
	}
	return out;
}

function collectCodex(cache: Cache): Candidate[] {
	const dbPath = path.join(CODEX_ROOT, "state_5.sqlite");
	const rows: Array<Record<string, unknown>> = [];
	try {
		// node:sqlite is experimental; getBuiltinModule works whether we are loaded as CJS or ESM
		const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
		const { DatabaseSync } = sqlite;
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const stmt = db.prepare(
				"select id, title, cwd, git_branch, rollout_path, first_user_message, preview, updated_at, updated_at_ms from threads where archived = 0",
			);
			rows.push(...(stmt.all() as Array<Record<string, unknown>>));
		} finally {
			db.close();
		}
	} catch {
		return collectCodexFromDisk(cache);
	}

	const out: Candidate[] = [];
	for (const row of rows) {
		const rollout = typeof row.rollout_path === "string" ? row.rollout_path : "";
		if (!rollout) continue;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(rollout);
		} catch {
			continue; // thread whose rollout file is gone cannot be imported
		}
		const sampled = cachedSummary(cache, rollout, stat, summarizeCodexFile);
		if (!sampled) continue;
		const id = String(row.id ?? "");
		const title = squash(String(row.title ?? row.first_user_message ?? ""), 400);
		const cwd = String(row.cwd ?? "") || sampled.cwd;
		const branch = String(row.git_branch ?? "") || sampled.branch;
		const updatedMs = Number(row.updated_at_ms ?? 0) || Number(row.updated_at ?? 0) * 1000 || stat.mtimeMs;
		out.push({
			agent: "codex",
			id,
			file: rollout,
			cwd,
			branch,
			first: title || sampled.first,
			last: sampled.last || title,
			updatedMs,
			sizeBytes: stat.size,
			haystack: `${title} ${sampled.bag} ${cwd} ${branch} ${id}`.toLowerCase(),
		});
	}
	return out;
}

/** Reuse the cached summary while mtime and size are unchanged. */
function cachedSummary(
	cache: Cache,
	file: string,
	stat: fs.Stats,
	summarize: (file: string, size: number) => CacheEntry,
): CacheEntry | null {
	if (stat.size === 0) return null;
	const hit = cache[file];
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
	try {
		const entry = { ...summarize(file, stat.size), mtimeMs: stat.mtimeMs };
		cache[file] = entry;
		return entry;
	} catch {
		return null;
	}
}

/** Fallback when the sqlite state DB is unreadable: walk the rollout files directly. */
function collectCodexFromDisk(cache: Cache): Candidate[] {
	const root = path.join(CODEX_ROOT, "sessions");
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) walk(abs);
			else if (e.name.endsWith(".jsonl")) files.push(abs);
		}
	};
	try {
		walk(root);
	} catch {
		return [];
	}
	const out: Candidate[] = [];
	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		const meta = cachedSummary(cache, file, stat, summarizeCodexFile);
		if (!meta) continue;
		const id = /-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(file))?.[1] ?? path.basename(file);
		out.push({
			agent: "codex",
			id,
			file,
			cwd: meta.cwd,
			branch: meta.branch,
			first: meta.first,
			last: meta.last,
			updatedMs: stat.mtimeMs,
			sizeBytes: stat.size,
			haystack: `${meta.bag} ${meta.cwd} ${id}`.toLowerCase(),
		});
	}
	return out;
}

function summarizeCodexFile(file: string, size: number): CacheEntry {
	const { head, tail } = sampleLines(file, size);
	let cwd = "";
	let branch = "";
	let first = "";
	let last = "";
	const bag: string[] = [];
	const scan = (lines: string[], isTail: boolean) => {
		for (const line of lines) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const payload = (entry.payload ?? {}) as Record<string, unknown>;
			if (entry.type === "session_meta") {
				if (typeof payload.cwd === "string") cwd = payload.cwd;
				const git = payload.git as Record<string, unknown> | undefined;
				if (git && typeof git.branch === "string") branch = git.branch;
				continue;
			}
			if (entry.type !== "response_item" || payload.type !== "message") continue;
			const role = payload.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = squash(textFromContent(payload.content, ["input_text", "output_text", "text"]), 400);
			if (!text) continue;
			if (role === "user") {
				if (isNoiseUserText(text)) continue;
				if (!first && !isTail) first = text;
				last = text;
			}
			if (bag.length < 24) bag.push(text);
		}
	};
	scan(head, false);
	scan(tail, true);
	return { mtimeMs: 0, size, cwd, branch, first, last, bag: bag.join("  ") };
}

/* ------------------------------------------------------------------ search */

export type SearchOptions = {
	query?: string;
	agent?: AgentKind | "both";
	cwd?: string;
	sinceHours?: number;
	limit?: number;
};

export function searchSessions(opts: SearchOptions): Candidate[] {
	const agent = opts.agent ?? "both";
	const cache = loadCache();
	let candidates: Candidate[] = [];
	if (agent !== "codex") candidates = candidates.concat(collectClaude(cache));
	if (agent !== "claude") candidates = candidates.concat(collectCodex(cache));
	saveCache(cache);

	if (opts.cwd) {
		const needle = opts.cwd.toLowerCase();
		candidates = candidates.filter((c) => c.cwd.toLowerCase().includes(needle));
	}
	if (opts.sinceHours && opts.sinceHours > 0) {
		const floor = Date.now() - opts.sinceHours * 3_600_000;
		candidates = candidates.filter((c) => c.updatedMs >= floor);
	}

	const terms = (opts.query ?? "")
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (terms.length > 0) {
		const all = candidates.filter((c) => terms.every((t) => c.haystack.includes(t)));
		candidates = all.length > 0 ? all : candidates.filter((c) => terms.some((t) => c.haystack.includes(t)));
	}

	candidates.sort((a, b) => b.updatedMs - a.updatedMs);
	return candidates.slice(0, Math.max(1, opts.limit ?? 10));
}

export function formatCandidate(c: Candidate): string {
	const head = `${c.agent}:${c.id.slice(0, 8)}  ${formatAge(c.updatedMs)}  ${c.cwd || "?"}${c.branch ? `  branch:${c.branch}` : ""}  ${formatBytes(c.sizeBytes)}`;
	return `${head}\n    first: ${squash(c.first, 160) || "(none)"}\n    last:  ${squash(c.last, 120) || "(none)"}`;
}

/** Adapt an external transcript to pi's built-in session picker data shape. */
function toPickerSession(c: Candidate): SessionInfo {
	const updated = new Date(c.updatedMs || Date.now());
	return {
		path: c.file,
		id: `${c.agent}:${c.id}`,
		cwd: c.cwd,
		created: updated,
		modified: updated,
		messageCount: 0,
		firstMessage: c.first || c.last || "(no first message)",
		allMessagesText: c.haystack,
	};
}

/**
 * Open the same full-screen selector pi uses for /resume, but backed by
 * Claude Code and Codex transcripts instead of pi JSONL files.
 */
async function pickSession(ctx: ExtensionCommandContext, hits: Candidate[]): Promise<Candidate | undefined> {
	if (hits.length === 0) return undefined;

	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		const sessions = hits.map(toPickerSession);
		const current = ctx.cwd ? sessions.filter((session) => session.cwd === ctx.cwd) : sessions;
		const initial = current.length > 0 ? current : sessions;
		const selectedPath = await ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
			const selector = new SessionSelectorComponent(
				() => Promise.resolve(initial),
				() => Promise.resolve(sessions),
				(path) => done(path),
				() => done(null),
				() => done(null),
				() => tui.requestRender(),
				{ keybindings },
			);
			// These are external source files, so the shared selector must be read-only.
			const sessionList = selector.getSessionList() as unknown as {
				onDeleteSession?: (sessionPath: string) => Promise<void>;
			};
			sessionList.onDeleteSession = async () => {};
			return selector;
		});
		return selectedPath ? hits.find((candidate) => candidate.file === selectedPath) : undefined;
	}

	// Keep a small fallback for non-TUI hosts and older pi versions.
	const options = hits.map((candidate) => `${candidate.agent}:${candidate.id}  ${squash(candidate.first, 100) || "(no first message)"}  ${candidate.cwd || "?"}`);
	const selected = await ctx.ui.select("Resume Claude Code / Codex session", options);
	const index = selected ? options.indexOf(selected) : -1;
	return index >= 0 ? hits[index] : undefined;
}

/* ------------------------------------------------------------ ref resolution */

export function resolveRef(ref: string): { agent: AgentKind; id: string; file: string } {
	const trimmed = ref.trim();
	if (!trimmed) throw new Error("Empty ref (expected claude:<id>, codex:<id>, or a path to *.jsonl)");

	if (trimmed.endsWith(".jsonl")) {
		const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
		if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
		const agent: AgentKind = abs.includes(`${path.sep}.codex${path.sep}`) ? "codex" : "claude";
		return { agent, id: path.basename(abs, ".jsonl"), file: abs };
	}

	const m = /^(claude|codex):(.+)$/i.exec(trimmed);
	const wanted = m ? (m[1]!.toLowerCase() as AgentKind) : undefined;
	const idPart = (m ? m[2]! : trimmed).trim();

	const hit = searchSessions({ agent: wanted ?? "both", limit: 5000 }).find(
		(c) => c.id === idPart || c.id.startsWith(idPart) || c.file.includes(idPart),
	);
	if (!hit) throw new Error(`No session matches: ${trimmed}`);
	return { agent: hit.agent, id: hit.id, file: hit.file };
}

/* ----------------------------------------------------------------- parsers */

function parseClaudeSession(file: string, mode: ImportMode): ParseResult {
	const turns: Turn[] = [];
	let toolCalls = 0;
	let toolResults = 0;
	let cwd = "";
	let branch = "";

	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
		if (!branch && typeof entry.gitBranch === "string") branch = entry.gitBranch;
		const type = entry.type;
		if (type !== "user" && type !== "assistant") continue;
		const message = (entry.message ?? {}) as Record<string, unknown>;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
		const content = message.content;

		if (Array.isArray(content)) {
			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				const typed = item as Record<string, unknown>;
				if (typed.type === "tool_use") {
					toolCalls += 1;
					if (mode === "strict") {
						turns.push({
							role: "assistant",
							text: `[tool_use] ${String(typed.name ?? "?")}\n${squash(JSON.stringify(typed.input ?? {}), TOOL_TEXT_CAP)}`,
							timestamp,
						});
					}
					continue;
				}
				if (typed.type === "tool_result") {
					toolResults += 1;
					if (mode === "strict") {
						turns.push({
							role: "user",
							text: `[tool_result] ${squash(textFromContent(typed.content, ["text"]) || JSON.stringify(typed.content ?? ""), TOOL_TEXT_CAP)}`,
							timestamp,
						});
					}
					continue;
				}
			}
		}

		const text = textFromContent(content, ["text"]).trim();
		if (!text) continue;
		if (type === "user" && isNoiseUserText(text)) continue;
		turns.push({ role: type as "user" | "assistant", text, timestamp });
	}
	return { turns, toolCalls, toolResults, cwd, branch };
}

function parseCodexSession(file: string, mode: ImportMode): ParseResult {
	const turns: Turn[] = [];
	let toolCalls = 0;
	let toolResults = 0;
	let cwd = "";
	let branch = "";

	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const payload = (entry.payload ?? {}) as Record<string, unknown>;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

		if (entry.type === "session_meta") {
			if (typeof payload.cwd === "string") cwd = payload.cwd;
			const git = payload.git as Record<string, unknown> | undefined;
			if (git && typeof git.branch === "string") branch = git.branch;
			continue;
		}
		if (entry.type !== "response_item") continue;

		const ptype = payload.type;
		if (ptype === "message") {
			const role = payload.role;
			if (role !== "user" && role !== "assistant") continue; // drop developer / system turns
			const text = textFromContent(payload.content, ["input_text", "output_text", "text"]).trim();
			if (!text) continue;
			if (role === "user" && isNoiseUserText(text)) continue;
			turns.push({ role, text, timestamp });
			continue;
		}
		if (ptype === "function_call" || ptype === "custom_tool_call") {
			toolCalls += 1;
			if (mode === "strict") {
				const argsText = String(payload.arguments ?? payload.input ?? "");
				turns.push({
					role: "assistant",
					text: `[tool_use] ${String(payload.name ?? "?")}\n${squash(argsText, TOOL_TEXT_CAP)}`,
					timestamp,
				});
			}
			continue;
		}
		if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
			toolResults += 1;
			if (mode === "strict") {
				const out = payload.output;
				const text = typeof out === "string" ? out : textFromContent(out, ["input_text", "output_text", "text"]);
				turns.push({ role: "user", text: `[tool_result] ${squash(text, TOOL_TEXT_CAP)}`, timestamp });
			}
			continue;
		}
	}
	return { turns, toolCalls, toolResults, cwd, branch };
}

/* ------------------------------------------------------ pi session writing */

function randomId(length = 8): string {
	return Math.random().toString(16).slice(2, 2 + length);
}

function randomSessionId(): string {
	return `${Date.now().toString(16).slice(-8)}-${randomId(4)}-${randomId(4)}-${randomId(4)}-${randomId(12)}`;
}

function isoForFilename(d: Date): string {
	return d.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
}

function sanitizeCwd(cwd: string): string {
	return `--${cwd.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}--`;
}

function toPiMessage(
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
	timestamp: string | undefined,
	provider: string,
	modelId: string,
): Record<string, unknown> {
	const ts = timestamp ?? new Date().toISOString();
	const message: Record<string, unknown> = {
		role,
		content: [{ type: "text", text }],
		timestamp: new Date(ts).getTime(),
	};
	if (role === "assistant") {
		message.api = "openai-completions";
		message.provider = provider;
		message.model = modelId;
		message.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		message.stopReason = "done";
	}
	return { type: "message", id: randomId(8), parentId, timestamp: ts, message };
}

export type ImportOptions = {
	ref: string;
	mode?: ImportMode;
	turns?: number;
	targetCwd?: string;
	provider?: string;
	modelId?: string;
};

export type ImportResult = {
	agent: AgentKind;
	sourceFile: string;
	outPath: string;
	importedTurns: number;
	totalTurns: number;
	sourceCwd: string;
	targetCwd: string;
};

export function importSession(opts: ImportOptions): ImportResult {
	const { agent, file } = resolveRef(opts.ref);
	const mode: ImportMode = opts.mode ?? "compact";
	const maxTurns = Math.min(Math.max(1, opts.turns ?? 60), 400);

	const parsed = agent === "claude" ? parseClaudeSession(file, mode) : parseCodexSession(file, mode);
	if (parsed.turns.length === 0) throw new Error(`No importable user/assistant turns found in: ${file}`);

	const selected = parsed.turns.slice(-maxTurns);
	const now = new Date();
	const sessionId = randomSessionId();
	const targetCwd = opts.targetCwd ?? process.cwd();
	const provider = opts.provider ?? "openrouter";
	const modelId = opts.modelId ?? "openai/gpt-5.2-codex";

	const sessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", sanitizeCwd(targetCwd));
	fs.mkdirSync(sessionDir, { recursive: true });
	const outPath = path.join(sessionDir, `${isoForFilename(now)}_${sessionId}.jsonl`);

	const records: Array<Record<string, unknown>> = [];
	records.push({ type: "session", version: 3, id: sessionId, timestamp: now.toISOString(), cwd: targetCwd });

	const modelChangeId = randomId(8);
	records.push({
		type: "model_change",
		id: modelChangeId,
		parentId: null,
		timestamp: now.toISOString(),
		provider,
		modelId,
	});
	const thinkingId = randomId(8);
	records.push({
		type: "thinking_level_change",
		id: thinkingId,
		parentId: modelChangeId,
		timestamp: now.toISOString(),
		thinkingLevel: "medium",
	});

	const objective = selected.find((t) => t.role === "user")?.text ?? "";
	const lastUser = [...selected].reverse().find((t) => t.role === "user")?.text ?? "";
	const bootstrap = [
		`Imported from ${agent === "claude" ? "Claude Code" : "Codex"} session: ${file}`,
		`Source cwd: ${parsed.cwd || "unknown"}${parsed.branch ? ` (branch: ${parsed.branch})` : ""}`,
		`Import mode: ${mode}`,
		`Imported turns: ${selected.length} (total parsed: ${parsed.turns.length})`,
		`Observed tool activity in source: ${parsed.toolCalls} tool calls, ${parsed.toolResults} tool results`,
		"",
		"Objective:",
		objective.slice(0, 700) || "N/A",
		"",
		"Most recent user ask:",
		lastUser.slice(0, 700) || "N/A",
		"",
		"Continue from this context and ask clarifying questions only if needed.",
	].join("\n");

	let parentId: string | null = thinkingId;
	const bootstrapMessage = toPiMessage(parentId, "assistant", bootstrap, now.toISOString(), provider, modelId);
	parentId = bootstrapMessage.id as string;
	records.push(bootstrapMessage);

	for (const turn of selected) {
		const msg = toPiMessage(parentId, turn.role, turn.text, turn.timestamp, provider, modelId);
		parentId = msg.id as string;
		records.push(msg);
	}

	fs.writeFileSync(outPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

	return {
		agent,
		sourceFile: file,
		outPath,
		importedTurns: selected.length,
		totalTurns: parsed.turns.length,
		sourceCwd: parsed.cwd,
		targetCwd,
	};
}

/* --------------------------------------------------------- extension */

export default function sessionImportExtension(pi: ExtensionAPI) {
	let lastImported: string | null = null;

	const modelOf = (ctx: ExtensionContext) => ({
		provider: ctx.model?.provider ?? "openrouter",
		modelId: ctx.model?.id ?? "openai/gpt-5.2-codex",
	});

	pi.registerTool({
		name: "find_sessions",
		label: "Find sessions",
		description:
			"Search past Claude Code and Codex CLI sessions on this machine by content keywords, working directory, and recency. " +
			"Use this when the user refers to an earlier conversation in natural language (e.g. 'yesterday's subtitle-ml PR discussion'). " +
			"Returns refs like 'codex:019ff500' that can be passed to import_session. " +
			"Keyword matching is substring-based over the session's user/assistant text, cwd, and branch — pass distinctive words, not a full sentence.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Space-separated keywords. All must match; falls back to any-match." })),
			agent: Type.Optional(
				Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("both")], {
					description: "Which agent's sessions to search. Default: both.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Substring filter on the session's working directory." })),
			since_hours: Type.Optional(Type.Number({ description: "Only sessions updated within this many hours." })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
		}),
		async execute(_id, params) {
			const hits = searchSessions({
				query: params.query,
				agent: params.agent,
				cwd: params.cwd,
				sinceHours: params.since_hours,
				limit: params.limit,
			});
			const text = hits.length
				? hits.map((c, i) => `${i + 1}. ${formatCandidate(c)}`).join("\n")
				: "No matching sessions found.";
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "import_session",
		label: "Import session",
		description:
			"Convert a Claude Code or Codex session into a pi session file so the user can continue it in pi. " +
			"Pass a ref from find_sessions ('claude:<id>' / 'codex:<id>') or an absolute path to a .jsonl session file. " +
			"The new session is written under the current working directory's pi session store; it does NOT switch the active session — " +
			"tell the user to run /import-open (or pi -r) to open it. " +
			"The user can also do the whole thing in one step with " +
			"/resume-session <keywords|claude:id|codex:id|path.jsonl>. " +
			"Never tell the user to run /import — that is pi's built-in JSONL file import, it is handled before this " +
			"extension is reached, and it fails on a 'claude:<id>' / 'codex:<id>' ref.",
		parameters: Type.Object({
			ref: Type.String({ description: "'claude:<id>', 'codex:<id>', or an absolute path to the source .jsonl" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("compact"), Type.Literal("strict")], {
					description: "compact = messages only (default); strict = also include tool calls/results as text.",
				}),
			),
			turns: Type.Optional(Type.Number({ description: "Import only the last N turns (default 60, max 400)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const result = importSession({ ref: params.ref, mode: params.mode, turns: params.turns, ...modelOf(ctx) });
				lastImported = result.outPath;
				const warn =
					result.sourceCwd && result.sourceCwd !== result.targetCwd
						? `\nNote: source cwd was ${result.sourceCwd}, imported into ${result.targetCwd}.`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Imported ${result.agent} session (${result.importedTurns}/${result.totalTurns} turns) into:\n${result.outPath}${warn}\nRun /import-open to continue in it.`,
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `import_session failed: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerCommand("resume-session", {
		description: "Open the Claude Code / Codex session picker, or import one by keyword/ref",
		getArgumentCompletions: (prefix) => {
			const hits = searchSessions({ query: prefix, limit: 20 });
			if (hits.length === 0) return null;
			return hits.map((c) => ({
				value: `${c.agent}:${c.id}`,
				label: `[${c.agent}] ${squash(c.first, 70) || "(no first message)"} [${formatAge(c.updatedMs)}] [${c.cwd}]`,
			}));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const argv = args.trim().split(/\s+/).filter(Boolean);
				let mode: ImportMode = "compact";
				let turns: number | undefined;
				const words: string[] = [];
				for (let i = 0; i < argv.length; i += 1) {
					const part = argv[i]!;
					if (part === "--mode" && (argv[i + 1] === "compact" || argv[i + 1] === "strict")) {
						mode = argv[i + 1] as ImportMode;
						i += 1;
						continue;
					}
					if (part === "--turns") {
						const n = Number(argv[i + 1] ?? "");
						if (Number.isFinite(n) && n > 0) {
							turns = n;
							i += 1;
						}
						continue;
					}
					words.push(part);
				}
				if (words.length === 0) {
					const hits = searchSessions({ limit: PICKER_LIMIT });
					if (hits.length === 0) {
						ctx.ui.notify("No Claude Code or Codex sessions found.", "error");
						return;
					}
					const picked = await pickSession(ctx, hits);
					if (!picked) return;
					words.push(`${picked.agent}:${picked.id}`);
				}

				const raw = words.join(" ");
				let ref = raw;
				const looksLikeRef = /^(claude|codex):/i.test(raw) || raw.endsWith(".jsonl");
				if (!looksLikeRef) {
					const hits = searchSessions({ query: raw, limit: 15 });
					if (hits.length === 0) {
						ctx.ui.notify(`No session matches: ${raw}`, "error");
						return;
					}
					const picked = await pickSession(ctx, hits);
					if (!picked) return;
					ref = `${picked.agent}:${picked.id}`;
				}

				const result = importSession({
					ref,
					mode,
					turns,
					provider: ctx.model?.provider ?? "openrouter",
					modelId: ctx.model?.id ?? "openai/gpt-5.2-codex",
				});
				lastImported = result.outPath;
				ctx.ui.notify(
					`Imported ${result.agent} session (${result.importedTurns}/${result.totalTurns} turns) → ${result.outPath}`,
					"info",
				);
				await ctx.switchSession(result.outPath);
			} catch (err) {
				ctx.ui.notify(`import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("import-open", {
		description: "Open the session imported most recently by import_session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!lastImported || !fs.existsSync(lastImported)) {
				ctx.ui.notify("Nothing imported yet — run /resume-session or the import_session tool first.", "error");
				return;
			}
			await ctx.switchSession(lastImported);
		},
	});
}
