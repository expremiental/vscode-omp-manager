"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionAttention = void 0;
const vscode = require("vscode");
const config_1 = require("./config");
const STATE_KEY = "omp.unreadCompletions";
/** Host-owned completion history; it does not depend on the sidebar's lifetime. */
class SessionAttention {
    ctx;
    tracker;
    unread = new Set();
    disposables = [];
    changed = new vscode.EventEmitter();
    onDidChange = this.changed.event;
    started = false;
    wasRestoring = false;
    observedFocus;
    lastTerminal;
    viewed;
    pendingEntry;
    terminalEdge;
    ambiguousEntry = false;
    pendingReveal;
    panelIntent;
    editorTerminals = new WeakMap();
    automaticFocus = new WeakMap();
    automaticFocusRegistered = new WeakSet();
    constructor(ctx, tracker) {
        this.ctx = ctx;
        this.tracker = tracker;
        const saved = ctx.workspaceState.get(STATE_KEY);
        if (Array.isArray(saved)) {
            for (const file of saved)
                if (typeof file === "string" && file)
                    this.unread.add((0, config_1.normPath)(file));
        }
        this.resetFocus();
        this.disposables.push(tracker.onDidChangeState((change) => this.onState(change)), tracker.onDidRevealSession((change) => this.onReveal(change)), tracker.onDidRestoreTerminal((change) => this.registerAutomatic(change)), tracker.onDidChange(() => {
            if (!this.started || tracker.restoring || this.wasRestoring)
                this.resetFocus();
            this.wasRestoring = tracker.restoring;
        }), vscode.window.onDidChangeActiveTerminal((terminal) => this.observeFocus("terminal", terminal)), vscode.window.onDidCloseTerminal((terminal) => this.onClose(terminal)), vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const tab of event.closed) {
                this.editorTerminals.delete(tab);
                if (this.pendingEntry?.tab === tab) {
                    this.pendingEntry = undefined;
                    this.terminalEdge = undefined;
                    this.ambiguousEntry = true;
                }
                if (this.pendingReveal?.entry?.tab === tab || this.pendingReveal?.explicitOpen?.tab === tab)
                    this.pendingReveal = undefined;
                if (this.viewed?.tab === tab)
                    this.viewed = undefined;
            }
            this.observeFocus("tabs");
        }), vscode.window.tabGroups.onDidChangeTabGroups(() => this.observeFocus("tabs")), vscode.window.onDidChangeWindowState(() => this.observeFocus("window")));
    }
    /** Call after tracker.start(): startup adoption and restoration are not viewing. */
    start() {
        this.started = true;
        this.resetFocus();
    }
    isUnread(file) {
        return this.unread.has((0, config_1.normPath)(file));
    }
    forget(file) {
        if (this.unread.delete((0, config_1.normPath)(file)))
            this.save();
    }
    save() {
        void this.ctx.workspaceState.update(STATE_KEY, [...this.unread]);
        this.changed.fire();
    }
    onState({ sessionFile, terminal, previous, state }) {
        if (previous !== "working" || state !== "idle")
            return;
        const file = (0, config_1.normPath)(sessionFile);
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
    onReveal({ sessionFile, terminal, location, previousGroup, previousTab, previousTerminal }) {
        this.pendingReveal = undefined;
        this.pendingEntry = undefined;
        this.terminalEdge = undefined;
        this.viewed = undefined;
        this.ambiguousEntry = false;
        this.panelIntent = location === "panel" ? terminal : undefined;
        if (location === "panel")
            return;
        const file = (0, config_1.normPath)(sessionFile);
        if (this.tracker.openSessions().get(file)?.terminal !== terminal)
            return;
        // Intent identifies the process, not its editor. show() can select the process first.
        const focus = this.focus();
        const known = this.editorTerminals.get(focus.tab);
        const explicitOpen = previousTerminal === terminal && focus.terminal === terminal && focus.group === previousGroup && focus.tab === previousTab && this.isEditor(focus) && (!known || known === terminal) ? focus : undefined;
        this.pendingReveal = { file, terminal, previousGroup, previousTab, entry: undefined, explicitOpen };
        this.trackRevealSelection(focus);
        this.acknowledgeReveal(focus);
    }
    trackRevealSelection(focus) {
        const pending = this.pendingReveal;
        if (!pending)
            return;
        if (this.tracker.openSessions().get(pending.file)?.terminal !== pending.terminal) {
            this.pendingReveal = undefined;
            return;
        }
        if (pending.explicitOpen && (!this.sameSelection(pending.explicitOpen, focus) || focus.terminal !== pending.terminal))
            pending.explicitOpen = undefined;
        if (pending.entry) {
            if (!this.sameSelection(pending.entry, focus))
                this.pendingReveal = undefined;
        }
        else if (focus.group !== pending.previousGroup || focus.tab !== pending.previousTab) {
            if (this.isEditor(focus))
                pending.entry = focus;
            else
                this.pendingReveal = undefined;
        }
    }
    acknowledgeReveal(focus) {
        const pending = this.pendingReveal;
        if (!this.started || this.tracker.restoring || !pending || focus.terminal !== pending.terminal)
            return false;
        const known = this.editorTerminals.get(focus.tab);
        if (known && known !== pending.terminal)
            return false;
        if (!pending.entry && known !== pending.terminal) {
            if (!pending.explicitOpen || !this.validPair(pending.explicitOpen, focus) || !this.validPair(pending.explicitOpen, this.focus()))
                return false;
            // An explicit click acknowledges this completion, not an unproven tab identity.
            this.pendingReveal = undefined;
            this.automaticFocus.delete(pending.terminal);
            this.forget(pending.file);
            return true;
        }
        if (!this.acknowledge(focus, pending.terminal))
            return false;
        this.pendingReveal = undefined;
        return true;
    }
    focus() {
        const group = vscode.window.tabGroups.activeTabGroup;
        const tab = group?.activeTab;
        // Tab and group objects have live getters; observations must snapshot their flags.
        return { focused: vscode.window.state.focused, group, tab, groupActive: !!group?.isActive, tabActive: !!tab?.isActive, isTerminal: tab?.input instanceof vscode.TabInputTerminal, terminal: vscode.window.activeTerminal };
    }
    /** Selection only: never acknowledges completion or guesses an unassociated tab. */
    selectedEditorTerminal() {
        const focus = this.focus();
        if (!this.isEditor(focus))
            return undefined;
        const terminal = this.editorTerminals.get(focus.tab);
        return terminal && terminal === focus.terminal ? terminal : undefined;
    }
    sameSelection(a, b) {
        return !!a && !!b && a.group === b.group && a.tab === b.tab && a.groupActive === b.groupActive && a.tabActive === b.tabActive && a.isTerminal === b.isTerminal;
    }
    isEditor(focus) {
        return focus.groupActive && focus.tabActive && focus.isTerminal;
    }
    validPair(pair, focus) {
        return focus.focused && this.isEditor(focus) && this.sameSelection(pair, focus) && pair.terminal === focus.terminal;
    }
    registerAutomatic({ terminal, previousTab }) {
        if (this.automaticFocusRegistered.has(terminal))
            return;
        this.automaticFocusRegistered.add(terminal);
        this.automaticFocus.set(terminal, previousTab);
        this.resetFocus();
    }
    consumeAutomatic(focus) {
        const terminal = focus.terminal;
        if (!terminal || !this.isEditor(focus) || !this.automaticFocus.has(terminal))
            return false;
        // The process-first half still points at the pre-restore tab; keep its suppression.
        if (focus.tab !== this.automaticFocus.get(terminal))
            this.automaticFocus.delete(terminal);
        this.viewed = undefined;
        this.pendingEntry = undefined;
        this.terminalEdge = undefined;
        return true;
    }
    resetFocus() {
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
    acknowledge(focus, terminal) {
        const pair = { ...focus, terminal };
        // Recheck the actual selected editor immediately before changing unread history.
        if (!this.started || this.tracker.restoring || !terminal || !this.validPair(pair, this.focus()))
            return false;
        this.editorTerminals.set(focus.tab, terminal);
        this.pendingEntry = undefined;
        this.terminalEdge = undefined;
        this.ambiguousEntry = false;
        this.automaticFocus.delete(terminal);
        this.viewed = pair;
        for (const [file, live] of this.tracker.openSessions())
            if (live.terminal === terminal)
                this.forget(file);
        return true;
    }
    observeFocus(kind, terminal) {
        const focus = this.focus();
        const previous = this.observedFocus;
        const previousTerminal = this.lastTerminal;
        const terminalChanged = kind === "terminal" && terminal !== previousTerminal;
        if (kind === "terminal")
            this.lastTerminal = terminal;
        this.observedFocus = focus;
        if (!this.started || this.tracker.restoring) {
            this.resetFocus();
            return;
        }
        if (kind === "terminal" && this.pendingReveal?.explicitOpen && terminal !== this.pendingReveal.terminal)
            this.pendingReveal.explicitOpen = undefined;
        this.trackRevealSelection(focus);
        if (!focus.focused) {
            // Native event halves cannot cross a blur. A known-target owner-window reveal can.
            this.viewed = undefined;
            this.pendingEntry = undefined;
            this.terminalEdge = undefined;
            this.ambiguousEntry = false;
            return;
        }
        if (this.acknowledgeReveal(focus))
            return;
        if (this.consumeAutomatic(focus))
            return;
        const selectionChanged = !this.sameSelection(previous, focus);
        const returned = !previous?.focused;
        let edge;
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
            const known = this.editorTerminals.get(focus.tab);
            if (known && focus.terminal === known && this.acknowledge(focus, known))
                return;
            if (returned)
                return;
            // An unchanged, unassociated file→terminal selection is not identity evidence.
            this.ambiguousEntry ||= superseded || (!previous?.isTerminal && !known && !terminalChanged && !(edge && this.sameSelection(edge.from, previous)));
            this.pendingEntry = { ...focus, departingTerminal: edge && this.sameSelection(edge.from, previous) ? edge.previousTerminal : previous?.terminal };
            // Terminal-first A→B: consume only an edge captured against the departing selection.
            if (!this.ambiguousEntry && edge && this.sameSelection(edge.from, previous) && edge.terminal === focus.terminal && (!known || known === edge.terminal) && this.acknowledge(focus, edge.terminal))
                return;
        }
        if (!terminalChanged)
            return;
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
            const known = this.editorTerminals.get(focus.tab);
            // Tab-first A→B: the old activeTerminal A sampled at the tab edge is never read.
            if (!this.ambiguousEntry && terminal && terminal === focus.terminal && terminal !== pending.departingTerminal && (!known || known === terminal) && this.acknowledge(focus, terminal))
                return;
            this.ambiguousEntry = true;
            this.terminalEdge = undefined;
            return;
        }
        // A terminal-only edge can come from the panel. It never acknowledges the old editor.
        if (this.terminalEdge)
            this.ambiguousEntry = true;
        this.terminalEdge = !this.ambiguousEntry && terminal && terminal === focus.terminal ? { terminal, previousTerminal, from: focus } : undefined;
    }
    onClose(terminal) {
        this.automaticFocus.delete(terminal);
        if (this.viewed?.terminal === terminal)
            this.viewed = undefined;
        if (this.pendingReveal?.terminal === terminal)
            this.pendingReveal = undefined;
        if (this.panelIntent === terminal)
            this.panelIntent = undefined;
        if (this.pendingEntry || this.terminalEdge) {
            this.pendingEntry = undefined;
            this.terminalEdge = undefined;
            this.ambiguousEntry = true;
        }
        this.observeFocus("close");
    }
    dispose() {
        for (const disposable of this.disposables)
            disposable.dispose();
        this.changed.dispose();
    }
}
exports.SessionAttention = SessionAttention;
