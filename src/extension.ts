import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionAttention } from "./attention";
import { SessionPins } from "./pins";
import { claudeEnabled, claudeProjectsDir } from "./config";
import { claudeHookPath, claudeHooksSnippet, installClaudeHook } from "./claudeHook";
import { type AgentKind, SessionIndex, SessionIndexes, type SessionInfo, parseAnySession } from "./sessions";
import { systemNotify } from "./systemNotify";
import { type LaunchOptions, type StateChange, TerminalTracker } from "./tracker";
import { UsageService } from "./usage";
import { UsageMonitor } from "./usageMonitor";
import { OmpViewProvider, usageShown, workspaceSessions } from "./views";
import { type SessionTarget, WindowSessions } from "./windows";

/** What `data-vscode-context` on a session row passes to its context menu commands. */
interface SessionContext {
	file?: unknown;
	id?: unknown;
	ownerId?: unknown;
	terminalKey?: unknown;
	/** A pinned bookmark whose transcript file is gone. */
	sessionMissing?: unknown;
}

function sessionFileOf(arg: SessionContext | undefined): string | undefined {
	return typeof arg?.file === "string" ? arg.file : undefined;
}

/** The exact owner window and terminal a row or notification was captured from. */
function sessionTargetOf(arg: { ownerId?: unknown; terminalKey?: unknown } | undefined): SessionTarget {
	return {
		ownerId: typeof arg?.ownerId === "string" ? arg.ownerId : undefined,
		terminalKey: typeof arg?.terminalKey === "string" ? arg.terminalKey : undefined,
	};
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Claude Code sessions join omp's when enabled; the setting applies on the next window load.
	const claude = claudeEnabled();
	const index = new SessionIndexes([
		new SessionIndex(),
		...(claude ? [new SessionIndex({ root: claudeProjectsDir(), agent: "claude" })] : []),
	]);
	const usage = new UsageService();
	const tracker = new TerminalTracker(context, context.asAbsolutePath("hook/vscode-session-restore.ts"), claudeHookPath());
	if (claude) installClaudeHook(context, tracker.log);
	const attention = new SessionAttention(context, tracker);
	const windows = new WindowSessions(context, tracker, attention, index);
	const pins = new SessionPins();
	tracker.sessionRouter = (opts) => windows.route(opts);
	tracker.restoreGuard = (file) => windows.canRestore(file);
	tracker.launchGuard = (file) => windows.reserveLaunch(file);
	tracker.launchSettled = (file, token, registered, failedBeforeCreation, terminalKey) =>
		windows.releaseLaunch(file, token, registered, failedBeforeCreation, terminalKey);
	// Routing refuses rather than launching a duplicate; surface why.
	const openSession = async (opts: LaunchOptions) => {
		try {
			await tracker.open(opts);
		} catch (err) {
			void vscode.window.showWarningMessage((err as Error).message ?? String(err));
		}
	};

	const newSession = async (agent: AgentKind = "omp") => {
		const config = vscode.workspace.getConfiguration("omp");
		const mode = config.get<string>("newSessionCwd", "workspaceRoot");
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (mode === "ask") {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				defaultUri: folders[0]?.uri,
				openLabel: agent === "claude" ? "Start Claude Code here" : "Start omp here",
			});
			if (picked?.[0]) await tracker.open({ cwd: picked[0].fsPath, agent });
			return;
		}
		const doc = vscode.window.activeTextEditor?.document;
		if (mode === "activeFileFolder" && doc?.uri.scheme === "file") {
			await tracker.open({ cwd: path.dirname(doc.uri.fsPath), agent });
			return;
		}
		if (folders.length <= 1) {
			await tracker.open({ cwd: folders[0]?.uri.fsPath, agent });
			return;
		}
		const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: agent === "claude" ? "Start Claude Code in which folder?" : "Start omp in which folder?" });
		if (picked) await tracker.open({ cwd: picked.uri.fsPath, agent });
	};

	const openIn = (location: "editor" | "panel") => (arg: SessionContext | undefined) => {
		const file = sessionFileOf(arg);
		if (arg?.sessionMissing) {
			void vscode.window.showWarningMessage("Файл закреплённой сессии недоступен.");
			return;
		}
		if (file) return openSession({ sessionFile: file, cwd: index.find(file)?.cwd, location, ...sessionTargetOf(arg) });
	};

	// A session that stops working in a terminal you are not looking at gets a notification.
	// `activeTerminal` outlives focus moving to a file: the selected editor group must
	// contain a terminal tab. A panel terminal has no editor tab and does not count.
	// A question also notifies from idle: omp ends the turn before opening a plan review.
	const notify = ({ sessionFile, terminal, previous, state, workedMs }: StateChange) => {
		if (previous === undefined || (state !== "idle" && state !== "waiting") || (state === "idle" && previous !== "working")) return;
		const config = vscode.workspace.getConfiguration("omp");
		if (state === "waiting" ? !config.get<boolean>("notify.onInput", true) : !config.get<boolean>("notify.onFinish", true)) return;
		// Questions always notify; a quick reply finishing does not.
		const minMs = Math.max(0, config.get<number>("notify.minWorkSeconds", 10)) * 1000;
		if (state === "idle" && workedMs !== undefined && workedMs < minMs) return;
		const focused = vscode.window.state.focused;
		const terminalTabShown = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal;
		if (focused && vscode.window.activeTerminal === terminal && terminalTabShown) return;

		const info = index.find(sessionFile);
		const name = info?.agent === "claude" ? "Claude Code" : "omp";
		const title = info?.title ?? `${name} session`;
		const text = state === "waiting" ? `"${title}" needs input` : `"${title}" finished`;
		const target = sessionTargetOf(windows.sessions().get(windows.identity(sessionFile)));
		const showInVsCode = () =>
			void vscode.window.showInformationMessage(text, "Show").then((choice) => {
				if (choice) void openSession({ sessionFile, cwd: index.find(sessionFile)?.cwd, ...target });
			});
		const style = config.get<string>("notify.style", "vscode");
		// A system notification is for when VS Code is in the background; a focused window gets its own.
		if (style === "vscode" || focused) {
			showInVsCode();
			return;
		}
		if (style === "both") showInVsCode();
		void systemNotify(vscode.env.appName, state === "waiting" ? `${name} needs input` : `${name} finished`, title).then((shown) => {
			if (!shown && style === "system") showInVsCode();
		});
	};

	// Every window uses the same file ordering, so cross-window traversal wraps consistently.
	const focusNextWaiting = async () => {
		let activeFile: string | undefined;
		for (const [file, session] of tracker.openSessions()) {
			if (session.terminal === vscode.window.activeTerminal) {
				activeFile = windows.identity(file);
				break;
			}
		}
		const open = [...windows.sessions()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const active = open.findIndex(([file]) => file === activeFile);
		const next = open.find(([, s], i) => i > active && s.state === "waiting") ?? open.find(([, s]) => s.state === "waiting");
		if (next) await openSession({ sessionFile: next[1].file, cwd: next[1].cwd || index.find(next[1].file)?.cwd, ...sessionTargetOf(next[1]) });
		else void vscode.window.showInformationMessage("No omp session needs input.");
	};

	const view = new OmpViewProvider(index, tracker, usage, (cwd) => void (cwd ? tracker.open({ cwd }) : newSession()), attention, windows, pins);

	const setPinned = (pinned: boolean) => (arg: SessionContext | undefined) => {
		try {
			if (!pinned && typeof arg?.id === "string") {
				pins.unpin(arg.id);
				return;
			}
			const file = sessionFileOf(arg);
			const session = file && (index.find(file) ?? parseAnySession(file, fs.statSync(file).mtimeMs));
			if (!session) throw new Error("Session metadata is not available yet. Refresh and try again.");
			pins.pin(session);
		} catch (error) {
			void vscode.window.showWarningMessage(`Cannot update pinned session: ${(error as Error).message}`);
		}
	};

	context.subscriptions.push(
		index,
		usage,
		windows,
		tracker,
		attention,
		pins,
		view,
		new UsageMonitor(usage, context.globalState),
		tracker.onDidChangeState(notify),
		vscode.commands.registerCommand("omp.session.pin", setPinned(true)),
		vscode.commands.registerCommand("omp.session.unpin", setPinned(false)),
		vscode.commands.registerCommand("omp.focusNextWaiting", focusNextWaiting),
		vscode.window.registerWebviewViewProvider("omp.main", view),
		vscode.commands.registerCommand("omp.newSession", () => newSession()),
		vscode.commands.registerCommand("omp.newClaudeSession", () => newSession("claude")),
		vscode.commands.registerCommand("omp.copyClaudeHooks", async () => {
			await vscode.env.clipboard.writeText(claudeHooksSnippet());
			void vscode.window.showInformationMessage("Hooks JSON copied. Merge it into the \"hooks\" of ~/.claude/settings.json.");
		}),
		// The same command with the colored π icon, for the editor tab bar.
		vscode.commands.registerCommand("omp.newSessionFromEditorTitle", () => newSession()),
		vscode.commands.registerCommand("omp.refresh", () => {
			pins.refresh();
			view.refreshSessions(true);
			if (usageShown()) return usage.refresh();
		}),
		vscode.commands.registerCommand("omp.resumeSession", async () => {
			const sortByCreated = vscode.workspace.getConfiguration("omp").get<string>("sessions.sortBy") === "created";
			// The picker opens at once and shows a busy bar until the first scan finishes.
			const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { session: SessionInfo; target: SessionTarget }>(
				index.ensure().then(() => {
					const open = windows.sessions();
					return workspaceSessions(index).map((s) => ({
						label: s.title,
						description: new Date(sortByCreated ? s.created : s.modified).toLocaleString(),
						detail: s.cwd,
						session: s,
						target: sessionTargetOf(open.get(windows.identity(s.file))),
					}));
				}),
				{ placeHolder: "Resume an omp session", matchOnDetail: true },
			);
			if (picked) await openSession({ sessionFile: picked.session.file, cwd: picked.session.cwd, ...picked.target });
		}),
		vscode.commands.registerCommand("omp.session.openInEditor", openIn("editor")),
		vscode.commands.registerCommand("omp.session.openInPanel", openIn("panel")),
		vscode.commands.registerCommand("omp.session.copyId", (arg?: SessionContext) => {
			if (typeof arg?.id === "string") return vscode.env.clipboard.writeText(arg.id);
		}),
		vscode.commands.registerCommand("omp.session.copyPath", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.env.clipboard.writeText(file);
		}),
		vscode.commands.registerCommand("omp.session.reveal", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
		}),
		vscode.commands.registerCommand("omp.session.delete", async (arg?: SessionContext) => {
			if (arg?.sessionMissing) {
				void vscode.window.showWarningMessage("Use Unpin Session to remove this unavailable bookmark.");
				return;
			}
			const file = sessionFileOf(arg);
			if (!file) return;
			// Deleting requires proof that no window runs the session, not just this one.
			const canDelete = async () => {
				try {
					const ownership = await windows.resolve(file, sessionTargetOf(arg));
					if (ownership.kind === "closed") return true;
					void vscode.window.showWarningMessage(
						ownership.kind === "unavailable"
							? (ownership.reason ?? "Не удалось подтвердить, что сессия закрыта во всех окнах. Удаление отменено.")
							: "Сначала закройте терминал этой сессии в её окне VS Code.",
					);
				} catch (err) {
					void vscode.window.showWarningMessage((err as Error).message ?? String(err));
				}
				return false;
			};
			if (!(await canDelete())) return;
			const title = index.find(file)?.title ?? file;
			const deletedId = index.find(file)?.id ?? parseAnySession(file, fs.statSync(file).mtimeMs)?.id;
			const ok = await vscode.window.showWarningMessage(
				`Delete "${title}"?`,
				{ modal: true, detail: "The session file and its subagent transcripts move to the trash." },
				"Delete",
			);
			if (ok !== "Delete") return;
			// The owner may have opened the session while the confirmation was visible.
			if (!(await canDelete())) return;
			// Subagent transcripts live in a sibling directory named like the file without `.jsonl`.
			const dir = file.replace(/\.jsonl$/, "");
			for (const target of [file, dir]) {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
				} catch (err) {
					if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound")) throw err;
				}
			}
			attention.forget(file);
			if (deletedId) pins.unpin(deletedId);
		}),
	);

	await windows.start();
	await tracker.start();
	attention.start();

	if (vscode.workspace.getConfiguration("omp").get<boolean>("focusOnStartup", true)) {
		void vscode.commands.executeCommand("workbench.view.extension.omp");
	}
}
