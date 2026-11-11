"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowSessions = void 0;
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const config_1 = require("./config");
const VERSION = 1;
const HEARTBEAT_MS = 2000;
const FRESH_MS = 10000;
const REQUEST_MS = 3000;
const MAX_MESSAGE = 24 * 1024;
const MAX_MANIFEST = 8 * 1024 * 1024;
const OWNER_RE = /^[a-f0-9]{24}$/;
const KEY_RE = /^[\w-]{1,160}$/;
const STATES = new Set(["idle", "working", "waiting", "unknown"]);
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return undefined;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM" ? true : err.code === "ESRCH" ? false : undefined;
    }
}
function validFile(file) {
    return typeof file === "string" && file.length > 0 && file.length <= 8192 && path.isAbsolute(file) && !file.includes("\0");
}
function positive(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function validKey(value) {
    return typeof value === "string" && KEY_RE.test(value);
}
function order(a, b) {
    return a.adoptedAt - b.adoptedAt || a.ownerId.localeCompare(b.ownerId);
}
function privateDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("Небезопасный каталог реестра окон OMP");
    fs.chmodSync(dir, 0o700);
}
function readJson(file, max) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(file, flags);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > max || (process.getuid && stat.uid !== process.getuid()))
            throw new Error("Недопустимый файл реестра OMP");
        // Read at most the advertised bound, even if a writer grows the file concurrently.
        const bytes = Buffer.allocUnsafe(Math.min(max + 1, stat.size + 1));
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > max)
            throw new Error("Слишком большой файл реестра OMP");
        return JSON.parse(bytes.subarray(0, count).toString("utf8"));
    }
    finally {
        fs.closeSync(fd);
    }
}
/** A runtime owns only its manifest/socket. Disconnection never means terminal closure. */
class WindowSessions {
    ctx;
    tracker;
    attention;
    index;
    ownerId = crypto.randomBytes(12).toString("hex");
    startedAt = Date.now();
    ownerLabel;
    dir;
    socketDir;
    socketPath;
    manifestPath;
    server;
    watchers = [];
    connections = new Set();
    disposables = [];
    manifests = new Map();
    hooks = new Map();
    ownClaims = new Map();
    releases = new Map();
    failedOwners = new Map();
    reservations = new Map();
    ownReservations = new Map();
    identities = new Map();
    identityCache = new Map();
    identityCacheUntil = 0;
    visible = new Map();
    changed = new vscode.EventEmitter();
    onDidChange = this.changed.event;
    heartbeat;
    refreshTimer;
    signature = "";
    published = "";
    ready = false;
    healthy = false;
    disposed = false;
    warned = new Set();
    constructor(ctx, tracker, attention, index) {
        this.ctx = ctx;
        this.tracker = tracker;
        this.attention = attention;
        this.index = index;
        this.disposables.push(index.onDidChangeFiles((file) => {
            if (file === undefined)
                this.identityCache.clear();
            else {
                const normalized = (0, config_1.normPath)(file);
                for (const [key, canonical] of this.identityCache)
                    if (key === normalized || canonical === normalized)
                        this.identityCache.delete(key);
            }
        }));
        this.ownerLabel = vscode.workspace.name || path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "") || "окно VS Code";
        this.dir = path.join((0, config_1.agentDir)(), "vscode-windows");
        // macOS sockaddr_un has a short path limit. The registry always stays in agentDir;
        // only long-path sockets use a deterministic, user-private local directory.
        const direct = path.join(this.dir, `${this.ownerId}.sock`);
        const hash = crypto.createHash("sha256").update((0, config_1.normPath)(this.dir)).digest("hex").slice(0, 20);
        this.socketDir = Buffer.byteLength(direct) < 100 ? this.dir : path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `omp-windows-${process.getuid?.() ?? "user"}-${hash}`);
        this.socketPath = path.join(this.socketDir, `${this.ownerId}.sock`);
        this.manifestPath = path.join(this.dir, `${this.ownerId}.json`);
    }
    async start() {
        try {
            privateDirectory(this.dir);
            if (this.socketDir !== this.dir)
                privateDirectory(this.socketDir);
            fs.mkdirSync((0, config_1.terminalMapDir)(), { recursive: true });
            this.server = net.createServer((socket) => this.accept(socket));
            this.server.maxConnections = 32;
            this.server.on("error", (err) => {
                this.ready = false;
                this.warn("socket", err);
                this.queueRefresh();
            });
            await new Promise((resolve, reject) => {
                const failed = (err) => reject(err);
                this.server.once("error", failed);
                this.server.listen(this.socketPath, () => {
                    this.server.removeListener("error", failed);
                    try {
                        fs.chmodSync(this.socketPath, 0o600);
                        this.ready = true;
                        resolve();
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
        }
        catch (err) {
            this.ready = false;
            this.warn("start", err);
        }
        const subscribe = (source, name, listener) => {
            if (typeof source?.[name] === "function")
                this.disposables.push(source[name](listener));
        };
        subscribe(this.tracker, "onDidChange", () => this.queueRefresh());
        subscribe(this.attention, "onDidChange", () => this.queueRefresh());
        subscribe(this.index, "onDidChange", () => this.queueRefresh());
        subscribe(this.tracker, "onDidReleaseSession", (entry) => {
            if (!validKey(entry.terminalKey))
                return;
            const claim = this.ownClaims.get(entry.terminalKey) ?? { terminalKey: entry.terminalKey, ownerId: this.ownerId, adoptedAt: this.startedAt, file: entry.sessionFile };
            if (!entry.sessionFile || this.identity(claim.file) === this.identity(entry.sessionFile)) {
                this.release(claim, this.hooks.get(entry.terminalKey)?.pid);
                this.ownClaims.delete(entry.terminalKey);
                if (this.publish(true))
                    for (const [file, held] of this.ownReservations)
                        if (held.pending && held.terminalKey === entry.terminalKey)
                            this.finishReservation(file, held.token);
            }
            this.queueRefresh();
        });
        for (const dir of [this.dir, (0, config_1.terminalMapDir)()]) {
            try {
                const watcher = fs.watch(dir, () => this.queueRefresh());
                watcher.on("error", (err) => {
                    watcher.close();
                    this.warn(`watch:${dir}`, err);
                });
                this.watchers.push(watcher);
            }
            catch (err) {
                this.warn(`watch:${dir}`, err);
            }
        }
        this.refresh(true);
        this.heartbeat = setInterval(() => this.refresh(true), HEARTBEAT_MS);
        this.heartbeat.unref?.();
    }
    warn(key, err) {
        if (this.warned.has(key))
            return;
        this.warned.add(key);
        this.tracker.log?.warn?.(`Общий реестр окон OMP: ${err?.message || String(err)}`);
    }
    queueRefresh() {
        if (this.disposed || this.refreshTimer)
            return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, 20);
        this.refreshTimer.unref?.();
    }
    readHooks() {
        let names;
        try {
            names = fs.readdirSync((0, config_1.terminalMapDir)());
        }
        catch (err) {
            this.healthy = false;
            this.warn("hooks", err);
            return;
        }
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const key = name.slice(0, -5);
            if (!validKey(key))
                continue;
            try {
                const rec = readJson(path.join((0, config_1.terminalMapDir)(), name), 64 * 1024);
                if (!validFile(rec?.sessionFile) || !positive(rec.pid))
                    throw new Error("Неполная запись живого терминала OMP");
                this.hooks.set(key, { terminalKey: key, file: (0, config_1.normPath)(rec.sessionFile), pid: rec.pid, cwd: typeof rec.cwd === "string" ? rec.cwd : "", id: typeof rec.sessionId === "string" ? rec.sessionId : "" });
            }
            catch (err) {
                if (err.code !== "ENOENT") {
                    this.healthy = false;
                    this.warn(`hook:${key}`, err);
                }
            }
        }
        // There is deliberately no updatedAt TTL: an idle OMP can keep the same report for days.
        for (const [key, hook] of this.hooks)
            if (alive(hook.pid) === false)
                this.hooks.delete(key);
    }
    readManifests() {
        let names;
        try {
            names = fs.readdirSync(this.dir);
        }
        catch (err) {
            this.healthy = false;
            this.warn("registry", err);
            return;
        }
        const seen = new Set();
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const ownerId = name.slice(0, -5);
            if (!OWNER_RE.test(ownerId) || ownerId === this.ownerId)
                continue;
            seen.add(ownerId);
            try {
                const rec = readJson(path.join(this.dir, name), MAX_MANIFEST);
                if (rec?.version !== VERSION || rec.ownerId !== ownerId || !positive(rec.startedAt) || !positive(rec.hostPid) || !Array.isArray(rec.sessions) || !Array.isArray(rec.releases))
                    throw new Error("Неполная запись окна OMP");
                const sessions = rec.sessions.map((entry) => {
                    if (!validFile(entry?.file) || !validKey(entry.terminalKey) || !positive(entry.adoptedAt))
                        throw new Error("Неполная запись владельца сессии OMP");
                    if (validFile(entry.canonicalFile))
                        this.identities.set((0, config_1.normPath)(entry.file), (0, config_1.normPath)(entry.canonicalFile));
                    return { ...entry, file: (0, config_1.normPath)(entry.file), ownerId, state: STATES.has(entry.state) ? entry.state : "unknown", pid: positive(entry.pid), agentPid: positive(entry.agentPid) };
                });
                const releases = rec.releases.map((entry) => {
                    if (!validKey(entry?.terminalKey) || !positive(entry.adoptedAt) || !OWNER_RE.test(entry.ownerId))
                        throw new Error("Неполная запись закрытия OMP");
                    return { terminalKey: entry.terminalKey, adoptedAt: entry.adoptedAt, ownerId: entry.ownerId, agentPid: positive(entry.agentPid) };
                });
                this.manifests.set(ownerId, { ownerId, startedAt: rec.startedAt, hostPid: rec.hostPid, heartbeat: positive(rec.heartbeat) ?? 0, active: rec.active === true, ownerLabel: typeof rec.ownerLabel === "string" ? rec.ownerLabel.slice(0, 240) : "окно VS Code", sessions, releases });
            }
            catch (err) {
                this.healthy = false;
                const previous = this.manifests.get(ownerId);
                if (previous)
                    previous.active = false;
                this.warn(`manifest:${ownerId}`, err);
            }
        }
        // An unexpectedly missing manifest is not a terminal-close acknowledgement.
        for (const [ownerId, rec] of this.manifests)
            if (ownerId !== this.ownerId && !seen.has(ownerId))
                rec.active = false;
    }
    identity(file, cached = false) {
        const normalized = (0, config_1.normPath)(file);
        const now = Date.now();
        if (now >= this.identityCacheUntil) {
            this.identityCache.clear();
            this.identityCacheUntil = now + 5000;
        }
        if (cached && this.identityCache.has(normalized))
            return this.identityCache.get(normalized) ?? this.identities.get(normalized) ?? normalized;
        try {
            const canonical = (0, config_1.normPath)(fs.realpathSync(normalized));
            this.identities.set(normalized, canonical);
            this.identityCache.set(normalized, canonical);
            return canonical;
        }
        catch {
            // Cache the failed lookup, not ownership evidence that can still change.
            this.identityCache.set(normalized, null);
            return this.identities.get(normalized) ?? normalized;
        }
    }
    reservationPath(file) {
        const hash = crypto.createHash("sha256").update(file).digest("hex");
        return path.join(this.dir, `${hash}.launch`);
    }
    readReservations() {
        let names;
        try {
            names = fs.readdirSync(this.dir);
        }
        catch (err) {
            this.healthy = false;
            this.warn("reservations", err);
            return;
        }
        const next = new Map();
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.launch$/.test(name))
                continue;
            try {
                const rec = readJson(path.join(this.dir, name), 64 * 1024);
                if (rec?.version !== VERSION || !validFile(rec.file) || (0, config_1.normPath)(rec.file) !== rec.file || path.basename(this.reservationPath(rec.file)) !== name || !OWNER_RE.test(rec.ownerId) || typeof rec.token !== "string" || !/^[a-f0-9]{32}$/.test(rec.token) || !positive(rec.hostPid) || !positive(rec.createdAt))
                    throw new Error("Неполная запись запуска OMP");
                next.set(rec.file, { file: rec.file, ownerId: rec.ownerId, token: rec.token, hostPid: rec.hostPid, createdAt: rec.createdAt, ownerLabel: typeof rec.ownerLabel === "string" ? rec.ownerLabel.slice(0, 240) : "окно VS Code", terminalKey: validKey(rec.terminalKey) ? rec.terminalKey : undefined });
            }
            catch (err) {
                if (err.code === "ENOENT")
                    continue;
                this.healthy = false;
                this.warn(`reservation:${name}`, err);
                for (const [file, rec] of this.reservations)
                    if (path.basename(this.reservationPath(file)) === name)
                        next.set(file, rec);
            }
        }
        // A reservation has no timeout. A crashed host may have launched OMP before it
        // could publish a PID, so a dead host alone is never evidence that this is free.
        this.reservations = next;
    }
    async reserveLaunch(file) {
        if (this.disposed || !this.ready || !validFile(file))
            throw new Error("Не удалось безопасно зарезервировать запуск OMP. Копия не запущена.");
        file = this.identity(file);
        if (this.ownReservations.has(file))
            throw new Error("Эта сессия OMP уже запускается в этом окне.");
        this.refresh();
        if (!this.healthy || this.visible.has(file))
            throw new Error("Сессия уже работает, запускается или не подтверждена закрытой. Копия OMP не запущена.");
        const token = crypto.randomBytes(16).toString("hex");
        const rec = { version: VERSION, file, ownerId: this.ownerId, ownerLabel: this.ownerLabel, token, hostPid: process.pid, createdAt: Date.now() };
        const lock = this.reservationPath(file);
        let fd;
        let created = false;
        try {
            fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
            created = true;
            fs.writeFileSync(fd, JSON.stringify(rec));
        }
        catch (err) {
            if (created)
                try { fs.rmSync(lock); } catch { }
            this.refresh();
            throw new Error(err.code === "EEXIST" ? "Запуск этой сессии уже зарезервирован другим запросом. Новый OMP не запущен." : "Не удалось безопасно зарезервировать запуск OMP. Новый OMP не запущен.");
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
        this.ownReservations.set(file, { token, pending: false });
        this.refresh();
        // Acquire first, then re-check: a separate check followed by O_EXCL would still
        // race an owner that published and released its lock between those operations.
        const target = this.buildVisible(this.localEntries(), token).get(file);
        if (!this.healthy || target) {
            this.finishReservation(file, token);
            this.refresh();
            throw new Error(target?.reason || "Сессия уже работает, запускается или принадлежит недоступному окну. Копия OMP не запущена.");
        }
        return token;
    }
    writeReservation(file, held, updates) {
        const lock = this.reservationPath(file);
        const tmp = path.join(this.dir, `${this.ownerId}.${crypto.randomBytes(4).toString("hex")}.tmp`);
        try {
            const rec = readJson(lock, 64 * 1024);
            if (rec.ownerId !== this.ownerId || rec.token !== held.token || rec.file !== file)
                return undefined;
            const next = { ...rec, ...updates };
            fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
            fs.renameSync(tmp, lock);
            this.reservations.set(file, next);
            return next;
        }
        catch (err) {
            this.healthy = false;
            this.warn(`reservation-write:${held.token}`, err);
            return undefined;
        }
        finally {
            try { fs.rmSync(tmp, { force: true }); } catch { }
        }
    }
    finishReservation(file, token) {
        const held = this.ownReservations.get(file);
        if (!held || held.token !== token)
            return false;
        try {
            const rec = readJson(this.reservationPath(file), 64 * 1024);
            if (rec.ownerId !== this.ownerId || rec.token !== token || rec.file !== file)
                return false;
            fs.rmSync(this.reservationPath(file));
            this.ownReservations.delete(file);
            this.reservations.delete(file);
            return true;
        }
        catch (err) {
            this.healthy = false;
            this.warn(`reservation-release:${token}`, err);
            return false;
        }
    }
    bindReservation(file, held, terminalKey) {
        if (held.terminalKey)
            return;
        held.terminalKey = terminalKey;
        this.writeReservation(file, held, { terminalKey });
    }
    releaseLaunch(file, token, _registered, failedBeforeCreation = false, terminalKey) {
        if (!validFile(file))
            return;
        file = this.identity(file);
        const held = this.ownReservations.get(file);
        if (!held || held.token !== token)
            return;
        if (failedBeforeCreation) {
            this.finishReservation(file, token);
            this.refresh();
            return;
        }
        held.pending = true;
        if (validKey(terminalKey))
            this.bindReservation(file, held, terminalKey);
        // VS Code can expose the new terminal after launch() returns. Keep the lock
        // until a later refresh can publish that exact local terminal, not just a flag.
        this.refresh();
    }
    settleReservations(published, local) {
        if (!published)
            return;
        let saved = false;
        for (const [file, held] of this.ownReservations) {
            if (!held.pending || !held.terminalKey)
                continue;
            let entry;
            for (const [candidate, value] of local)
                if (value.terminalKey === held.terminalKey && this.identity(candidate) === file) {
                    entry = value;
                    break;
                }
            const claim = entry && this.ownClaims.get(entry.terminalKey);
            if (claim && this.identity(claim.file) === file && claim.available && this.terminalAlive(entry)) {
                if (!saved) {
                    if (!this.publish(true))
                        return;
                    saved = true;
                }
                this.finishReservation(file, held.token);
            }
        }
    }
    localEntries() {
        const out = new Map();
        for (const [file, entry] of this.tracker.openSessions()) {
            if (!validFile(file) || !validKey(entry.terminalKey))
                continue;
            out.set((0, config_1.normPath)(file), entry);
        }
        return out;
    }
    terminalAlive(entry) {
        return entry?.terminal && entry.terminal.exitStatus === undefined && vscode.window.terminals.includes(entry.terminal) && alive(entry.pid) !== false;
    }
    collectLocal() {
        const local = this.localEntries();
        const keys = new Set();
        for (const [file, entry] of local) {
            const key = entry.terminalKey;
            keys.add(key);
            const previous = this.ownClaims.get(key);
            const hook = this.hooks.get(key);
            const matchingHook = hook && this.identity(hook.file) === this.identity(file) ? hook : undefined;
            const info = this.index.find(file);
            let adoptedAt = previous?.adoptedAt ?? this.startedAt;
            const released = this.releases.get(key);
            // A terminal still lingering in the tracker after close must not re-adopt its own
            // released claim. Only a newly reported agent generation can revive this key.
            if (!previous && released && (!matchingHook || matchingHook.pid === released.agentPid))
                continue;
            if (!previous && released)
                adoptedAt = Math.max(Date.now(), released.adoptedAt + 1);
            if (previous?.agentPid && matchingHook && previous.agentPid !== matchingHook.pid)
                adoptedAt = Math.max(Date.now(), previous.adoptedAt + 1);
            const claim = {
                file, canonicalFile: this.identity(file), terminalKey: key, ownerId: this.ownerId, adoptedAt,
                id: info?.id || matchingHook?.id || path.basename(file, ".jsonl"),
                title: info?.title || previous?.title || path.basename(file, ".jsonl"),
                cwd: entry.cwd || info?.cwd || matchingHook?.cwd || previous?.cwd || "",
                state: STATES.has(entry.state) ? entry.state : "unknown",
                launching: entry.launching === true,
                unreadCompletion: this.attention.isUnread(file) === true,
                pid: positive(entry.pid),
                agentPid: matchingHook?.pid ?? positive(entry.agentPid) ?? previous?.agentPid,
                available: this.terminalAlive(entry),
            };
            if (alive(claim.agentPid) === false || (!claim.agentPid && alive(claim.pid) === false)) {
                this.release(claim);
                this.ownClaims.delete(key);
            }
            else {
                this.ownClaims.set(key, claim);
            }
        }
        for (const [key, claim] of this.ownClaims) {
            if (keys.has(key))
                continue;
            if (alive(claim.agentPid ?? claim.pid) === false) {
                this.release(claim);
                this.ownClaims.delete(key);
            }
            else {
                // Tracker disappearance without a real-close event is retained as blocked evidence.
                claim.available = false;
                claim.state = "unknown";
                claim.launching = false;
            }
        }
        return local;
    }
    release(claim, agentPid) {
        const previous = this.releases.get(claim.terminalKey);
        if (!previous || order(claim, previous) > 0)
            this.releases.set(claim.terminalKey, { terminalKey: claim.terminalKey, adoptedAt: claim.adoptedAt, ownerId: claim.ownerId, agentPid: positive(agentPid) ?? claim.agentPid });
        else if (order(claim, previous) === 0 && !previous.agentPid)
            previous.agentPid = positive(agentPid) ?? claim.agentPid;
    }
    ownManifest() {
        return { version: VERSION, ownerId: this.ownerId, startedAt: this.startedAt, hostPid: process.pid, heartbeat: Date.now(), active: this.ready && !this.disposed, ownerLabel: this.ownerLabel, sessions: [...this.ownClaims.values()], releases: [...this.releases.values()] };
    }
    publish(force = false) {
        const rec = this.ownManifest();
        const signature = JSON.stringify({ ...rec, heartbeat: 0 });
        this.manifests.set(this.ownerId, rec);
        if (!force && signature === this.published)
            return true;
        const tmp = path.join(this.dir, `${this.ownerId}.${crypto.randomBytes(4).toString("hex")}.tmp`);
        try {
            const json = JSON.stringify(rec);
            if (Buffer.byteLength(json) > MAX_MANIFEST)
                throw new Error("Реестр этого окна OMP превысил безопасный размер");
            fs.writeFileSync(tmp, json, { mode: 0o600, flag: "wx" });
            fs.renameSync(tmp, this.manifestPath);
            this.published = signature;
            return true;
        }
        catch (err) {
            this.healthy = false;
            this.warn("publish", err);
            return false;
        }
        finally {
            try { fs.rmSync(tmp, { force: true }); } catch { }
        }
    }
    fresh(rec) {
        const age = Date.now() - rec.heartbeat;
        return rec.active && age >= -HEARTBEAT_MS && age < FRESH_MS && alive(rec.hostPid) === true && (!this.failedOwners.has(rec.ownerId) || rec.heartbeat > this.failedOwners.get(rec.ownerId));
    }
    buildVisible(local, ignoredReservationToken) {
        const winners = new Map();
        const released = new Map();
        for (const rec of this.manifests.values()) {
            for (const entry of rec.releases) {
                const old = released.get(entry.terminalKey);
                if (!old || order(entry, old) > 0)
                    released.set(entry.terminalKey, entry);
            }
            for (const claim of rec.sessions) {
                const old = winners.get(claim.terminalKey);
                if (!old || order(claim, old.claim) > 0)
                    winners.set(claim.terminalKey, { claim, rec });
            }
        }
        for (const [key, winner] of winners) {
            const tombstone = released.get(key);
            if (tombstone && order(winner.claim, tombstone) <= 0) {
                winners.delete(key);
                continue;
            }
            if (alive(winner.claim.agentPid ?? winner.claim.pid) === false) {
                this.release(winner.claim);
                released.set(key, this.releases.get(key));
                winners.delete(key);
            }
        }
        const byFile = new Map();
        const add = (descriptor) => {
            const identity = this.identity(descriptor.file);
            const list = byFile.get(identity) ?? [];
            list.push(descriptor);
            byFile.set(identity, list);
        };
        for (const [key, { claim, rec }] of winners) {
            const exactLocal = rec.ownerId === this.ownerId && local.get(claim.file)?.terminalKey === key && this.terminalAlive(local.get(claim.file));
            const kind = exactLocal && claim.available ? "local" : rec.ownerId !== this.ownerId && claim.available && this.fresh(rec) ? "remote" : "unavailable";
            add({ file: claim.file, id: claim.id || path.basename(claim.file, ".jsonl"), title: claim.title || path.basename(claim.file, ".jsonl"), cwd: claim.cwd || "", state: kind === "unavailable" ? "unknown" : claim.state, launching: kind !== "unavailable" && claim.launching === true, unreadCompletion: claim.unreadCompletion === true, ownerId: rec.ownerId, ownerLabel: rec.ownerLabel, terminalKey: key, kind, adoptedAt: claim.adoptedAt });
        }
        for (const [key, hook] of this.hooks) {
            if (alive(hook.pid) === false)
                continue;
            const winner = winners.get(key);
            if (winner && this.identity(winner.claim.file) === this.identity(hook.file) && (!winner.claim.agentPid || winner.claim.agentPid === hook.pid))
                continue;
            const tombstone = released.get(key);
            if (!winner && tombstone?.agentPid === hook.pid)
                continue;
            const info = this.index.find(hook.file);
            add({ file: hook.file, id: info?.id || hook.id || path.basename(hook.file, ".jsonl"), title: info?.title || path.basename(hook.file, ".jsonl"), cwd: hook.cwd || info?.cwd || "", state: "unknown", launching: false, unreadCompletion: false, ownerId: winner?.rec.ownerId || "", ownerLabel: winner?.rec.ownerLabel || "окно недоступно", terminalKey: key, kind: "unavailable" });
        }
        for (const reservation of this.reservations.values()) {
            if (reservation.ownerId === this.ownerId && reservation.token === ignoredReservationToken)
                continue;
            const info = this.index.find(reservation.file);
            add({ file: reservation.file, id: info?.id || path.basename(reservation.file, ".jsonl"), title: info?.title || path.basename(reservation.file, ".jsonl"), cwd: info?.cwd || "", state: "unknown", launching: false, unreadCompletion: false, ownerId: reservation.ownerId, ownerLabel: reservation.ownerLabel, terminalKey: `launch-${reservation.token}`, kind: "unavailable", reason: "Запуск этой сессии зарезервирован окном VS Code. Повторный запуск OMP заблокирован." });
        }
        const out = new Map();
        for (const [file, candidates] of byFile) {
            const distinct = new Set(candidates.map((entry) => entry.terminalKey));
            const value = candidates.find((entry) => entry.kind === "local") || candidates[0];
            out.set(file, distinct.size > 1 || candidates.some((entry) => entry.kind === "unavailable" && entry.terminalKey === value.terminalKey && entry !== value) ? { ...value, kind: "unavailable", state: "unknown", launching: false, ambiguous: distinct.size > 1 } : value);
        }
        return out;
    }
    refresh(force = false) {
        if (this.disposed)
            return;
        this.healthy = this.ready;
        try {
            this.readHooks();
            this.readReservations();
            const local = this.collectLocal();
            this.readManifests();
            const initialPublished = this.publish(force);
            this.buildVisible(local);
            const published = this.publish();
            this.settleReservations(initialPublished && published, local);
            this.visible = this.buildVisible(local);
            const signature = JSON.stringify([...this.visible]);
            if (signature !== this.signature) {
                this.signature = signature;
                this.changed.fire();
            }
        }
        catch (err) {
            this.healthy = false;
            this.warn("refresh", err);
        }
    }
    sessions() {
        return new Map(this.visible);
    }
    unavailable(file, expected, reason) {
        return { ...(this.visible.get(validFile(file) ? this.identity(file) : file) ?? {}), file, kind: "unavailable", state: "unknown", launching: false, ...(expected?.ownerId ? { ownerId: expected.ownerId } : {}), ...(expected?.terminalKey ? { terminalKey: expected.terminalKey } : {}), reason };
    }
    async resolve(file, expected) {
        if (!validFile(file))
            return this.unavailable(String(file), expected, "Некорректный путь сессии OMP");
        file = (0, config_1.normPath)(file);
        this.refresh();
        let target = this.visible.get(this.identity(file));
        if (expected?.ownerId && target?.ownerId !== expected.ownerId || expected?.terminalKey && target?.terminalKey !== expected.terminalKey)
            return this.unavailable(file, expected, "Выбранное окно или терминал уже изменились. Обновите список сессий; копия OMP не запущена.");
        if (!target)
            return expected?.ownerId || expected?.terminalKey ? this.unavailable(file, expected, "Выбранный терминал больше не доступен; автоматический повторный запуск запрещён.") : this.healthy ? { kind: "closed", file } : this.unavailable(file, expected, "Не удалось проверить общий реестр окон. Повторный запуск OMP заблокирован.");
        if (target.kind !== "remote")
            return target;
        try {
            const response = await this.request(target, "inspect");
            if (response.status === "owned")
                return target;
            if (response.status === "released") {
                this.release(target, response.agentPid);
                this.publish();
                this.refresh();
                target = this.visible.get(this.identity(file));
                return target || (expected?.ownerId || expected?.terminalKey ? this.unavailable(file, expected, "Выбранный терминал закрыт; повторный запуск по устаревшей ссылке запрещён.") : this.healthy ? { kind: "closed", file } : this.unavailable(file, expected, "Не удалось проверить общий реестр окон."));
            }
            return this.unavailable(file, expected, response.reason || "Владелец не подтвердил выбранный терминал. Копия OMP не запущена.");
        }
        catch (err) {
            this.failedOwners.set(target.ownerId, this.manifests.get(target.ownerId)?.heartbeat ?? Date.now());
            this.refresh();
            return this.unavailable(file, expected, "Окно с этой сессией не отвечает. Сессия может продолжать работать; повторный запуск OMP заблокирован.");
        }
    }
    async canRestore(file) {
        return (await this.resolve(file)).kind === "closed";
    }
    async route(opts) {
        const target = await this.resolve(opts.sessionFile, opts);
        if (target.kind === "closed")
            return false;
        if (target.kind === "unavailable")
            throw new Error(target.reason || (target.ambiguous ? "Несколько терминалов заявили одну сессию. Повторный запуск OMP заблокирован." : "Сессия связана с недоступным окном или живым процессом OMP. Дождитесь подключения владельца; копия не запущена."));
        if (target.kind === "local") {
            await this.tracker.focusExisting({ ...opts, sessionFile: target.file, terminalKey: target.terminalKey });
            await vscode.commands.executeCommand("workbench.action.focusWindow");
            return true;
        }
        try {
            const response = await this.request(target, "focus", opts);
            if (response.status !== "focused")
                throw new Error(response.reason || "Владелец отказался переключать изменившийся терминал. Копия OMP не запущена.");
            return true;
        }
        catch (err) {
            this.failedOwners.set(target.ownerId, this.manifests.get(target.ownerId)?.heartbeat ?? Date.now());
            this.refresh();
            throw new Error(`Не удалось переключиться в окно с сессией OMP. Повторный запуск запрещён: ${err.message}`);
        }
    }
    request(target, op, opts = {}) {
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const socketPath = path.join(this.socketDir, `${target.ownerId}.sock`);
            const socket = net.createConnection(socketPath);
            let bytes = 0;
            const chunks = [];
            let settled = false;
            const finish = (err, response) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                err ? reject(err) : resolve(response);
            };
            const timer = setTimeout(() => finish(new Error("Окно-владелец не подтвердило запрос вовремя")), REQUEST_MS);
            socket.on("error", (err) => finish(err));
            socket.on("close", () => finish(new Error("Окно-владелец разорвало соединение без подтверждения")));
            socket.on("connect", () => {
                const message = JSON.stringify({ version: VERSION, requestId, op, ownerId: target.ownerId, file: target.file, terminalKey: target.terminalKey, adoptedAt: target.adoptedAt, location: opts.location === "panel" || opts.location === "editor" ? opts.location : undefined, preserveFocus: opts.preserveFocus === true }) + "\n";
                if (Buffer.byteLength(message) > MAX_MESSAGE)
                    return finish(new Error("Слишком большой запрос окна OMP"));
                socket.write(message);
            });
            socket.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_MESSAGE)
                    return finish(new Error("Слишком большой ответ окна OMP"));
                chunks.push(chunk);
                if (!chunk.includes(10))
                    return;
                try {
                    const response = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8").trim());
                    if (response?.version !== VERSION || response.requestId !== requestId || response.ownerId !== target.ownerId || response.file !== target.file || response.terminalKey !== target.terminalKey)
                        throw new Error("Ответ не соответствует выбранному терминалу OMP");
                    finish(undefined, response);
                }
                catch (err) {
                    finish(err);
                }
            });
        });
    }
    accept(socket) {
        this.connections.add(socket);
        const deadline = setTimeout(() => socket.destroy(), REQUEST_MS);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
            clearTimeout(deadline);
            this.connections.delete(socket);
        });
        let bytes = 0;
        const chunks = [];
        let received = false;
        socket.on("data", (chunk) => {
            if (received)
                return socket.destroy();
            bytes += chunk.length;
            if (bytes > MAX_MESSAGE)
                return socket.destroy();
            chunks.push(chunk);
            if (!chunk.includes(10))
                return;
            received = true;
            let request;
            try {
                request = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8").trim());
                if (request?.version !== VERSION || typeof request.requestId !== "string" || request.requestId.length > 64 || request.ownerId !== this.ownerId || !validFile(request.file) || (0, config_1.normPath)(request.file) !== request.file || !validKey(request.terminalKey) || !positive(request.adoptedAt) || !["inspect", "focus"].includes(request.op) || request.location !== undefined && !["panel", "editor"].includes(request.location))
                    throw new Error("Недопустимый запрос окна OMP");
            }
            catch {
                socket.destroy();
                return;
            }
            void this.answer(request, socket).then((reply) => {
                if (!socket.destroyed)
                    this.reply(socket, request, reply);
            }).catch(() => {
                if (!socket.destroyed)
                    this.reply(socket, request, { status: "refused", reason: "Не удалось подтвердить существующий терминал; OMP не запущен повторно." });
            });
        });
    }
    reply(socket, request, reply) {
        const message = JSON.stringify({ version: VERSION, requestId: request.requestId, ownerId: this.ownerId, file: request.file, terminalKey: request.terminalKey, ...reply }) + "\n";
        if (Buffer.byteLength(message) > MAX_MESSAGE)
            socket.destroy();
        else
            socket.end(message);
    }
    async answer(request, socket) {
        this.refresh();
        const claim = this.ownClaims.get(request.terminalKey);
        const entry = this.localEntries().get(request.file);
        const released = this.releases.get(request.terminalKey);
        if (released && order({ adoptedAt: request.adoptedAt, ownerId: this.ownerId }, released) <= 0)
            return { status: "released", agentPid: released.agentPid };
        if (this.disposed || !claim || claim.file !== request.file || claim.adoptedAt !== request.adoptedAt || !claim.available || entry?.terminalKey !== request.terminalKey || !this.terminalAlive(entry) || alive(claim.agentPid) === false || socket.destroyed)
            return { status: "refused", reason: "Выбранный терминал больше не принадлежит этому окну или не подтверждён живым. Копия OMP не запущена." };
        const winner = this.visible.get(this.identity(request.file));
        if (winner?.kind !== "local" || winner.ownerId !== this.ownerId || winner.terminalKey !== request.terminalKey)
            return { status: "refused", reason: "Владение сессией изменилось или неоднозначно. Копия OMP не запущена." };
        if (request.op === "inspect")
            return { status: "owned" };
        await this.tracker.focusExisting({ sessionFile: request.file, terminalKey: request.terminalKey, location: request.location, preserveFocus: request.preserveFocus === true });
        const current = this.localEntries().get(request.file);
        if (socket.destroyed || this.disposed || current?.terminalKey !== request.terminalKey || !this.terminalAlive(current) || alive(claim.agentPid) === false)
            return { status: "refused", reason: "Запрос переключения устарел." };
        await vscode.commands.executeCommand("workbench.action.focusWindow");
        return { status: "focused" };
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        clearInterval(this.heartbeat);
        clearTimeout(this.refreshTimer);
        for (const watcher of this.watchers)
            watcher.close();
        for (const disposable of this.disposables)
            disposable.dispose();
        // Keep both claims and close tombstones. A stopped extension host is not a stopped OMP.
        this.publish(true);
        this.identityCache.clear();
        for (const socket of this.connections)
            socket.destroy();
        this.server?.close();
        try {
            if (fs.lstatSync(this.socketPath).isSocket())
                fs.rmSync(this.socketPath);
        }
        catch { }
        this.changed.dispose();
    }
}
exports.WindowSessions = WindowSessions;
