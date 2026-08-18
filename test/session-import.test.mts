import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ASSISTANT_TEXTS,
	EXPECTED_COMPACT_TURNS,
	FIRST_USER_TEXT,
	LAST_USER_TEXT,
	NOISE_USER_TEXT,
	SESSION_ID,
	SESSION_ID_PREFIX,
	SOURCE_BRANCH,
	SOURCE_CWD,
	TOOL_NAME,
	TOOL_RESULT_TEXT,
	writeClaudeFixture,
} from "./fixtures.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The extension resolves ~/.claude, ~/.codex and ~/.pi once at module load, so $HOME has to
 * be redirected before the first import. Everything the tests touch then lives under a temp
 * dir instead of the developer's real session stores.
 */
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-import-test-"));
process.env.HOME = home;

const fixtureFile = writeClaudeFixture(home);
const mod = await import("../extensions/session-import.ts");
const { importSession, resolveRef, searchSessions } = mod;

after(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	fs.rmSync(home, { recursive: true, force: true });
});

function readSession(file: string): Array<Record<string, any>> {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);
}

/** The imported turns, minus the synthetic bootstrap message importSession prepends. */
function importedTurns(records: Array<Record<string, any>>): Array<{ role: string; text: string }> {
	return records
		.filter((r) => r.type === "message")
		.slice(1)
		.map((r) => ({ role: r.message.role as string, text: r.message.content[0].text as string }));
}

describe("resolveRef", () => {
	it("resolves claude:<full-uuid> to the source transcript", () => {
		assert.deepEqual(resolveRef(`claude:${SESSION_ID}`), {
			agent: "claude",
			id: SESSION_ID,
			file: fixtureFile,
		});
	});

	it("resolves claude:<8-char-prefix> to the same transcript", () => {
		const hit = resolveRef(`claude:${SESSION_ID_PREFIX}`);
		assert.equal(hit.agent, "claude");
		assert.equal(hit.id, SESSION_ID);
		assert.equal(hit.file, fixtureFile);
	});

	it("resolves an absolute path to the transcript", () => {
		assert.deepEqual(resolveRef(fixtureFile), { agent: "claude", id: SESSION_ID, file: fixtureFile });
	});

	it("rejects a ref that matches nothing", () => {
		assert.throws(() => resolveRef("claude:ffffffff"), /No session matches/);
	});

	it("rejects a bare path that does not exist", () => {
		assert.throws(() => resolveRef("/nope/missing.jsonl"), /File not found/);
	});
});

describe("searchSessions", () => {
	it("indexes the fixture with its cwd and branch", () => {
		const [hit, ...rest] = searchSessions({ agent: "claude" });
		assert.equal(rest.length, 0);
		assert.equal(hit!.id, SESSION_ID);
		assert.equal(hit!.cwd, SOURCE_CWD);
		assert.equal(hit!.branch, SOURCE_BRANCH);
		assert.equal(hit!.first, FIRST_USER_TEXT);
		assert.equal(hit!.last, LAST_USER_TEXT);
	});

	it("matches on transcript keywords", () => {
		assert.equal(searchSessions({ agent: "claude", query: "widget parser" }).length, 1);
	});
});

describe("importSession", () => {
	it("writes a pi session file from claude:<id>", () => {
		const targetCwd = path.join(home, "work", "repo");
		const result = importSession({ ref: `claude:${SESSION_ID}`, targetCwd });

		assert.equal(result.agent, "claude");
		assert.equal(result.sourceFile, fixtureFile);
		assert.equal(result.sourceCwd, SOURCE_CWD);
		assert.equal(result.targetCwd, targetCwd);
		assert.equal(result.totalTurns, EXPECTED_COMPACT_TURNS.length);
		assert.equal(result.importedTurns, EXPECTED_COMPACT_TURNS.length);

		// written under the *target* cwd's pi session store, not the source cwd's
		assert.ok(
			result.outPath.startsWith(path.join(home, ".pi", "agent", "sessions", `--${path.join(home, "work", "repo").replace(/^\/+/, "").replaceAll("/", "-")}--`)),
			`unexpected outPath: ${result.outPath}`,
		);
		assert.ok(fs.existsSync(result.outPath));

		const records = readSession(result.outPath);
		assert.equal(records[0]!.type, "session");
		assert.equal(records[0]!.cwd, targetCwd);
		assert.equal(records[1]!.type, "model_change");
		assert.equal(records[2]!.type, "thinking_level_change");

		// bootstrap message names the source and carries the objective
		const bootstrap = records[3]!;
		assert.equal(bootstrap.message.role, "assistant");
		assert.match(bootstrap.message.content[0].text, /Imported from Claude Code session/);
		assert.ok(bootstrap.message.content[0].text.includes(fixtureFile));
		assert.ok(bootstrap.message.content[0].text.includes(FIRST_USER_TEXT));
		assert.ok(bootstrap.message.content[0].text.includes(LAST_USER_TEXT));

		assert.deepEqual(importedTurns(records), EXPECTED_COMPACT_TURNS);
	});

	it("drops harness-injected turns", () => {
		const result = importSession({ ref: `claude:${SESSION_ID}`, targetCwd: path.join(home, "work", "noise") });
		const body = fs.readFileSync(result.outPath, "utf8");
		assert.ok(!body.includes(NOISE_USER_TEXT), "harness-injected turn leaked into the import");
	});

	it("keeps parent links forming a single chain", () => {
		const result = importSession({ ref: `claude:${SESSION_ID}`, targetCwd: path.join(home, "work", "chain") });
		const records = readSession(result.outPath).filter((r) => r.type === "message" || r.type === "model_change" || r.type === "thinking_level_change");
		for (let i = 1; i < records.length; i += 1) {
			assert.equal(records[i]!.parentId, records[i - 1]!.id, `record ${i} is not linked to its predecessor`);
		}
	});

	it("includes tool calls and results in strict mode only", () => {
		const compact = readSession(
			importSession({ ref: `claude:${SESSION_ID}`, targetCwd: path.join(home, "work", "compact") }).outPath,
		);
		assert.ok(!JSON.stringify(compact).includes("[tool_use]"));

		const strictResult = importSession({
			ref: `claude:${SESSION_ID}`,
			mode: "strict",
			targetCwd: path.join(home, "work", "strict"),
		});
		const strict = JSON.stringify(readSession(strictResult.outPath));
		assert.ok(strict.includes(`[tool_use] ${TOOL_NAME}`));
		assert.ok(strict.includes("[tool_result]"));
		assert.ok(strict.includes(TOOL_RESULT_TEXT));
		assert.ok(strictResult.importedTurns > EXPECTED_COMPACT_TURNS.length);
	});

	it("honours --turns by keeping the most recent turns", () => {
		const result = importSession({ ref: `claude:${SESSION_ID}`, turns: 2, targetCwd: path.join(home, "work", "tail") });
		assert.equal(result.importedTurns, 2);
		assert.equal(result.totalTurns, EXPECTED_COMPACT_TURNS.length);
		assert.deepEqual(importedTurns(readSession(result.outPath)), EXPECTED_COMPACT_TURNS.slice(-2));
	});

	it("records the model passed in by the caller", () => {
		const result = importSession({
			ref: `claude:${SESSION_ID}`,
			targetCwd: path.join(home, "work", "model"),
			provider: "test-provider",
			modelId: "test/model-1",
		});
		const change = readSession(result.outPath).find((r) => r.type === "model_change")!;
		assert.equal(change.provider, "test-provider");
		assert.equal(change.modelId, "test/model-1");
	});
});

/* ------------------------------------------------------------------ commands */

type Registered = { description?: string; handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown };

function register(): { commands: Map<string, Registered>; tools: Map<string, any> } {
	const commands = new Map<string, Registered>();
	const tools = new Map<string, any>();
	mod.default({
		registerCommand: (name: string, def: Registered) => commands.set(name, def),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	} as any);
	return { commands, tools };
}

function makeCtx(customResult: string | null = null) {
	const notifications: Array<{ level: string; message: string }> = [];
	const switched: string[] = [];
	const customCalls: number[] = [];
	return {
		notifications,
		switched,
		customCalls,
		ctx: {
			ui: {
				notify: (message: string, level: string) => notifications.push({ level, message }),
				select: async () => null,
				custom: async () => {
					customCalls.push(1);
					return customResult;
				},
			},
			mode: "tui",
			cwd: SOURCE_CWD,
			model: { provider: "test-provider", id: "test/model-1" },
			switchSession: async (file: string) => {
				switched.push(file);
			},
		},
	};
}

describe("registered commands", () => {
	it("registers /resume-session and /import-open, and not /import", () => {
		const { commands, tools } = register();
		assert.ok(commands.has("resume-session"));
		assert.ok(commands.has("import-open"));
		assert.ok(
			!commands.has("import"),
			"pi's built-in /import is matched before extension commands, so registering 'import' is dead code",
		);
		assert.deepEqual([...tools.keys()].sort(), ["find_sessions", "import_session"]);
	});

	it("/resume-session claude:<id> imports and switches to the new session", async () => {
		const { commands } = register();
		const { ctx, switched, notifications } = makeCtx();

		await commands.get("resume-session")!.handler(`claude:${SESSION_ID}`, ctx);

		assert.equal(switched.length, 1, `expected one switchSession, got notifications: ${JSON.stringify(notifications)}`);
		const outPath = switched[0]!;
		assert.ok(fs.existsSync(outPath));
		assert.ok(outPath.startsWith(path.join(home, ".pi", "agent", "sessions")));
		assert.deepEqual(importedTurns(readSession(outPath)), EXPECTED_COMPACT_TURNS);
		assert.ok(notifications.some((n) => n.level === "info" && n.message.includes("Imported claude session")));
	});

	it("/resume-session passes --mode and --turns through", async () => {
		const { commands } = register();
		const { ctx, switched } = makeCtx();

		await commands.get("resume-session")!.handler(`--mode strict --turns 3 claude:${SESSION_ID}`, ctx);

		const records = readSession(switched[0]!);
		// --turns reached importSession: 3 turns instead of the 4 a compact import would yield
		assert.equal(importedTurns(records).length, 3);
		// --mode reached it too: the tail of the strict turn list starts with the tool result
		assert.match(importedTurns(records)[0]!.text, /^\[tool_result\] /);
	});

	it("/resume-session with no argument opens the full-screen picker", async () => {
		const { commands } = register();
		const { ctx, switched, notifications, customCalls } = makeCtx();

		await commands.get("resume-session")!.handler("   ", ctx);

		assert.equal(switched.length, 0);
		assert.equal(notifications.length, 0);
		assert.deepEqual(customCalls, [1]);
	});

	it("/resume-session imports the session selected in the picker", async () => {
		const { commands } = register();
		const { ctx, switched, notifications } = makeCtx(fixtureFile);

		await commands.get("resume-session")!.handler("", ctx);

		assert.equal(switched.length, 1, JSON.stringify(notifications));
		assert.deepEqual(importedTurns(readSession(switched[0]!)), EXPECTED_COMPACT_TURNS);
	});

	it("/resume-session surfaces an unresolvable ref as an error", async () => {
		const { commands } = register();
		const { ctx, switched, notifications } = makeCtx();

		await commands.get("resume-session")!.handler("claude:ffffffff", ctx);

		assert.equal(switched.length, 0);
		assert.equal(notifications[0]!.level, "error");
		assert.match(notifications[0]!.message, /No session matches/);
	});

	it("/import-open refuses before anything has been imported", async () => {
		const { commands } = register();
		const { ctx, switched, notifications } = makeCtx();

		await commands.get("import-open")!.handler("", ctx);

		assert.equal(switched.length, 0);
		assert.match(notifications[0]!.message, /\/resume-session/);
	});

	it("/import-open opens what import_session wrote", async () => {
		const { commands, tools } = register();
		const { ctx, switched } = makeCtx();

		const toolResult = await tools.get("import_session")!.execute("call-1", { ref: `claude:${SESSION_ID}` }, undefined, undefined, ctx);
		assert.ok(!toolResult.isError, JSON.stringify(toolResult));
		assert.equal(switched.length, 0, "the tool must not switch sessions on its own");

		await commands.get("import-open")!.handler("", ctx);
		assert.equal(switched.length, 1);
		assert.ok(fs.existsSync(switched[0]!));
	});

	it("import_session never points the user at pi's built-in /import", () => {
		const { tools } = register();
		const description: string = tools.get("import_session")!.description;
		assert.ok(description.includes("/resume-session"));
		assert.match(description, /Never tell the user to run \/import\b/);
	});
});

describe("README", () => {
	const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

	it("documents /resume-session", () => {
		assert.ok(readme.includes("/resume-session"));
	});

	it("has no /import usage example left in a code block", () => {
		const blocks = readme.match(/```[\s\S]*?```/g) ?? [];
		const offenders = blocks
			.flatMap((block) => block.split("\n"))
			.map((line) => line.trim())
			// /import-open is a real command of ours; bare /import is pi's built-in
			.filter((line) => /^\/import(\s|$)/.test(line));
		assert.deepEqual(offenders, []);
	});
});
