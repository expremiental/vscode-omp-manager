import * as vscode from "vscode";
import { normPath } from "./config";
import type { RestoredTerminal, RevealSession, StateChange, TerminalTracker } from "./tracker";

const STATE_KEY = "omp.unreadCompletions";

/** Snapshot of the selected editor and terminal. Tab and group objects have live getters. */
interface Focus {
	focused: boolean;
	group: vscode.TabGroup | undefined;
	tab: vscode.Tab | undefined;
	groupActive: boolean;
	tabActive: boolean;
	isTerminal: boolean;
	terminal: vscode.Terminal | undefined;
}

interface PendingEntry extends Focus {
	departingTerminal: vscode.Terminal | undefined;
}

interface TerminalEdge {
	terminal: vscode.Terminal;
	previousTerminal: vscode.Terminal | undefined;
	from: Focus;
}

interface PendingReveal {
	file: string;
	terminal: vscode.Terminal;
	previousGroup?: vscode.TabGroup;
	previousTab?: vscode.Tab;
	entry: Focus | undefined;
	explicitOpen: Focus | undefined;
}

/** Host-owned completion history; it does not depend on the sidebar's lifetime. */
export class SessionAttention implements vscode.Disposable {
	private readonly unread = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private started = false;
	private wasRestoring = false;
	private observedFocus: Focus | undefined;
	private lastTerminal: vscode.Terminal | undefined;
	private viewed: Focus | undefined;
	private pendingEntry: PendingEntry | undefined;
	private terminalEdge: TerminalEdge | undefined;
	private ambiguousEntry = false;
	private pendingReveal: PendingReveal | undefined;
	private panelIntent: vscode.Terminal | undefined;
	private readonly editorTerminals = new WeakMap<vscode.Tab, vscode.Terminal>();
	private readonly automaticFocus = new WeakMap<vscode.Terminal, vscode.Tab | undefined>();
	private readonly automaticFocusRegistered = new WeakSet<vscode.Terminal>();

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly tracker: TerminalTracker,
	) {
		const saved = ctx.workspaceState.get<unknown>(STATE_KEY);
		if (Array.isArray(saved)) {
			for (const file of saved) if (typeof file === "string" && file) this.unread.add(normPath(file));
		}
		this.resetFocus();
		this.disposables.push(
			tracker.onDidChangeState((change) => this.onState(change)),
			tracker.onDidRevealSession((change) => this.onReveal(change)),
			tracker.onDidRestoreTerminal((change) => this.registerAutomatic(change)),
			tracker.onDidChange(() => {
				if (!this.started || tracker.restoring || this.wasRestoring) this.resetFocus();
				this.wasRestoring = tracker.restoring;
			}),
			vscode.window.onDidChangeActiveTerminal((terminal) => this.observeFocus("terminal", terminal)),
			vscode.window.onDidCloseTerminal((terminal) => this.onClose(terminal)),
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				for (const tab of event.closed) {
					this.editorTerminals.delete(tab);
					if (this.pendingEntry?.tab === tab) {
						this.pendingEntry = undefined;
						this.terminalEdge = undefined;
						this.ambiguousEntry = true;
					}
					if (this.pendingReveal?.entry?.tab === tab || this.pendingReveal?.explicitOpen?.tab === tab) this.pendingReveal = undefined;
					if (this.viewed?.tab === tab) this.viewed = undefined;
				}
				this.observeFocus("tabs");
			}),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.observeFocus("tabs")),
			vscode.window.onDidChangeWindowState(() => this.observeFocus("window")),
		);
	}

	/** Call after tracker.start(): startup adoption and restoration are not viewing. */
	start(): void {
		this.started = true;
		this.resetFocus();
	}

	isUnread(file: string): boolean {
		return this.unread.has(normPath(file));
	}

	forget(file: string): void {
		if (this.unread.delete(normPath(file))) this.save();
	}

	private save(): void {
		void this.ctx.workspaceState.update(STATE_KEY, [...this.unread]);
		this.changed.fire();
	}

	private onState({ sessionFile, terminal, previous, state }: StateChange): void {
		if (previous !== "working" || state !== "idle") return;
		const file = normPath(sessionFile);
		// An unresolved entry is not a view, including completion between its two events.
		if (this.started && !this.tracker.restoring && this.viewed?.terminal === terminal && this.validPair(this.viewed, this.focus())) {
			this.forget(file);
			return;
		}
		if (!this.unread.has(file)) {
			this.unread.add(file);
			this.save();
		}
	}

	private onReveal({ sessionFile, terminal, location, previousGroup, previousTab, previousTerminal }: RevealSession): void {
		this.pendingReveal = undefined;
		this.pendingEntry = undefined;
		this.terminalEdge = undefined;
		this.viewed = undefined;
		this.ambiguousEntry = false;
		this.panelIntent = location === "panel" ? terminal : undefined;
		if (location === "panel") return;
		const file = normPath(sessionFile);
		if (this.tracker.openSessions().get(file)?.terminal !== terminal) return;
		// Intent identifies the process, not its editor. show() can select the process first.
		const focus = this.focus();
		const known = this.knownTerminal(focus.tab);
		const explicitOpen =
			previousTerminal === terminal && focus.terminal === terminal && focus.group === previousGroup && focus.tab === previousTab && this.isEditor(focus) && (!known || known === terminal)
				? focus
				: undefined;
		this.pendingReveal = { file, terminal, previousGroup, previousTab, entry: undefined, explicitOpen };
		this.trackRevealSelection(focus);
		this.acknowledgeReveal(focus);
	}

	private trackRevealSelection(focus: Focus): void {
		const pending = this.pendingReveal;
		if (!pending) return;
		if (this.tracker.openSessions().get(pending.file)?.terminal !== pending.terminal) {
			this.pendingReveal = undefined;
			return;
		}
		if (pending.explicitOpen && (!this.sameSelection(pending.explicitOpen, focus) || focus.terminal !== pending.terminal)) pending.explicitOpen = undefined;
		if (pending.entry) {
			if (!this.sameSelection(pending.entry, focus)) this.pendingReveal = undefined;
		} else if (focus.group !== pending.previousGroup || focus.tab !== pending.previousTab) {
			if (this.isEditor(focus)) pending.entry = focus;
			else this.pendingReveal = undefined;
		}
	}

	private acknowledgeReveal(focus: Focus): boolean {
		const pending = this.pendingReveal;
		if (!this.started || this.tracker.restoring || !pending || focus.terminal !== pending.terminal) return false;
		const known = this.knownTerminal(focus.tab);
		if (known && known !== pending.terminal) return false;
		if (!pending.entry && known !== pending.terminal) {
			if (!pending.explicitOpen || !this.validPair(pending.explicitOpen, focus) || !this.validPair(pending.explicitOpen, this.focus())) return false;
			// An explicit click acknowledges this completion, not an unproven tab identity.
			this.pendingReveal = undefined;
			this.automaticFocus.delete(pending.terminal);
			this.forget(pending.file);
			return true;
		}
		if (!this.acknowledge(focus, pending.terminal)) return false;
		this.pendingReveal = undefined;
		return true;
	}

	private focus(): Focus {
		const group = vscode.window.tabGroups.activeTabGroup;
		const tab = group?.activeTab;
		// Tab and group objects have live getters; observations must snapshot their flags.
		return {
			focused: vscode.window.state.focused,
			group,
			tab,
			groupActive: !!group?.isActive,
			tabActive: !!tab?.isActive,
			isTerminal: tab?.input instanceof vscode.TabInputTerminal,
			terminal: vscode.window.activeTerminal,
		};
	}

	private knownTerminal(tab: vscode.Tab | undefined): vscode.Terminal | undefined {
		return tab ? this.editorTerminals.get(tab) : undefined;
	}

	/** Selection only: never acknowledges completion or guesses an unassociated tab. */
	selectedEditorTerminal(): vscode.Terminal | undefined {
		const focus = this.focus();
		if (!this.isEditor(focus)) return undefined;
		const terminal = this.knownTerminal(focus.tab);
		return terminal && terminal === focus.terminal ? terminal : undefined;
	}

	private sameSelection(a: Focus | undefined, b: Focus | undefined): boolean {
		return !!a && !!b && a.group === b.group && a.tab === b.tab && a.groupActive === b.groupActive && a.tabActive === b.tabActive && a.isTerminal === b.isTerminal;
	}

	private isEditor(focus: Focus): boolean {
		return focus.groupActive && focus.tabActive && focus.isTerminal;
	}

	private validPair(pair: Focus, focus: Focus): boolean {
		return focus.focused && this.isEditor(focus) && this.sameSelection(pair, focus) && pair.terminal === focus.terminal;
	}

	private registerAutomatic({ terminal, previousTab }: RestoredTerminal): void {
		if (this.automaticFocusRegistered.has(terminal)) return;
		this.automaticFocusRegistered.add(terminal);
		this.automaticFocus.set(terminal, previousTab);
		this.resetFocus();
	}

	private consumeAutomatic(focus: Focus): boolean {
		const terminal = focus.terminal;
		if (!terminal || !this.isEditor(focus) || !this.automaticFocus.has(terminal)) return false;
		// The process-first half still points at the pre-restore tab; keep its suppression.
		if (focus.tab !== this.automaticFocus.get(terminal)) this.automaticFocus.delete(terminal);
		this.viewed = undefined;
		this.pendingEntry = undefined;
		this.terminalEdge = undefined;
		return true;
	}

	private resetFocus(): void {
		this.observedFocus = this.focus();
		this.lastTerminal = this.observedFocus.terminal;
		this.viewed = undefined;
		this.pendingEntry = undefined;
		this.terminalEdge = undefined;
		this.pendingReveal = undefined;
		this.panelIntent = undefined;
		this.ambiguousEntry = false;
		this.consumeAutomatic(this.observedFocus);
	}

	private acknowledge(focus: Focus, terminal: vscode.Terminal | undefined): boolean {
		const pair = { ...focus, terminal };
		// Recheck the actual selected editor immediately before changing unread history.
		if (!this.started || this.tracker.restoring || !terminal || !this.validPair(pair, this.focus())) return false;
		// validPair() proved an active terminal editor tab.
		this.editorTerminals.set(focus.tab!, terminal);
		this.pendingEntry = undefined;
		this.terminalEdge = undefined;
		this.ambiguousEntry = false;
		this.automaticFocus.delete(terminal);
		this.viewed = pair;
		for (const [file, live] of this.tracker.openSessions()) if (live.terminal === terminal) this.forget(file);
		return true;
	}

	private observeFocus(kind: "terminal" | "tabs" | "window" | "close", terminal?: vscode.Terminal): void {
		const focus = this.focus();
		const previous = this.observedFocus;
		const previousTerminal = this.lastTerminal;
		const terminalChanged = kind === "terminal" && terminal !== previousTerminal;
		if (kind === "terminal") this.lastTerminal = terminal;
		this.observedFocus = focus;
		if (!this.started || this.tracker.restoring) {
			this.resetFocus();
			return;
		}
		if (kind === "terminal" && this.pendingReveal?.explicitOpen && terminal !== this.pendingReveal.terminal) this.pendingReveal.explicitOpen = undefined;
		this.trackRevealSelection(focus);
		if (!focus.focused) {
			// Native event halves cannot cross a blur. A known-target owner-window reveal can.
			this.viewed = undefined;
			this.pendingEntry = undefined;
			this.terminalEdge = undefined;
			this.ambiguousEntry = false;
			return;
		}
		if (this.acknowledgeReveal(focus)) return;
		if (this.consumeAutomatic(focus)) return;
		const selectionChanged = !this.sameSelection(previous, focus);
		const returned = !previous?.focused;
		let edge: TerminalEdge | undefined;
		if (selectionChanged || returned) {
			this.viewed = undefined;
			edge = this.terminalEdge;
			this.terminalEdge = undefined;
			const superseded = !!this.pendingEntry;
			this.pendingEntry = undefined;
			if (!this.isEditor(focus)) {
				this.ambiguousEntry = false;
				return;
			}
			const known = this.knownTerminal(focus.tab);
			if (known && focus.terminal === known && this.acknowledge(focus, known)) return;
			if (returned) return;
			// An unchanged, unassociated file→terminal selection is not identity evidence.
			this.ambiguousEntry ||= superseded || (!previous?.isTerminal && !known && !terminalChanged && !(edge && this.sameSelection(edge.from, previous)));
			this.pendingEntry = { ...focus, departingTerminal: edge && this.sameSelection(edge.from, previous) ? edge.previousTerminal : previous?.terminal };
			// Terminal-first A→B: consume only an edge captured against the departing selection.
			if (!this.ambiguousEntry && edge && this.sameSelection(edge.from, previous) && edge.terminal === focus.terminal && (!known || known === edge.terminal) && this.acknowledge(focus, edge.terminal))
				return;
		}
		if (!terminalChanged) return;
		this.viewed = undefined;
		if (this.panelIntent === terminal) {
			this.panelIntent = undefined;
			this.pendingEntry = undefined;
			this.terminalEdge = undefined;
			this.ambiguousEntry = true;
			return;
		}
		const pending = this.pendingEntry;
		if (pending && this.sameSelection(pending, focus)) {
			const known = this.knownTerminal(focus.tab);
			// Tab-first A→B: the old activeTerminal A sampled at the tab edge is never read.
			if (!this.ambiguousEntry && terminal && terminal === focus.terminal && terminal !== pending.departingTerminal && (!known || known === terminal) && this.acknowledge(focus, terminal))
				return;
			this.ambiguousEntry = true;
			this.terminalEdge = undefined;
			return;
		}
		// A terminal-only edge can come from the panel. It never acknowledges the old editor.
		if (this.terminalEdge) this.ambiguousEntry = true;
		this.terminalEdge = !this.ambiguousEntry && terminal && terminal === focus.terminal ? { terminal, previousTerminal, from: focus } : undefined;
	}

	private onClose(terminal: vscode.Terminal): void {
		this.automaticFocus.delete(terminal);
		if (this.viewed?.terminal === terminal) this.viewed = undefined;
		if (this.pendingReveal?.terminal === terminal) this.pendingReveal = undefined;
		if (this.panelIntent === terminal) this.panelIntent = undefined;
		if (this.pendingEntry || this.terminalEdge) {
			this.pendingEntry = undefined;
			this.terminalEdge = undefined;
			this.ambiguousEntry = true;
		}
		this.observeFocus("close");
	}

	dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
		this.changed.dispose();
	}
}
