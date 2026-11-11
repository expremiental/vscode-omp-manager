import assert = require("node:assert/strict");
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { parseAnySession, parseClaudeSession, parseSession, SessionIndex, SessionIndexes } from "../src/sessions";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claude-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ID = "0a5bc56f-6c84-49c5-9103-98459077c861";

function claudeLines(opts: { prompt?: string; ai?: string[]; custom?: string; padding?: number; caveat?: boolean } = {}): string {
	const lines: unknown[] = [
		{ type: "mode", mode: "normal", sessionId: ID },
		{ type: "file-history-snapshot", snapshot: { blob: "x".repeat(opts.padding ?? 0) } },
	];
	if (opts.caveat)
		lines.push({
			type: "user",
			isMeta: true,
			cwd: "/work/proj",
			sessionId: ID,
			timestamp: "2026-11-05T17:45:42.128Z",
			message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" },
		});
	if (opts.prompt !== undefined)
		lines.push({
			type: "user",
			cwd: "/work/proj",
			sessionId: ID,
			timestamp: "2026-11-05T17:45:43.000Z",
			message: { role: "user", content: [{ type: "text", text: opts.prompt }] },
		});
	for (const title of opts.ai ?? []) lines.push({ type: "assistant", message: { content: "ok" } }, { type: "ai-title", aiTitle: title, sessionId: ID });
	if (opts.custom) lines.push({ type: "custom-title", customTitle: opts.custom, sessionId: ID });
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

let n = 0;
function write(content: string, name = `${ID}.jsonl`): string {
	const file = path.join(tmp, `p${++n}`, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

test("parseClaudeSession reads id, cwd and start from the head, skipping meta records", () => {
	const info = parseClaudeSession(write(claudeLines({ prompt: "fix the login", caveat: true })), 1000);
	assert.equal(info?.agent, "claude");
	assert.equal(info?.id, ID);
	assert.equal(info?.cwd, "/work/proj");
	assert.equal(info?.title, "fix the login");
	assert.equal(info?.empty, false);
	assert.equal(info?.created, Date.parse("2026-11-05T17:45:42.128Z"));
});

test("parseClaudeSession prefers the custom title, then the latest AI title, then the first prompt", () => {
	assert.equal(parseClaudeSession(write(claudeLines({ prompt: "p", ai: ["Old", "New"] })), 0)?.title, "New");
	assert.equal(parseClaudeSession(write(claudeLines({ prompt: "p", ai: ["AI"], custom: "Mine" })), 0)?.title, "Mine");
});

test("parseClaudeSession finds the prompt past large metadata and the title in the tail", () => {
	const body = claudeLines({ prompt: "deep prompt", padding: 200 * 1024 });
	const filler = Array.from({ length: 400 }, () => JSON.stringify({ type: "assistant", message: { content: "y".repeat(500) } })).join("\n");
	const info = parseClaudeSession(write(`${body + filler}\n${JSON.stringify({ type: "ai-title", aiTitle: "Late title" })}\n`), 0);
	assert.equal(info?.title, "Late title");
	assert.equal(info?.cwd, "/work/proj");
});

test("parseClaudeSession flags sessions without a prompt as empty and rejects foreign files", () => {
	assert.equal(parseClaudeSession(write(claudeLines({ caveat: true })), 0)?.empty, true);
	assert.equal(parseClaudeSession(write(`${JSON.stringify({ type: "mode", sessionId: ID })}\n`), 0), null);
	const omp = write(
		`${JSON.stringify({ type: "session", id: "s1", cwd: "/w", timestamp: "2026-01-01T00:00:00Z" })}\n`,
		"2026_s1.jsonl",
	);
	assert.equal(parseClaudeSession(omp, 0), null);
	assert.equal(parseSession(write(claudeLines({ prompt: "p" })), 0), null);
	assert.equal(parseAnySession(omp, 0)?.agent, "omp");
	assert.equal(parseAnySession(write(claudeLines({ prompt: "p" })), 0)?.agent, "claude");
});

test("SessionIndexes merges omp and Claude listings and routes find by root", async () => {
	const ompRoot = path.join(tmp, "omp");
	const claudeRoot = path.join(tmp, "claude");
	const ompFile = path.join(ompRoot, "bucket", "a.jsonl");
	const claudeFile = path.join(claudeRoot, "-work-proj", `${ID}.jsonl`);
	fs.mkdirSync(path.dirname(ompFile), { recursive: true });
	fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
	fs.writeFileSync(ompFile, `${JSON.stringify({ type: "session", id: "o1", cwd: "/w", timestamp: "2026-01-01T00:00:00Z" })}\n`);
	fs.writeFileSync(claudeFile, claudeLines({ prompt: "hello" }));
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(claudeFile, later, later);
	const index = new SessionIndexes([new SessionIndex({ root: ompRoot }), new SessionIndex({ root: claudeRoot, agent: "claude" })]);
	try {
		await index.ensure();
		assert.deepEqual(
			index.list().map((s) => s.agent),
			["claude", "omp"],
		);
		assert.equal(index.find(claudeFile)?.title, "hello");
		assert.equal(index.find(ompFile)?.id, "o1");
	} finally {
		index.dispose();
	}
});

function runHook(dir: string, input: unknown, env: Record<string, string>) {
	return spawnSync(process.execPath, [path.join(dir, "vscode-claude-hook.mjs")], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		env: { PATH: process.env.PATH ?? "", ...env },
		encoding: "utf8",
	});
}

test("the Claude hook records state per terminal and removes it on exit", () => {
	const dir = path.join(tmp, "agent");
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(path.join(__dirname, "..", "..", "hook", "claude-code-status.mjs"), path.join(dir, "vscode-claude-hook.mjs"));
	const env = { TERM_PROGRAM: "vscode", CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: "cli" };
	const record = () => JSON.parse(fs.readFileSync(path.join(dir, "vscode-terminals", `pid-${process.pid}.json`), "utf8"));
	const transcript = path.join(tmp, "t.jsonl");

	assert.equal(runHook(dir, { hook_event_name: "SessionStart", transcript_path: transcript, session_id: "s", cwd: "/w" }, env).status, 0);
	assert.equal(record().state, "idle");
	assert.equal(record().ppid, process.ppid);
	runHook(dir, { hook_event_name: "UserPromptSubmit", transcript_path: transcript, cwd: "/w/sub" }, env);
	assert.equal(record().state, "working");
	assert.equal(record().cwd, "/w", "resume needs the directory the session started in");
	runHook(dir, { hook_event_name: "Notification", notification_type: "idle_prompt", transcript_path: transcript }, env);
	assert.equal(record().state, "working");
	runHook(dir, { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", transcript_path: transcript }, env);
	assert.equal(record().state, "waiting");
	runHook(dir, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", transcript_path: transcript }, env);
	assert.equal(record().state, "working");
	runHook(dir, { hook_event_name: "Stop", transcript_path: transcript }, env);
	assert.equal(record().state, "idle");
	// The key follows the launching terminal when the extension started claude.
	runHook(dir, { hook_event_name: "SessionStart", transcript_path: transcript }, { ...env, OMP_VSCODE_TERMINAL: "term-1" });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "vscode-terminals", "term-1.json"), "utf8")).terminalId, "term-1");

	runHook(dir, { hook_event_name: "SessionEnd", reason: "clear", transcript_path: transcript }, env);
	assert.ok(fs.existsSync(path.join(dir, "vscode-terminals", `pid-${process.pid}.json`)));
	runHook(dir, { hook_event_name: "SessionEnd", reason: "prompt_input_exit", transcript_path: transcript }, env);
	assert.ok(!fs.existsSync(path.join(dir, "vscode-terminals", `pid-${process.pid}.json`)));
});

test("the Claude hook stays silent outside VS Code terminals and on bad input", () => {
	const dir = path.join(tmp, "agent2");
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(path.join(__dirname, "..", "..", "hook", "claude-code-status.mjs"), path.join(dir, "vscode-claude-hook.mjs"));
	const transcript = path.join(tmp, "t.jsonl");
	const base = { CLAUDE_PID: String(process.pid) };
	assert.equal(runHook(dir, { hook_event_name: "Stop", transcript_path: transcript }, { ...base, TERM_PROGRAM: "iTerm.app" }).status, 0);
	assert.equal(runHook(dir, { hook_event_name: "Stop", transcript_path: transcript }, { ...base, TERM_PROGRAM: "vscode", CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }).status, 0);
	assert.equal(runHook(dir, "not json", { ...base, TERM_PROGRAM: "vscode" }).status, 0);
	assert.ok(!fs.existsSync(path.join(dir, "vscode-terminals")));
});
