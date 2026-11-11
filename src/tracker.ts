import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { claudeExecutable, claudeProjectsDir, isWithin, normPath, ompExecutable, terminalMapDir } from "./config";
import type { AgentKind } from "./sessions";

/** Env var the omp-side hook reads to tie a session to the terminal that runs it. */
export const TERMINAL_ENV = "OMP_VSCODE_TERMINAL";

const STATE_KEY = "omp.openSessions";
// Window close can surface as a non-shutdown exit before the extension host stops.
// Removal waits this long so a closing window never forgets its sessions.
const CLOSE_GRACE_MS = 1500;
// Restore waits this long for each terminal's process before opening the next. A focused
// editor terminal spawns within a few hundred ms; one that does not should not hold up the rest.
const SPAWN_WAIT_MS = 2000;
// omp reports its session a second or two after it starts. Silence past this means
// the hook did not load, and restore cannot follow the terminal.
const REPORT_TIMEOUT_MS = 10_000;
// Map files written for omp started by hand in a shell terminal, not by this extension.
const ADOPTED_PREFIX = "pid-";

/** What the omp in a terminal is doing, as reported by the hook. `unknown`: no trustworthy report. */
export type SessionState = "idle" | "working" | "waiting" | "unknown";
const STATES: readonly string[] = ["idle", "working", "waiting"] satisfies SessionState[];

/** Written by the omp hook to `<agentDir>/vscode-terminals/<key>.json`. */
interface MapRecord {
	terminalId?: string;
	pid?: number;
	ppid?: number;
	sessionFile?: string;
	cwd?: string;
	state?: string;
	updatedAt?: number;
}

interface SavedSession {
	sessionFile: string;
	cwd: string;
}

interface Tracked {
	key: string;
	terminal: vscode.Terminal;
	cwd: string;
	sessionFile?: string;
	state?: SessionState;
	/** The hook has written a record for this terminal. */
	reported: boolean;
	/** Launched by this window and not reported within REPORT_TIMEOUT_MS. */
	stalled?: boolean;
	/** When this window launched the terminal; timings in the log are relative to it. */
	launchedAt?: number;
	/** Timestamp when this terminal entered the working state. */
	workingSince?: number;
	/** Shell process of the terminal. */
	pid?: number;
	/** omp process, as reported by the hook. */
	agentPid?: number;
	/** Which CLI this window launched in the terminal; adopted terminals leave it unset. */
	agent?: AgentKind;
}

export interface OpenSession {
	terminal: vscode.Terminal;
	terminalKey: string;
	cwd: string;
	pid?: number;
	agentPid?: number;
	state: SessionState;
	/** Launched and not yet reported by omp, which can take several seconds to boot. */
	launching: boolean;
}

export interface StateChange {
	sessionFile: string;
	terminal: vscode.Terminal;
	previous?: SessionState;
	state: SessionState;
	/** How long the terminal was in the working state, when leaving working. */
	workedMs?: number;
}

export interface LaunchOptions {
	cwd?: string;
	sessionFile?: string;
	preserveFocus?: boolean;
	/** Overrides the `omp.terminalLocation` setting. */
	location?: "editor" | "panel";
	/** CLI to start; resuming follows the transcript's location, a new session defaults to omp. */
	agent?: AgentKind;
	/** Explicit cross-window target captured by the caller; stale targets never launch. */
	ownerId?: string;
	terminalKey?: string;
}

export interface RevealSession {
	sessionFile: string;
	terminal: vscode.Terminal;
	previousGroup?: vscode.TabGroup;
	previousTab?: vscode.Tab;
	previousTerminal?: vscode.Terminal;
	location?: string;
}

export interface RestoredTerminal {
	terminal: vscode.Terminal;
	previousTab?: vscode.Tab;
}

export interface ReleasedSession {
	sessionFile: string;
	terminalKey: string;
	pid?: number;
}

interface LaunchState {
	attempted: boolean;
	terminalKey?: string;
}

function fileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Claude Code transcripts live under its projects dir; everything else is omp's. */
export function agentOf(sessionFile: string): AgentKind {
	return isWithin(sessionFile, claudeProjectsDir()) ? "claude" : "omp";
}

function envKey(terminal: vscode.Terminal): string | undefined {
	const opts = terminal.creationOptions;
	const value = "env" in opts ? opts.env?.[TERMINAL_ENV] : undefined;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Tracks omp terminals in open order and persists them per workspace, so the
 * sessions open when VS Code closed come back in the same order on next start.
 */
export class TerminalTracker implements vscode.Disposable {
	private tracked: Tracked[] = [];
	private readonly pids = new Map<vscode.Terminal, number>();
	private readonly pendingClose = new Map<vscode.Terminal, NodeJS.Timeout>();
	private readonly reportTimers = new Set<NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: fs.FSWatcher | undefined;
	/** Launch timings, for diagnosing slow session starts. */
	readonly log = vscode.window.createOutputChannel("OMP", { log: true });
	restoring = false;
	private warnedUnreported = false;
	/** Cross-window ownership is resolved before any explicit resume or automatic restore. */
	sessionRouter?: (opts: LaunchOptions) => Promise<boolean>;
	restoreGuard?: (file: string) => Promise<boolean>;
	launchGuard?: (file: string) => Promise<unknown>;
	launchSettled?: (file: string, token: unknown, registered: boolean, failedBeforeCreation: boolean, terminalKey?: string) => void;
	/**
	 * Saved sessions awaiting restore, including ones blocked by another window's
	 * ownership. save() retains them without treating startup checks as viewing.
	 */
	private pendingRestore: SavedSession[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly stateChanged = new vscode.EventEmitter<StateChange>();
	readonly onDidChangeState = this.stateChanged.event;
	private readonly revealed = new vscode.EventEmitter<RevealSession>();
	readonly onDidRevealSession = this.revealed.event;
	private readonly restoredTerminal = new vscode.EventEmitter<RestoredTerminal>();
	readonly onDidRestoreTerminal = this.restoredTerminal.event;
	private readonly releasedSession = new vscode.EventEmitter<ReleasedSession>();
	readonly onDidReleaseSession = this.releasedSession.event;

	/**
	 * `hookPath`: the bundled omp extension that reports each terminal's session.
	 * `claudeHookPath`: the stable copy of the Claude Code hook that Claude's settings run.
	 */
	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly hookPath: string,
		private readonly claudeHookPath = "",
	) {}

	async start(): Promise<void> {
		const saved = this.ctx.workspaceState.get<SavedSession[]>(STATE_KEY) ?? [];
		// Adoption can save synchronously; protect the unopened entries before reading maps.
		this.pendingRestore = saved;
		const dir = terminalMapDir();
		fs.mkdirSync(dir, { recursive: true });
		this.disposables.push(
			vscode.window.onDidOpenTerminal((t) => void this.notePid(t)),
			vscode.window.onDidCloseTerminal((t) => this.onClose(t)),
		);
		try {
			this.watcher = fs.watch(dir, (_event, name) => {
				if (name && String(name).endsWith(".json")) this.applyMapFile(path.join(dir, String(name)));
			});
			this.watcher.on("error", () => this.watcher?.close());
		} catch {
			// Without a watcher, session switches inside a terminal go unnoticed until the next event.
		}

		// Terminals survive an extension host restart; re-adopt ours before restoring.
		await Promise.all(vscode.window.terminals.map((t) => this.notePid(t)));
		for (const terminal of vscode.window.terminals) {
			const key = envKey(terminal);
			if (key) this.track(terminal, key, "");
		}
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(".json")) this.applyMapFile(path.join(dir, name));
		}

		const open = this.openSessions();
		const toRestore = saved.filter((s) => fileExists(s.sessionFile) && !open.has(normPath(s.sessionFile)));
		const mode = vscode.workspace.getConfiguration("omp").get<string>("restoreOnStartup", "always");
		this.pendingRestore = mode === "always" || mode === "ask" ? toRestore : [];
		if (mode === "always") await this.restore(toRestore);
		else if (mode === "ask" && toRestore.length) this.askRestore(toRestore);
		this.save();
		this.changed.fire();
	}

	/** Session file (normalized) -> live local terminal and stable ownership metadata. */
	openSessions(): Map<string, OpenSession> {
		const out = new Map<string, OpenSession>();
		for (const t of this.tracked) {
			if (t.sessionFile && t.terminal.exitStatus === undefined && vscode.window.terminals.includes(t.terminal) && (t.agentPid === undefined || pidAlive(t.agentPid)))
				out.set(normPath(t.sessionFile), { terminal: t.terminal, terminalKey: t.key, cwd: t.cwd, pid: t.pid, agentPid: t.agentPid, state: t.state ?? "unknown", launching: !t.reported && !t.stalled });
		}
		return out;
	}

	/** Reveals only the exact live local terminal; never resumes or invokes the router. */
	async focusExisting(opts: LaunchOptions & { sessionFile: string }): Promise<boolean> {
		const existing = this.openSessions().get(normPath(opts.sessionFile));
		if (!existing || (opts.terminalKey && existing.terminalKey !== opts.terminalKey))
			throw new Error("Эта сессия больше не доступна в выбранном окне. Новый OMP не запущен.");
		const previousGroup = vscode.window.tabGroups.activeTabGroup;
		const previousTab = previousGroup.activeTab;
		const previousTerminal = vscode.window.activeTerminal;
		// Capture focus before show(): attention must observe the actual terminal editor reveal.
		if (!opts.preserveFocus)
			this.revealed.fire({ sessionFile: opts.sessionFile, terminal: existing.terminal, previousGroup, previousTab, previousTerminal, location: opts.location });
		existing.terminal.show(opts.preserveFocus);
		// These commands act on the terminal show() just selected, in its owning window.
		if (opts.location === "panel") await vscode.commands.executeCommand("workbench.action.terminal.moveToTerminalPanel");
		else if (opts.location === "editor") await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor");
		return true;
	}

	/** Routes every existing session to its owner, resuming only a proven closed session. */
	async open(opts: LaunchOptions): Promise<void> {
		if (opts.sessionFile) {
			if (this.sessionRouter) {
				if (await this.sessionRouter(opts)) return;
			} else if (this.openSessions().has(normPath(opts.sessionFile))) {
				await this.focusExisting({ ...opts, sessionFile: opts.sessionFile });
				return;
			}
			// A stale explicit target must never become a new terminal.
			if (opts.ownerId || opts.terminalKey) throw new Error("Окно этой сессии больше не доступно. Новый OMP не запущен.");
		}
		const reservation = opts.sessionFile && this.launchGuard ? await this.launchGuard(opts.sessionFile) : undefined;
		const launchState: LaunchState | undefined = reservation ? { attempted: false } : undefined;
		try {
			const previousGroup = vscode.window.tabGroups.activeTabGroup;
			const previousTab = previousGroup.activeTab;
			const previousTerminal = vscode.window.activeTerminal;
			const terminal = this.launch(opts, false, launchState);
			// Automatic restore calls launch() directly and never emits an explicit reveal.
			if (!opts.preserveFocus && opts.sessionFile)
				this.revealed.fire({ sessionFile: opts.sessionFile, terminal, previousGroup, previousTab, previousTerminal, location: opts.location ?? vscode.workspace.getConfiguration("omp").get<string>("terminalLocation", "editor") });
			terminal.show(opts.preserveFocus);
		} finally {
			if (reservation && opts.sessionFile && launchState)
				this.launchSettled?.(opts.sessionFile, reservation, this.openSessions().has(normPath(opts.sessionFile)), !launchState.attempted, launchState.terminalKey);
		}
	}

	/** `continueTurn`: open with `--restore`, which also goes on with a turn and subagents the last omp left unfinished. */
	private launch(opts: LaunchOptions, continueTurn = false, launchState?: LaunchState): vscode.Terminal {
		const launchedAt = Date.now();
		const cfg = vscode.workspace.getConfiguration("omp");
		const key = crypto.randomUUID();
		const location = opts.location ?? cfg.get<string>("terminalLocation");
		const inPanel = location === "panel";
		const agent = opts.sessionFile ? agentOf(opts.sessionFile) : (opts.agent ?? "omp");

		let args: string[];
		let reopen: string;
		if (agent === "claude") {
			// Claude Code reports through its own hooks (see hook/claude-code-status.mjs) and
			// resumes by session id; the transcript is named after it. It has no --restore.
			args = [];
			for (const a of cfg.get<unknown[]>("claude.extraArgs", [])) if (typeof a === "string") args.push(a);
			reopen = "--resume";
			if (opts.sessionFile) args.push(reopen, path.basename(opts.sessionFile, ".jsonl"));
		} else {
			// Apply extraArgs after the hook, before --resume or --restore
			args = ["-e", this.hookPath];
			const extraArgs = cfg.get<unknown[]>("extraArgs", []);
			for (const a of extraArgs) if (typeof a === "string") args.push(a);
			reopen = continueTurn ? "--restore" : "--resume";
			if (opts.sessionFile) args.push(reopen, opts.sessionFile);
		}

		// Merge custom env, but let OMP_VSCODE_TERMINAL always win
		const env: Record<string, string> = { [TERMINAL_ENV]: key };
		const customEnv = cfg.get<Record<string, unknown>>("env", {});
		for (const [k, v] of Object.entries(customEnv)) {
			if (typeof v === "string" && k !== TERMINAL_ENV) env[k] = v;
		}

		const iconId = (agent === "claude" ? cfg.get<string>("claude.terminalIcon")?.trim() : cfg.get<string>("terminalIcon")?.trim()) || (agent === "claude" ? "hubot" : "sparkle");
		const colorId = cfg.get<string>("terminalColor")?.trim();
		const color = colorId ? new vscode.ThemeColor(colorId) : undefined;

		const terminalOptions: vscode.TerminalOptions = {
			// No `name`: a fixed name would pin the tab label. Without one, the tab follows
			// the title omp sets (`π > <session title>`) when `terminal.integrated.tabs.title`
			// includes `${sequence}`.
			shellPath: agent === "claude" ? claudeExecutable() : ompExecutable(),
			shellArgs: args,
			cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined,
			env,
			iconPath: new vscode.ThemeIcon(iconId, color),
			color,
			// VS Code must not revive these itself; this tracker restores them.
			isTransient: true,
			location: inPanel
				? vscode.TerminalLocation.Panel
				: { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus },
		};
		if (launchState) {
			launchState.attempted = true;
			launchState.terminalKey = key;
		}
		const terminal = vscode.window.createTerminal(terminalOptions);
		// A fresh terminal is never tracked yet, so track() always returns an entry here.
		const entry = this.track(terminal, key, opts.cwd ?? "", opts.sessionFile)!;
		entry.launchedAt = launchedAt;
		entry.agent = agent;
		if (inPanel) terminal.show(opts.preserveFocus);
		this.log.info(`[${key.slice(0, 8)}] ${agent} ${opts.sessionFile ? `${reopen.slice(2)} ${opts.sessionFile}` : "new session"} in ${inPanel ? "panel" : "editor"}; terminal created ${this.since(entry)}`);
		void terminal.processId.then((pid) => this.log.info(`[${key.slice(0, 8)}] process ${pid ?? "(none)"} started ${this.since(entry)}`));
		this.watchForReport(entry);
		this.save();
		this.changed.fire();
		return terminal;
	}

	private since(entry: Tracked): string {
		return entry.launchedAt === undefined ? "" : `+${Date.now() - entry.launchedAt}ms`;
	}

	// Launches one at a time: VS Code defers spawning a terminal until its editor is
	// laid out, and a burst of hidden editor terminals at startup can come up blank.
	// Each restored tab takes focus in turn so it spawns before the next opens.
	private async restore(sessions: SavedSession[]): Promise<void> {
		this.restoring = true;
		const pending = new Map(this.pendingRestore.map((s) => [normPath(s.sessionFile), s]));
		for (const s of sessions) pending.set(normPath(s.sessionFile), s);
		this.pendingRestore = [...pending.values()];
		this.changed.fire();
		// Sessions come back here after VS Code closed or crashed, which can cut a turn off mid-run.
		const continueTurns = vscode.workspace.getConfiguration("omp").get<boolean>("restoreContinuesTurns", false);
		try {
			for (const s of sessions) {
				const file = normPath(s.sessionFile);
				// A session may have been opened by hand while the "ask" prompt waited.
				if (this.openSessions().has(file)) {
					this.pendingRestore = this.pendingRestore.filter((saved) => normPath(saved.sessionFile) !== file);
					continue;
				}
				let reservation: unknown;
				try {
					// This guard only checks ownership; startup must never focus another window.
					if (this.restoreGuard && !(await this.restoreGuard(s.sessionFile))) continue;
					reservation = this.launchGuard ? await this.launchGuard(s.sessionFile) : undefined;
				} catch (err) {
					this.log.warn(`Restore skipped for ${s.sessionFile}: ${(err as Error).message ?? err}`);
					continue;
				}
				let terminal: vscode.Terminal;
				const launchState: LaunchState | undefined = reservation ? { attempted: false } : undefined;
				try {
					const previousTab = vscode.window.tabGroups.activeTabGroup.activeTab;
					terminal = this.launch({ cwd: s.cwd, sessionFile: s.sessionFile }, continueTurns, launchState);
					this.pendingRestore = this.pendingRestore.filter((saved) => normPath(saved.sessionFile) !== file);
					this.restoredTerminal.fire({ terminal, previousTab });
				} finally {
					if (reservation && launchState)
						this.launchSettled?.(s.sessionFile, reservation, this.openSessions().has(file), !launchState.attempted, launchState.terminalKey);
				}
				const spawned = await Promise.race([terminal.processId.then(() => true), sleep(SPAWN_WAIT_MS).then(() => false)]);
				if (!spawned) this.log.warn(`No process ${SPAWN_WAIT_MS}ms after restoring ${s.sessionFile}; restoring the next session`);
			}
		} finally {
			this.restoring = false;
			this.changed.fire();
		}
	}

	/** Asks without blocking activation. Unanswered sessions stay saved for the next start. */
	private askRestore(sessions: SavedSession[]): void {
		this.pendingRestore = sessions;
		const n = sessions.length;
		const msg = n === 1 ? "Restore 1 omp session?" : `Restore ${n} omp sessions?`;
		void vscode.window.showInformationMessage(msg, "Restore").then(async (choice) => {
			if (choice !== "Restore") return;
			await this.restore(sessions);
			this.save();
			this.changed.fire();
		});
	}

	/** Warns once per window when a launched omp never reports its session. */
	private watchForReport(entry: Tracked): void {
		const timer = setTimeout(() => {
			this.reportTimers.delete(timer);
			const alive = this.tracked.includes(entry) && entry.terminal.exitStatus === undefined;
			if (!alive || entry.reported) return;
			entry.stalled = true;
			this.changed.fire();
			const claude = entry.agent === "claude";
			const hint = claude
				? `check that ~/.claude/settings.json runs ${this.claudeHookPath} for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd`
				: `check that it can load ${this.hookPath} with -e`;
			this.log.warn(`[${entry.key.slice(0, 8)}] ${claude ? "claude" : "omp"} has not reported ${this.since(entry)}; ${hint}`);
			if (this.warnedUnreported) return;
			this.warnedUnreported = true;
			void vscode.window
				.showWarningMessage(
					claude
						? `Claude Code has not reported its session, so this terminal will not be restored and shows no status. Check that its hooks run ${this.claudeHookPath}.`
						: "omp has not reported its session, so this terminal will not be restored and shows no status. " +
								`Check that this omp version can load extensions with -e (${this.hookPath}).`,
					"Show Log",
				)
				.then((choice) => {
					if (choice) this.log.show();
				});
		}, REPORT_TIMEOUT_MS);
		this.reportTimers.add(timer);
	}

	private track(terminal: vscode.Terminal, key: string, cwd: string, sessionFile?: string): Tracked | undefined {
		const existing = this.tracked.find((t) => t.terminal === terminal);
		if (existing) {
			if (existing.key === key) return existing;
			// A surviving shell may start another OMP after its prior agent exited.
			// Never apply a new key's report to the old agent's identity.
			if (existing.agentPid === undefined || pidAlive(existing.agentPid)) return undefined;
			this.untrack(existing);
		}
		const entry: Tracked = { key, terminal, cwd, sessionFile, pid: this.pids.get(terminal), reported: false };
		this.tracked.push(entry);
		return entry;
	}

	private async notePid(terminal: vscode.Terminal): Promise<void> {
		const pid = await terminal.processId;
		if (pid === undefined || terminal.exitStatus !== undefined || !vscode.window.terminals.includes(terminal)) return;
		this.pids.set(terminal, pid);
		const entry = this.tracked.find((t) => t.terminal === terminal);
		if (entry) {
			entry.pid = pid;
			this.changed.fire();
		}
		// A manual OMP can write its map before this async processId resolves. Re-read
		// only matching pid maps now; otherwise there may be no later filesystem event.
		const dir = terminalMapDir();
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.startsWith(ADOPTED_PREFIX) || !name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			try {
				const rec = JSON.parse(fs.readFileSync(file, "utf8")) as MapRecord | null;
				if (rec?.ppid === pid || rec?.pid === pid) this.applyMapFile(file);
			} catch {
				// A concurrent hook write is handled by the watcher.
			}
		}
	}

	private markUnknown(entry: Tracked | undefined): void {
		if (!entry || entry.state === "unknown") return;
		const previous = entry.state;
		entry.state = "unknown";
		entry.workingSince = undefined;
		this.changed.fire();
		if (entry.sessionFile) this.stateChanged.fire({ sessionFile: entry.sessionFile, terminal: entry.terminal, previous, state: "unknown" });
	}

	private applyMapFile(file: string): void {
		const key = path.basename(file, ".json");
		let entry = this.tracked.find((t) => t.key === key);
		let rec: MapRecord | null;
		try {
			rec = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			// Missing reports are not proof of closure: the local shell/agent may still run.
			const agentPid = entry?.agentPid ?? (/^pid-\d+$/.test(key) ? Number(key.slice(ADOPTED_PREFIX.length)) : undefined);
			if ((err as NodeJS.ErrnoException).code === "ENOENT" && entry && agentPid && !pidAlive(agentPid)) this.untrack(entry);
			else this.markUnknown(entry);
			return;
		}
		if (!rec || typeof rec !== "object") {
			this.markUnknown(entry);
			return;
		}
		if (typeof rec.pid === "number" && !pidAlive(rec.pid)) {
			// omp is gone (VS Code closed or it crashed); the saved workspace state already has the session.
			fs.rmSync(file, { force: true });
			if (entry) this.untrack(entry);
			else this.markUnknown(entry);
			return;
		}
		if (typeof rec.sessionFile !== "string" || !rec.sessionFile) {
			this.markUnknown(entry);
			return;
		}
		const record = rec;
		if (!entry && key.startsWith(ADOPTED_PREFIX)) {
			const terminal = vscode.window.terminals.find((t) => {
				const pid = this.pids.get(t);
				return pid !== undefined && (pid === record.ppid || pid === record.pid);
			});
			if (terminal) entry = this.track(terminal, key, "");
		}
		if (!entry) return;
		const agentPidChanged = typeof rec.pid === "number" && entry.agentPid !== rec.pid;
		if (typeof rec.pid === "number") entry.agentPid = rec.pid;
		const state = (rec.state && STATES.includes(rec.state) ? rec.state : "unknown") as SessionState;
		if (!entry.reported && entry.launchedAt !== undefined) this.log.info(`[${key.slice(0, 8)}] omp reported (${state}) ${this.since(entry)}`);
		entry.reported = true;
		entry.stalled = false;
		const cwd = typeof rec.cwd === "string" ? rec.cwd : entry.cwd;
		const sameSession = !!entry.sessionFile && normPath(entry.sessionFile) === normPath(rec.sessionFile);
		const previous = sameSession ? entry.state : undefined;
		const moved = entry.sessionFile !== rec.sessionFile || entry.cwd !== cwd;
		if (!sameSession) entry.workingSince = undefined;
		if (!moved && previous === state && !agentPidChanged) return;
		entry.sessionFile = rec.sessionFile;
		entry.cwd = cwd;
		// Track working time
		let workedMs: number | undefined;
		if (state === "working" && previous !== "working") {
			entry.workingSince = Date.now();
		} else if (state !== "working" && previous === "working" && entry.workingSince) {
			workedMs = Date.now() - entry.workingSince;
			entry.workingSince = undefined;
		}

		entry.state = state;
		if (moved) this.save();
		this.changed.fire();
		if (previous !== state) {
			const change: StateChange = { sessionFile: rec.sessionFile, terminal: entry.terminal, previous, state };
			if (workedMs !== undefined) change.workedMs = workedMs;
			this.stateChanged.fire(change);
		}
	}

	private onClose(terminal: vscode.Terminal): void {
		this.pids.delete(terminal);
		const entry = this.tracked.find((t) => t.terminal === terminal);
		if (!entry || terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) return;
		this.pendingClose.set(
			terminal,
			setTimeout(() => {
				this.pendingClose.delete(terminal);
				this.untrack(entry);
			}, CLOSE_GRACE_MS),
		);
	}

	private untrack(entry: Tracked): void {
		this.tracked = this.tracked.filter((t) => t !== entry);
		fs.rmSync(path.join(terminalMapDir(), `${entry.key}.json`), { force: true });
		if (entry.sessionFile) this.releasedSession.fire({ sessionFile: entry.sessionFile, terminalKey: entry.key, pid: entry.pid });
		this.save();
		this.changed.fire();
	}

	private save(): void {
		if (this.restoring) return;
		const list: SavedSession[] = [];
		for (const t of this.tracked) if (t.sessionFile) list.push({ sessionFile: t.sessionFile, cwd: t.cwd });
		// Sessions still awaiting the restore prompt go after the open ones.
		const saved = new Set(list.map((s) => normPath(s.sessionFile)));
		for (const s of this.pendingRestore) {
			const file = normPath(s.sessionFile);
			if (!saved.has(file)) {
				list.push(s);
				saved.add(file);
			}
		}
		void this.ctx.workspaceState.update(STATE_KEY, list);
	}

	dispose(): void {
		// Pending removals are dropped on purpose: disposal means the window is going away.
		for (const timer of this.pendingClose.values()) clearTimeout(timer);
		this.pendingClose.clear();
		for (const timer of this.reportTimers) clearTimeout(timer);
		this.reportTimers.clear();
		this.watcher?.close();
		for (const d of this.disposables) d.dispose();
		this.changed.dispose();
		this.stateChanged.dispose();
		this.revealed.dispose();
		this.restoredTerminal.dispose();
		this.releasedSession.dispose();
		this.log.dispose();
	}
}