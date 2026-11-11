"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const attention_1 = require("./attention");
const sessions_1 = require("./sessions");
const systemNotify_1 = require("./systemNotify");
const tracker_1 = require("./tracker");
const usage_1 = require("./usage");
const usageMonitor_1 = require("./usageMonitor");
const views_1 = require("./views");
const windows_1 = require("./windows");
const { SessionPins } = require("./pins");
function sessionFileOf(arg) {
    return typeof arg?.file === "string" ? arg.file : undefined;
}
function sessionTargetOf(arg) {
    return {
        ownerId: typeof arg?.ownerId === "string" ? arg.ownerId : undefined,
        terminalKey: typeof arg?.terminalKey === "string" ? arg.terminalKey : undefined,
    };
}
async function activate(context) {
    const index = new sessions_1.SessionIndex();
    const usage = new usage_1.UsageService();
    const tracker = new tracker_1.TerminalTracker(context, context.asAbsolutePath("hook/vscode-session-restore.ts"));
    const attention = new attention_1.SessionAttention(context, tracker);
    const windows = new windows_1.WindowSessions(context, tracker, attention, index);
    const pins = new SessionPins();
    tracker.sessionRouter = (opts) => windows.route(opts);
    tracker.restoreGuard = (file) => windows.canRestore(file);
    tracker.launchGuard = (file) => windows.reserveLaunch(file);
    tracker.launchSettled = (file, token, registered, failedBeforeCreation, terminalKey) => windows.releaseLaunch(file, token, registered, failedBeforeCreation, terminalKey);
    const openSession = async (opts) => {
        try {
            await tracker.open(opts);
        }
        catch (err) {
            void vscode.window.showWarningMessage(err.message ?? String(err));
        }
    };
    const newSession = async () => {
        const config = vscode.workspace.getConfiguration("omp");
        const mode = config.get("newSessionCwd", "workspaceRoot");
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (mode === "ask") {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                defaultUri: folders[0]?.uri,
                openLabel: "Start omp here",
            });
            if (picked?.[0])
                await tracker.open({ cwd: picked[0].fsPath });
            return;
        }
        const doc = vscode.window.activeTextEditor?.document;
        if (mode === "activeFileFolder" && doc?.uri.scheme === "file") {
            await tracker.open({ cwd: path.dirname(doc.uri.fsPath) });
            return;
        }
        if (folders.length <= 1) {
            await tracker.open({ cwd: folders[0]?.uri.fsPath });
            return;
        }
        const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Start omp in which folder?" });
        if (picked)
            await tracker.open({ cwd: picked.uri.fsPath });
    };
    const openIn = (location) => (arg) => {
        const file = sessionFileOf(arg);
        if (arg?.sessionMissing) {
            void vscode.window.showWarningMessage("Файл закреплённой сессии недоступен.");
            return;
        }
        if (file)
            return openSession({ sessionFile: file, cwd: index.find(file)?.cwd, location, ...sessionTargetOf(arg) });
    };
    // A session that stops working in a terminal you are not looking at gets a notification.
    // `activeTerminal` outlives focus moving to a file: the selected editor group must
    // contain a terminal tab. A panel terminal has no editor tab and does not count.
    // A question also notifies from idle: omp ends the turn before opening a plan review.
    const notify = ({ sessionFile, terminal, previous, state, workedMs }) => {
        if (previous === undefined || (state !== "idle" && state !== "waiting") || (state === "idle" && previous !== "working"))
            return;
        const config = vscode.workspace.getConfiguration("omp");
        if (state === "waiting" ? !config.get("notify.onInput", true) : !config.get("notify.onFinish", true))
            return;
        // Questions always notify; a quick reply finishing does not.
        const minMs = Math.max(0, config.get("notify.minWorkSeconds", 10)) * 1000;
        if (state === "idle" && workedMs !== undefined && workedMs < minMs)
            return;
        const focused = vscode.window.state.focused;
        const terminalTabShown = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal;
        if (focused && vscode.window.activeTerminal === terminal && terminalTabShown)
            return;
        const title = index.find(sessionFile)?.title ?? "omp session";
        const text = state === "waiting" ? `"${title}" needs input` : `"${title}" finished`;
        const target = sessionTargetOf(windows.sessions().get(windows.identity(sessionFile)));
        const showInVsCode = () => void vscode.window.showInformationMessage(text, "Show").then((choice) => {
            if (choice)
                void openSession({ sessionFile, cwd: index.find(sessionFile)?.cwd, ...target });
        });
        const style = config.get("notify.style", "vscode");
        // A system notification is for when VS Code is in the background; a focused window gets its own.
        if (style === "vscode" || focused) {
            showInVsCode();
            return;
        }
        if (style === "both")
            showInVsCode();
        void (0, systemNotify_1.systemNotify)(vscode.env.appName, state === "waiting" ? "omp needs input" : "omp finished", title).then((shown) => {
            if (!shown && style === "system")
                showInVsCode();
        });
    };
    // Every window uses the same file ordering, so cross-window traversal wraps consistently.
    const focusNextWaiting = async () => {
        let activeFile;
        for (const [file, session] of tracker.openSessions()) {
            if (session.terminal === vscode.window.activeTerminal) {
                activeFile = windows.identity(file);
                break;
            }
        }
        const open = [...windows.sessions()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const active = open.findIndex(([file]) => file === activeFile);
        const next = open.find(([, s], i) => i > active && s.state === "waiting") ?? open.find(([, s]) => s.state === "waiting");
        if (next)
            await openSession({ sessionFile: next[1].file, cwd: next[1].cwd || index.find(next[1].file)?.cwd, ...sessionTargetOf(next[1]) });
        else
            void vscode.window.showInformationMessage("No omp session needs input.");
    };
    const view = new views_1.OmpViewProvider(index, tracker, usage, (cwd) => void (cwd ? tracker.open({ cwd }) : newSession()), attention, windows, pins);
    const setPinned = (pinned) => (arg) => {
        try {
            if (!pinned && typeof arg?.id === "string") {
                pins.unpin(arg.id);
                return;
            }
            const file = sessionFileOf(arg);
            const session = file && (index.find(file) ?? sessions_1.parseSession(file, fs.statSync(file).mtimeMs));
            if (!session) throw new Error("Session metadata is not available yet. Refresh and try again.");
            pins.pin(session);
        } catch (error) {
            void vscode.window.showWarningMessage("Cannot update pinned session: " + error.message);
        }
    };
    context.subscriptions.push(index, usage, windows, tracker, attention, pins, view, new usageMonitor_1.UsageMonitor(usage, context.globalState), tracker.onDidChangeState(notify), vscode.commands.registerCommand("omp.session.pin", setPinned(true)), vscode.commands.registerCommand("omp.session.unpin", setPinned(false)), vscode.commands.registerCommand("omp.focusNextWaiting", focusNextWaiting), vscode.window.registerWebviewViewProvider("omp.main", view), vscode.commands.registerCommand("omp.newSession", newSession), 
    // The same command with the colored π icon, for the editor tab bar.
    vscode.commands.registerCommand("omp.newSessionFromEditorTitle", newSession), vscode.commands.registerCommand("omp.refresh", () => {
        pins.refresh();
        view.refreshSessions(true);
        return usage.refresh();
    }), vscode.commands.registerCommand("omp.resumeSession", async () => {
        const sortByCreated = vscode.workspace.getConfiguration("omp").get("sessions.sortBy") === "created";
        // The picker opens at once and shows a busy bar until the first scan finishes.
        const picked = await vscode.window.showQuickPick(index.ensure().then(() => {
            const open = windows.sessions();
            return (0, views_1.workspaceSessions)(index).map((s) => ({
                label: s.title,
                description: new Date(sortByCreated ? s.created : s.modified).toLocaleString(),
                detail: s.cwd,
                session: s,
                target: sessionTargetOf(open.get(windows.identity(s.file))),
            }));
        }), { placeHolder: "Resume an omp session", matchOnDetail: true });
        if (picked)
            await openSession({ sessionFile: picked.session.file, cwd: picked.session.cwd, ...picked.target });
    }), vscode.commands.registerCommand("omp.session.openInEditor", openIn("editor")), vscode.commands.registerCommand("omp.session.openInPanel", openIn("panel")), vscode.commands.registerCommand("omp.session.copyId", (arg) => {
        if (typeof arg?.id === "string")
            return vscode.env.clipboard.writeText(arg.id);
    }), vscode.commands.registerCommand("omp.session.copyPath", (arg) => {
        const file = sessionFileOf(arg);
        if (file)
            return vscode.env.clipboard.writeText(file);
    }), vscode.commands.registerCommand("omp.session.reveal", (arg) => {
        const file = sessionFileOf(arg);
        if (file)
            return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
    }), vscode.commands.registerCommand("omp.session.delete", async (arg) => {
        if (arg?.sessionMissing) {
            void vscode.window.showWarningMessage("Use Unpin Session to remove this unavailable bookmark.");
            return;
        }
        const file = sessionFileOf(arg);
        if (!file)
            return;
        const canDelete = async () => {
            try {
                const ownership = await windows.resolve(file, sessionTargetOf(arg));
                if (ownership.kind === "closed")
                    return true;
                void vscode.window.showWarningMessage(ownership.kind === "unavailable"
                    ? ownership.reason ?? "Не удалось подтвердить, что сессия закрыта во всех окнах. Удаление отменено."
                    : "Сначала закройте терминал этой сессии в её окне VS Code.");
            }
            catch (err) {
                void vscode.window.showWarningMessage(err.message ?? String(err));
            }
            return false;
        };
        if (!await canDelete())
            return;
        const title = index.find(file)?.title ?? file;
        const deletedId = index.find(file)?.id ?? sessions_1.parseSession(file, fs.statSync(file).mtimeMs)?.id;
        const ok = await vscode.window.showWarningMessage(`Delete "${title}"?`, { modal: true, detail: "The session file and its subagent transcripts move to the trash." }, "Delete");
        if (ok !== "Delete")
            return;
        // The owner may have opened the session while the confirmation was visible.
        if (!await canDelete())
            return;
        // Subagent transcripts live in a sibling directory named like the file without `.jsonl`.
        const dir = file.replace(/\.jsonl$/, "");
        for (const target of [file, dir]) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
            }
            catch (err) {
                if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound"))
                    throw err;
            }
        }
        attention.forget(file);
        if (deletedId) pins.unpin(deletedId);
    }));
    await windows.start();
    await tracker.start();
    attention.start();
    if (vscode.workspace.getConfiguration("omp").get("focusOnStartup", true)) {
        void vscode.commands.executeCommand("workbench.view.extension.omp");
    }
}
