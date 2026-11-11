"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vscode = require("vscode");
const { agentDir } = require("./config");

// One atomic record per session: independent windows cannot lose each other's pins.
class SessionPins {
    records = new Map();
    changed = new vscode.EventEmitter();
    onDidChange = this.changed.event;
    constructor(dir = path.join(agentDir(), "vscode-pins")) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.refresh();
        this.watcher = fs.watch(dir, () => this.refresh());
        this.watcher.on("error", error => void vscode.window.showWarningMessage("Cannot watch pinned sessions: " + error.message));
    }
    recordPath(id) {
        if (typeof id !== "string" || !id) throw new Error("Session ID is not available yet");
        return path.join(this.dir, crypto.createHash("sha256").update(id).digest("hex") + ".json");
    }
    refresh() {
        const records = new Map();
        try {
            for (const name of fs.readdirSync(this.dir).sort()) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                try {
                    const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
                    if (record.version === 1 && typeof record.id === "string" && record.id && typeof record.file === "string" && path.isAbsolute(record.file) && this.recordPath(record.id) === path.join(this.dir, name)) records.set(record.id, record);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
        } catch (error) {
            void vscode.window.showWarningMessage("Cannot read pinned sessions: " + error.message);
            return;
        }
        if (JSON.stringify([...records]) !== JSON.stringify([...this.records])) {
            this.records = records;
            this.changed.fire();
        }
    }
    list() { return [...this.records.values()]; }
    has(id) { return this.records.has(id); }
    pin(session) {
        const target = this.recordPath(session.id);
        const temp = target + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
        try {
            fs.writeFileSync(temp, JSON.stringify({ version: 1, id: session.id, file: session.file, title: session.title, cwd: session.cwd }), { mode: 0o600, flag: "wx" });
            fs.renameSync(temp, target);
        } finally {
            try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        this.refresh();
    }
    unpin(id) {
        try { fs.unlinkSync(this.recordPath(id)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        this.refresh();
    }
    dispose() { this.watcher.close(); this.changed.dispose(); }
}
exports.SessionPins = SessionPins;
