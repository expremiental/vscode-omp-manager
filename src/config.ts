import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

function setting(key: string): string {
	return vscode.workspace.getConfiguration("omp").get<string>(key)?.trim() ?? "";
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function agentDir(): string {
	const configured = setting("agentDir") || process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? expandHome(configured) : path.join(os.homedir(), ".omp", "agent");
}

export function sessionsDir(): string {
	return path.join(agentDir(), "sessions");
}

/** Directory where the omp-side hook records which session each terminal runs. */
export function terminalMapDir(): string {
	return path.join(agentDir(), "vscode-terminals");
}

/** Resolves the omp executable against PATH so it can be the terminal's process. */
export function ompExecutable(): string {
	return resolveExecutable(setting("executable") || "omp");
}

/** Claude Code's transcripts: `<projects>/<project slug>/<session id>.jsonl`. */
export function claudeProjectsDir(): string {
	const configured = setting("claude.projectsDir");
	if (configured) return expandHome(configured);
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
	return path.join(configDir ? expandHome(configDir) : path.join(os.homedir(), ".claude"), "projects");
}

/** Whether Claude Code sessions are listed and tracked alongside omp's. */
export function claudeEnabled(): boolean {
	return vscode.workspace.getConfiguration("omp").get<boolean>("claude.enabled", true);
}

/**
 * The claude executable. The extension host's PATH often lacks ~/.local/bin, where the
 * native installer puts it, so that is tried after PATH.
 */
export function claudeExecutable(): string {
	const configured = setting("claude.executable");
	if (configured) return resolveExecutable(configured);
	const resolved = resolveExecutable("claude");
	if (resolved !== "claude") return resolved;
	const local = path.join(os.homedir(), ".local", "bin", "claude");
	return fs.existsSync(local) ? local : resolved;
}

function resolveExecutable(name: string): string {
	const configured = expandHome(name);
	if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) return configured;
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = path.join(dir, configured + ext.toLowerCase());
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// not here
			}
		}
	}
	return configured;
}

/** Case-insensitive on Windows, normalized separators. */
export function normPath(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithin(child: string, parent: string): boolean {
	const c = normPath(child);
	const p = normPath(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
