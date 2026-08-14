/**
 * Synthetic Claude Code transcript, written into a throwaway $HOME.
 *
 * Deliberately hand-written: no real transcript, no paths outside the temp dir, no secrets.
 * It carries just enough shape for the parser — cwd/gitBranch metadata, a harness-injected
 * turn that must be dropped, a tool_use/tool_result pair, and plain user/assistant text.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const SESSION_ID = "4d32e97e-2389-464c-8d20-5b9b9a3bb373";
export const SESSION_ID_PREFIX = SESSION_ID.slice(0, 8);
export const SOURCE_CWD = "/tmp/session-import-fixture";
export const SOURCE_BRANCH = "main";
export const PROJECT_DIR = "-tmp-session-import-fixture";

export const FIRST_USER_TEXT = "why does the widget parser drop the trailing frame?";
export const LAST_USER_TEXT = "ok, add a regression test for that";
export const NOISE_USER_TEXT = "<system-reminder>this turn is injected by the harness</system-reminder>";
export const ASSISTANT_TEXTS = ["the tail chunk is cut mid-line", "added the test"];
export const TOOL_NAME = "Read";
// single-line on purpose: strict-mode tool text goes through squash(), which collapses whitespace
export const TOOL_RESULT_TEXT = "const frames = splitLines(chunk).slice(1)";

/** user/assistant turns the parser is expected to keep, in order. */
export const EXPECTED_COMPACT_TURNS: Array<{ role: "user" | "assistant"; text: string }> = [
	{ role: "user", text: FIRST_USER_TEXT },
	{ role: "assistant", text: ASSISTANT_TEXTS[0]! },
	{ role: "user", text: LAST_USER_TEXT },
	{ role: "assistant", text: ASSISTANT_TEXTS[1]! },
];

function userEntry(text: string, timestamp: string): Record<string, unknown> {
	return {
		type: "user",
		cwd: SOURCE_CWD,
		gitBranch: SOURCE_BRANCH,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantEntry(content: unknown[], timestamp: string): Record<string, unknown> {
	return {
		type: "assistant",
		cwd: SOURCE_CWD,
		gitBranch: SOURCE_BRANCH,
		timestamp,
		message: { role: "assistant", content },
	};
}

const ENTRIES: Array<Record<string, unknown>> = [
	{ type: "summary", summary: "widget parser tail bug" },
	userEntry(NOISE_USER_TEXT, "2026-08-14T00:00:00.000Z"),
	userEntry(FIRST_USER_TEXT, "2026-08-14T00:01:00.000Z"),
	assistantEntry(
		[
			{ type: "text", text: ASSISTANT_TEXTS[0] },
			{ type: "tool_use", name: TOOL_NAME, input: { file_path: `${SOURCE_CWD}/parser.ts` } },
		],
		"2026-08-14T00:02:00.000Z",
	),
	{
		type: "user",
		cwd: SOURCE_CWD,
		gitBranch: SOURCE_BRANCH,
		timestamp: "2026-08-14T00:03:00.000Z",
		message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: TOOL_RESULT_TEXT }] }] },
	},
	userEntry(LAST_USER_TEXT, "2026-08-14T00:04:00.000Z"),
	assistantEntry([{ type: "text", text: ASSISTANT_TEXTS[1] }], "2026-08-14T00:05:00.000Z"),
];

/** Write the fixture transcript into `<home>/.claude/projects/...` and return its path. */
export function writeClaudeFixture(home: string): string {
	const dir = path.join(home, ".claude", "projects", PROJECT_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${SESSION_ID}.jsonl`);
	fs.writeFileSync(file, `${ENTRIES.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	return file;
}
