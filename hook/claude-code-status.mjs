#!/usr/bin/env node
// Claude Code hook: report which session each VS Code terminal runs, and what it is doing.
//
// The OMP Session Manager extension copies this file to `<agentDir>/vscode-claude-hook.mjs`
// on activation; Claude Code's settings run that copy for SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, PermissionRequest, Notification, Stop and SessionEnd:
//
//   { "type": "command", "command": "node ~/.omp/agent/vscode-claude-hook.mjs" }
//
// It writes the same record the omp hook does, `<agentDir>/vscode-terminals/<key>.json`,
// next to this file. The key is OMP_VSCODE_TERMINAL when the extension launched claude.
// Otherwise it is `pid-<claude pid>` and `ppid` is the shell that started claude, so the
// extension adopts that shell's terminal. Outside VS Code terminals it does nothing.
//
// A hook must never disturb Claude: every failure is swallowed and the exit code is 0.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL_ENV = "OMP_VSCODE_TERMINAL";
const MAP_DIRNAME = "vscode-terminals";
// Tools that block on the user's answer, like omp's `ask`.
const ASK_TOOLS = new Set(["AskUserQuestion"]);
// Notifications that mean Claude is blocked on the user. `idle_prompt` only repeats that a
// finished turn waits for a prompt, which is already "idle".
const WAITING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

function inVsCodeTerminal() {
	if (process.env[TERMINAL_ENV]) return true;
	if (process.env.TERM_PROGRAM !== "vscode") return false;
	// The Claude Code VS Code panel also runs under VS Code but has no terminal to adopt.
	const entry = process.env.CLAUDE_CODE_ENTRYPOINT;
	return !entry || entry === "cli";
}

function parentOf(pid) {
	const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
	const ppid = Number(out.trim());
	return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
}

function commandOf(pid) {
	return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
}

/** The claude process: CLAUDE_PID when Claude exports it, else the nearest `claude` ancestor. */
function claudePid() {
	const env = Number(process.env.CLAUDE_PID);
	if (Number.isSafeInteger(env) && env > 0) return env;
	let pid = process.ppid;
	for (let i = 0; i < 6 && pid && pid > 1; i++) {
		if (path.basename(commandOf(pid)) === "claude" || /\/claude\/versions\//.test(commandOf(pid))) return pid;
		pid = parentOf(pid);
	}
	return undefined;
}

function stateFor(input) {
	switch (input.hook_event_name) {
		case "SessionStart":
		case "Stop":
			return "idle";
		case "UserPromptSubmit":
		case "PostToolUse":
			return "working";
		case "PreToolUse":
			return ASK_TOOLS.has(input.tool_name) ? "waiting" : "working";
		case "PermissionRequest":
			return "waiting";
		case "Notification":
			return WAITING_NOTIFICATIONS.has(input.notification_type) ? "waiting" : undefined;
		default:
			return undefined;
	}
}

function readInput() {
	try {
		return JSON.parse(fs.readFileSync(0, "utf8"));
	} catch {
		return undefined;
	}
}

function main() {
	if (!inVsCodeTerminal()) return;
	const input = readInput();
	if (!input || typeof input !== "object") return;
	const pid = claudePid();
	if (!pid) return;
	const key = process.env[TERMINAL_ENV] || `pid-${pid}`;
	// The key becomes a file name; refuse anything that could leave the directory.
	if (!/^[\w-]+$/.test(key)) return;
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), MAP_DIRNAME);
	const file = path.join(dir, `${key}.json`);

	if (input.hook_event_name === "SessionEnd") {
		// Remove only our own record: a /clear or /resume reuses the key with the same pid.
		if (input.reason === "clear" || input.reason === "resume") return;
		try {
			const rec = JSON.parse(fs.readFileSync(file, "utf8"));
			if (rec?.pid === pid) fs.rmSync(file, { force: true });
		} catch {
			// already gone
		}
		return;
	}

	const state = stateFor(input);
	if (!state) return;
	const sessionFile = typeof input.transcript_path === "string" ? input.transcript_path : "";
	if (!path.isAbsolute(sessionFile)) return;
	let previous;
	try {
		previous = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		// first report
	}
	// Tool hooks fire on every call; an unchanged report costs one read, not a write and `ps`.
	if (previous?.pid === pid && previous.state === state && previous.sessionFile === sessionFile) return;
	const record = {
		agent: "claude",
		terminalId: process.env[TERMINAL_ENV] || undefined,
		pid,
		ppid: previous?.pid === pid && previous.ppid ? previous.ppid : parentOf(pid),
		sessionFile,
		sessionId: typeof input.session_id === "string" ? input.session_id : path.basename(sessionFile, ".jsonl"),
		// `claude --resume` must run where the session started; later reports carry the shell's
		// current directory, which drifts with every `cd`, so the first one for a transcript wins.
		cwd:
			previous?.sessionFile === sessionFile && typeof previous.cwd === "string"
				? previous.cwd
				: typeof input.cwd === "string"
					? input.cwd
					: process.cwd(),
		state,
		updatedAt: Date.now(),
	};
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

try {
	main();
} catch {
	// Never fail a Claude Code turn because the sidebar could not be told about it.
}
process.exit(0);
