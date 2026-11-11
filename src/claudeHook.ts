import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { agentDir } from "./config";

const HOOK_NAME = "vscode-claude-hook.mjs";
const PROMPTED_KEY = "omp.claudeHookPrompted";

/** Claude Code events the hook reports. Tool events track "waiting for permission" → "working". */
export const CLAUDE_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"Notification",
	"Stop",
	"SessionEnd",
] as const;

/** Where Claude Code's settings point: stable across extension updates, unlike the extension dir. */
export function claudeHookPath(): string {
	return path.join(agentDir(), HOOK_NAME);
}

/** The `hooks` block for ~/.claude/settings.json that runs the stable hook copy. */
export function claudeHooksSnippet(hookPath = claudeHookPath()): string {
	const command = `node ${JSON.stringify(hookPath)}`;
	const hooks: Record<string, unknown> = {};
	for (const event of CLAUDE_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
	return JSON.stringify({ hooks }, null, 2);
}

function settingsMentionHook(): boolean {
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
	for (const name of ["settings.json", "settings.local.json"]) {
		try {
			if (fs.readFileSync(path.join(configDir, name), "utf8").includes(HOOK_NAME)) return true;
		} catch {
			// missing settings file
		}
	}
	return false;
}

/**
 * Keeps `<agentDir>/vscode-claude-hook.mjs` identical to the bundled hook, and once per
 * machine offers the settings snippet when Claude Code does not run it yet.
 */
export function installClaudeHook(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): string {
	const target = claudeHookPath();
	try {
		const bundled = fs.readFileSync(context.asAbsolutePath("hook/claude-code-status.mjs"));
		let current: Buffer | undefined;
		try {
			current = fs.readFileSync(target);
		} catch {
			// first install
		}
		if (!current?.equals(bundled)) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, bundled, { mode: 0o644 });
			fs.renameSync(tmp, target);
			log.info(`Claude Code hook updated at ${target}`);
		}
	} catch (err) {
		log.warn(`Cannot install the Claude Code hook at ${target}: ${(err as Error).message}`);
		return target;
	}
	if (!settingsMentionHook() && !context.globalState.get<boolean>(PROMPTED_KEY)) {
		void context.globalState.update(PROMPTED_KEY, true);
		void vscode.window
			.showInformationMessage(
				"To show Claude Code sessions' status, add the OMP hook to ~/.claude/settings.json.",
				"Copy Hooks JSON",
			)
			.then((choice) => {
				if (choice) void vscode.env.clipboard.writeText(claudeHooksSnippet(target));
			});
	}
	return target;
}
