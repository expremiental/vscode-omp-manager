import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionAttention } from "./attention";
import { agentDir, normPath, terminalMapDir } from "./config";
import type { SessionCatalog } from "./sessions";
import type { LaunchOptions, OpenSession, ReleasedSession, SessionState, TerminalTracker } from "./tracker";

const VERSION = 1;
const HEARTBEAT_MS = 2000;
const FRESH_MS = 10000;
const REQUEST_MS = 3000;
const MAX_MESSAGE = 24 * 1024;
const MAX_MANIFEST = 8 * 1024 * 1024;
const OWNER_RE = /^[a-f0-9]{24}$/;
const KEY_RE = /^[\w-]{1,160}$/;
const STATES = new Set<unknown>(["idle", "working", "waiting", "unknown"]);

/** A live omp reported by the hook in `vscode-terminals/`. */
interface Hook {
	terminalKey: string;
	file: string;
	pid: number;
	cwd: string;
	id: string;
}

/** Ordering key shared by claims and close tombstones: later adoption wins. */
interface Ordered {
	adoptedAt?: number;
	ownerId: string;
}

/** One window's claim that a terminal of its own runs a session. */
interface Claim extends Ordered {
	file: string;
	canonicalFile?: string;
	terminalKey: string;
	adoptedAt: number;
	id: string;
	title: string;
	cwd: string;
	state: SessionState;
	launching: boolean;
	unreadCompletion: boolean;
	pid?: number;
	agentPid?: number;
	available: boolean;
}

/** Tombstone: this terminal generation was really closed. */
interface Release extends Ordered {
	terminalKey: string;
	adoptedAt?: number;
	agentPid?: number;
}

interface Manifest {
	version?: number;
	ownerId: string;
	startedAt: number;
	hostPid: number;
	heartbeat: number;
	active: boolean;
	ownerLabel: string;
	sessions: Claim[];
	releases: Release[];
}

interface Reservation {
	version?: number;
	file: string;
	ownerId: string;
	token: string;
	hostPid: number;
	createdAt: number;
	ownerLabel: string;
	terminalKey?: string;
}

interface HeldReservation {
	token: string;
	pending: boolean;
	terminalKey?: string;
}

export type SessionKind = "local" | "remote" | "unavailable";

/** A live session as every window sees it, after resolving competing claims. */
export interface VisibleSession {
	file: string;
	id: string;
	title: string;
	cwd: string;
	state: SessionState;
	launching: boolean;
	unreadCompletion: boolean;
	ownerId: string;
	ownerLabel: string;
	terminalKey: string;
	kind: SessionKind;
	adoptedAt?: number;
	reason?: string;
	ambiguous?: boolean;
}

export type UnavailableTarget = Partial<VisibleSession> & { file: string; kind: "unavailable"; state: "unknown"; launching: false; reason?: string };
export type ClosedTarget = { kind: "closed"; file: string };
export type Resolution = VisibleSession | UnavailableTarget | ClosedTarget;

export interface SessionTarget {
	ownerId?: string;
	terminalKey?: string;
}

interface WindowRequest {
	version: number;
	requestId: string;
	op: "inspect" | "focus";
	ownerId: string;
	file: string;
	terminalKey: string;
	adoptedAt: number;
	location?: "panel" | "editor";
	preserveFocus?: boolean;
}

interface WindowReply {
	status: "owned" | "released" | "refused" | "focused";
	reason?: string;
	agentPid?: number;
}

function alive(pid: number | undefined): boolean | undefined {
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
	try {
		process.kill(pid as number, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM" ? true : code === "ESRCH" ? false : undefined;
	}
}

function validFile(file: unknown): file is string {
	return typeof file === "string" && file.length > 0 && file.length <= 8192 && path.isAbsolute(file) && !file.includes("\0");
}

function positive(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && KEY_RE.test(value);
}

function order(a: Ordered, b: Ordered): number {
	return (a.adoptedAt as number) - (b.adoptedAt as number) || a.ownerId.localeCompare(b.ownerId);
}

function privateDirectory(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Небезопасный каталог реестра окон OMP");
	fs.chmodSync(dir, 0o700);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted JSON, validated field by field by callers
function readJson(file: string, max: number): any {
	const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
	const fd = fs.openSync(file, flags);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > max || (process.getuid && stat.uid !== process.getuid())) throw new Error("Недопустимый файл реестра OMP");
		// Read at most the advertised bound, even if a writer grows the file concurrently.
		const bytes = Buffer.allocUnsafe(Math.min(max + 1, stat.size + 1));
		const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
		if (count > max) throw new Error("Слишком большой файл реестра OMP");
		return JSON.parse(bytes.subarray(0, count).toString("utf8"));
	} finally {
		fs.closeSync(fd);
	}
}

/** A runtime owns only its manifest/socket. Disconnection never means terminal closure. */
export class WindowSessions implements vscode.Disposable {
	private readonly ownerId = crypto.randomBytes(12).toString("hex");
	private readonly startedAt = Date.now();
	private readonly ownerLabel: string;
	private readonly dir: string;
	private readonly socketDir: string;
	private readonly socketPath: string;
	private readonly manifestPath: string;
	private server: net.Server | undefined;
	private readonly watchers: fs.FSWatcher[] = [];
	private readonly connections = new Set<net.Socket>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly manifests = new Map<string, Manifest>();
	private readonly hooks = new Map<string, Hook>();
	private readonly ownClaims = new Map<string, Claim>();
	private readonly releases = new Map<string, Release>();
	private readonly failedOwners = new Map<string, number>();
	private reservations = new Map<string, Reservation>();
	private readonly ownReservations = new Map<string, HeldReservation>();
	private readonly identities = new Map<string, string>();
	private readonly identityCache = new Map<string, string | null>();
	private identityCacheUntil = 0;
	private visible = new Map<string, VisibleSession>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private heartbeat: NodeJS.Timeout | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private signature = "";
	private published = "";
	private ready = false;
	private healthy = false;
	private disposed = false;
	private readonly warned = new Set<string>();

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly tracker: TerminalTracker,
		private readonly attention: SessionAttention,
		private readonly index: SessionCatalog,
	) {
		this.disposables.push(
			index.onDidChangeFiles((file) => {
				if (file === undefined) this.identityCache.clear();
				else {
					const normalized = normPath(file);
					for (const [key, canonical] of this.identityCache) if (key === normalized || canonical === normalized) this.identityCache.delete(key);
				}
			}),
		);
		this.ownerLabel = vscode.workspace.name || path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "") || "окно VS Code";
		this.dir = path.join(agentDir(), "vscode-windows");
		// macOS sockaddr_un has a short path limit. The registry always stays in agentDir;
		// only long-path sockets use a deterministic, user-private local directory.
		const direct = path.join(this.dir, `${this.ownerId}.sock`);
		const hash = crypto.createHash("sha256").update(normPath(this.dir)).digest("hex").slice(0, 20);
		this.socketDir =
			Buffer.byteLength(direct) < 100 ? this.dir : path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `omp-windows-${process.getuid?.() ?? "user"}-${hash}`);
		this.socketPath = path.join(this.socketDir, `${this.ownerId}.sock`);
		this.manifestPath = path.join(this.dir, `${this.ownerId}.json`);
	}

	async start(): Promise<void> {
		try {
			privateDirectory(this.dir);
			if (this.socketDir !== this.dir) privateDirectory(this.socketDir);
			fs.mkdirSync(terminalMapDir(), { recursive: true });
			const server = net.createServer((socket) => this.accept(socket));
			this.server = server;
			server.maxConnections = 32;
			server.on("error", (err) => {
				this.ready = false;
				this.warn("socket", err);
				this.queueRefresh();
			});
			await new Promise<void>((resolve, reject) => {
				const failed = (err: Error) => reject(err);
				server.once("error", failed);
				server.listen(this.socketPath, () => {
					server.removeListener("error", failed);
					try {
						fs.chmodSync(this.socketPath, 0o600);
						this.ready = true;
						resolve();
					} catch (err) {
						reject(err);
					}
				});
			});
		} catch (err) {
			this.ready = false;
			this.warn("start", err);
		}
		this.disposables.push(
			this.tracker.onDidChange(() => this.queueRefresh()),
			this.attention.onDidChange(() => this.queueRefresh()),
			this.index.onDidChange(() => this.queueRefresh()),
			this.tracker.onDidReleaseSession((entry) => this.onRelease(entry)),
		);
		for (const dir of [this.dir, terminalMapDir()]) {
			try {
				const watcher = fs.watch(dir, () => this.queueRefresh());
				watcher.on("error", (err) => {
					watcher.close();
					this.warn(`watch:${dir}`, err);
				});
				this.watchers.push(watcher);
			} catch (err) {
				this.warn(`watch:${dir}`, err);
			}
		}
		this.refresh(true);
		this.heartbeat = setInterval(() => this.refresh(true), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	private onRelease(entry: ReleasedSession): void {
		if (!validKey(entry.terminalKey)) return;
		const claim: Ordered & { terminalKey: string; file: string; agentPid?: number } = this.ownClaims.get(entry.terminalKey) ?? {
			terminalKey: entry.terminalKey,
			ownerId: this.ownerId,
			adoptedAt: this.startedAt,
			file: entry.sessionFile,
		};
		if (!entry.sessionFile || this.identity(claim.file) === this.identity(entry.sessionFile)) {
			this.release(claim, this.hooks.get(entry.terminalKey)?.pid);
			this.ownClaims.delete(entry.terminalKey);
			if (this.publish(true))
				for (const [file, held] of this.ownReservations) if (held.pending && held.terminalKey === entry.terminalKey) this.finishReservation(file, held.token);
		}
		this.queueRefresh();
	}

	private warn(key: string, err: unknown): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.tracker.log.warn(`Общий реестр окон OMP: ${(err as Error)?.message || String(err)}`);
	}

	private queueRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh();
		}, 20);
		this.refreshTimer.unref?.();
	}

	private readHooks(): void {
		let names: string[];
		try {
			names = fs.readdirSync(terminalMapDir());
		} catch (err) {
			this.healthy = false;
			this.warn("hooks", err);
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const key = name.slice(0, -5);
			if (!validKey(key)) continue;
			try {
				const rec = readJson(path.join(terminalMapDir(), name), 64 * 1024);
				if (!validFile(rec?.sessionFile) || !positive(rec.pid)) throw new Error("Неполная запись живого терминала OMP");
				this.hooks.set(key, {
					terminalKey: key,
					file: normPath(rec.sessionFile),
					pid: rec.pid,
					cwd: typeof rec.cwd === "string" ? rec.cwd : "",
					id: typeof rec.sessionId === "string" ? rec.sessionId : "",
				});
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					this.healthy = false;
					this.warn(`hook:${key}`, err);
				}
			}
		}
		// There is deliberately no updatedAt TTL: an idle OMP can keep the same report for days.
		for (const [key, hook] of this.hooks) if (alive(hook.pid) === false) this.hooks.delete(key);
	}

	private readManifests(): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch (err) {
			this.healthy = false;
			this.warn("registry", err);
			return;
		}
		const seen = new Set<string>();
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const ownerId = name.slice(0, -5);
			if (!OWNER_RE.test(ownerId) || ownerId === this.ownerId) continue;
			seen.add(ownerId);
			try {
				const rec = readJson(path.join(this.dir, name), MAX_MANIFEST);
				if (
					rec?.version !== VERSION ||
					rec.ownerId !== ownerId ||
					!positive(rec.startedAt) ||
					!positive(rec.hostPid) ||
					!Array.isArray(rec.sessions) ||
					!Array.isArray(rec.releases)
				)
					throw new Error("Неполная запись окна OMP");
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const sessions: Claim[] = rec.sessions.map((entry: any) => {
					if (!validFile(entry?.file) || !validKey(entry.terminalKey) || !positive(entry.adoptedAt)) throw new Error("Неполная запись владельца сессии OMP");
					if (validFile(entry.canonicalFile)) this.identities.set(normPath(entry.file), normPath(entry.canonicalFile));
					return {
						...entry,
						file: normPath(entry.file),
						ownerId,
						state: STATES.has(entry.state) ? entry.state : "unknown",
						pid: positive(entry.pid),
						agentPid: positive(entry.agentPid),
					};
				});
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const releases: Release[] = rec.releases.map((entry: any) => {
					if (!validKey(entry?.terminalKey) || !positive(entry.adoptedAt) || !OWNER_RE.test(entry.ownerId)) throw new Error("Неполная запись закрытия OMP");
					return { terminalKey: entry.terminalKey, adoptedAt: entry.adoptedAt, ownerId: entry.ownerId, agentPid: positive(entry.agentPid) };
				});
				this.manifests.set(ownerId, {
					ownerId,
					startedAt: rec.startedAt,
					hostPid: rec.hostPid,
					heartbeat: positive(rec.heartbeat) ?? 0,
					active: rec.active === true,
					ownerLabel: typeof rec.ownerLabel === "string" ? rec.ownerLabel.slice(0, 240) : "окно VS Code",
					sessions,
					releases,
				});
			} catch (err) {
				this.healthy = false;
				const previous = this.manifests.get(ownerId);
				if (previous) previous.active = false;
				this.warn(`manifest:${ownerId}`, err);
			}
		}
		// An unexpectedly missing manifest is not a terminal-close acknowledgement.
		for (const [ownerId, rec] of this.manifests) if (ownerId !== this.ownerId && !seen.has(ownerId)) rec.active = false;
	}

	/**
	 * Canonical (symlink-resolved) session path. `cached`: accept a lookup from the last few
	 * seconds, for hot render paths; ownership decisions always pass `false`.
	 */
	identity(file: string, cached = false): string {
		const normalized = normPath(file);
		const now = Date.now();
		if (now >= this.identityCacheUntil) {
			this.identityCache.clear();
			this.identityCacheUntil = now + 5000;
		}
		if (cached && this.identityCache.has(normalized)) return this.identityCache.get(normalized) ?? this.identities.get(normalized) ?? normalized;
		try {
			const canonical = normPath(fs.realpathSync(normalized));
			this.identities.set(normalized, canonical);
			this.identityCache.set(normalized, canonical);
			return canonical;
		} catch {
			// Cache the failed lookup, not ownership evidence that can still change.
			this.identityCache.set(normalized, null);
			return this.identities.get(normalized) ?? normalized;
		}
	}

	private reservationPath(file: string): string {
		const hash = crypto.createHash("sha256").update(file).digest("hex");
		return path.join(this.dir, `${hash}.launch`);
	}

	private readReservations(): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch (err) {
			this.healthy = false;
			this.warn("reservations", err);
			return;
		}
		const next = new Map<string, Reservation>();
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.launch$/.test(name)) continue;
			try {
				const rec = readJson(path.join(this.dir, name), 64 * 1024);
				if (
					rec?.version !== VERSION ||
					!validFile(rec.file) ||
					normPath(rec.file) !== rec.file ||
					path.basename(this.reservationPath(rec.file)) !== name ||
					!OWNER_RE.test(rec.ownerId) ||
					typeof rec.token !== "string" ||
					!/^[a-f0-9]{32}$/.test(rec.token) ||
					!positive(rec.hostPid) ||
					!positive(rec.createdAt)
				)
					throw new Error("Неполная запись запуска OMP");
				next.set(rec.file, {
					file: rec.file,
					ownerId: rec.ownerId,
					token: rec.token,
					hostPid: rec.hostPid,
					createdAt: rec.createdAt,
					ownerLabel: typeof rec.ownerLabel === "string" ? rec.ownerLabel.slice(0, 240) : "окно VS Code",
					terminalKey: validKey(rec.terminalKey) ? rec.terminalKey : undefined,
				});
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				this.healthy = false;
				this.warn(`reservation:${name}`, err);
				for (const [file, rec] of this.reservations) if (path.basename(this.reservationPath(file)) === name) next.set(file, rec);
			}
		}
		// A reservation has no timeout. A crashed host may have launched OMP before it
		// could publish a PID, so a dead host alone is never evidence that this is free.
		this.reservations = next;
	}

	async reserveLaunch(file: string): Promise<string> {
		if (this.disposed || !this.ready || !validFile(file)) throw new Error("Не удалось безопасно зарезервировать запуск OMP. Копия не запущена.");
		file = this.identity(file);
		if (this.ownReservations.has(file)) throw new Error("Эта сессия OMP уже запускается в этом окне.");
		this.refresh();
		if (!this.healthy || this.visible.has(file)) throw new Error("Сессия уже работает, запускается или не подтверждена закрытой. Копия OMP не запущена.");
		const token = crypto.randomBytes(16).toString("hex");
		const rec: Reservation = { version: VERSION, file, ownerId: this.ownerId, ownerLabel: this.ownerLabel, token, hostPid: process.pid, createdAt: Date.now() };
		const lock = this.reservationPath(file);
		let fd: number | undefined;
		let created = false;
		try {
			fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
			created = true;
			fs.writeFileSync(fd, JSON.stringify(rec));
		} catch (err) {
			if (created)
				try {
					fs.rmSync(lock);
				} catch {
					// Best effort: a leftover lock blocks launches, never duplicates them.
				}
			this.refresh();
			throw new Error(
				(err as NodeJS.ErrnoException).code === "EEXIST"
					? "Запуск этой сессии уже зарезервирован другим запросом. Новый OMP не запущен."
					: "Не удалось безопасно зарезервировать запуск OMP. Новый OMP не запущен.",
			);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
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

	private writeReservation(file: string, held: HeldReservation, updates: Partial<Reservation>): Reservation | undefined {
		const lock = this.reservationPath(file);
		const tmp = path.join(this.dir, `${this.ownerId}.${crypto.randomBytes(4).toString("hex")}.tmp`);
		try {
			const rec = readJson(lock, 64 * 1024);
			if (rec.ownerId !== this.ownerId || rec.token !== held.token || rec.file !== file) return undefined;
			const next = { ...rec, ...updates };
			fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, lock);
			this.reservations.set(file, next);
			return next;
		} catch (err) {
			this.healthy = false;
			this.warn(`reservation-write:${held.token}`, err);
			return undefined;
		} finally {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// A stray temp file is harmless.
			}
		}
	}

	private finishReservation(file: string, token: string): boolean {
		const held = this.ownReservations.get(file);
		if (!held || held.token !== token) return false;
		try {
			const rec = readJson(this.reservationPath(file), 64 * 1024);
			if (rec.ownerId !== this.ownerId || rec.token !== token || rec.file !== file) return false;
			fs.rmSync(this.reservationPath(file));
			this.ownReservations.delete(file);
			this.reservations.delete(file);
			return true;
		} catch (err) {
			this.healthy = false;
			this.warn(`reservation-release:${token}`, err);
			return false;
		}
	}

	private bindReservation(file: string, held: HeldReservation, terminalKey: string): void {
		if (held.terminalKey) return;
		held.terminalKey = terminalKey;
		this.writeReservation(file, held, { terminalKey });
	}

	releaseLaunch(file: string, token: unknown, _registered: boolean, failedBeforeCreation = false, terminalKey?: string): void {
		if (!validFile(file)) return;
		file = this.identity(file);
		const held = this.ownReservations.get(file);
		if (!held || held.token !== token) return;
		if (failedBeforeCreation) {
			this.finishReservation(file, held.token);
			this.refresh();
			return;
		}
		held.pending = true;
		if (validKey(terminalKey)) this.bindReservation(file, held, terminalKey);
		// VS Code can expose the new terminal after launch() returns. Keep the lock
		// until a later refresh can publish that exact local terminal, not just a flag.
		this.refresh();
	}

	private settleReservations(published: boolean, local: Map<string, OpenSession>): void {
		if (!published) return;
		let saved = false;
		for (const [file, held] of this.ownReservations) {
			if (!held.pending || !held.terminalKey) continue;
			let entry: OpenSession | undefined;
			for (const [candidate, value] of local)
				if (value.terminalKey === held.terminalKey && this.identity(candidate) === file) {
					entry = value;
					break;
				}
			const claim = entry && this.ownClaims.get(entry.terminalKey);
			if (claim && this.identity(claim.file) === file && claim.available && this.terminalAlive(entry)) {
				if (!saved) {
					if (!this.publish(true)) return;
					saved = true;
				}
				this.finishReservation(file, held.token);
			}
		}
	}

	private localEntries(): Map<string, OpenSession> {
		const out = new Map<string, OpenSession>();
		for (const [file, entry] of this.tracker.openSessions()) {
			if (!validFile(file) || !validKey(entry.terminalKey)) continue;
			out.set(normPath(file), entry);
		}
		return out;
	}

	private terminalAlive(entry: OpenSession | undefined): boolean {
		return !!entry?.terminal && entry.terminal.exitStatus === undefined && vscode.window.terminals.includes(entry.terminal) && alive(entry.pid) !== false;
	}

	private collectLocal(): Map<string, OpenSession> {
		const local = this.localEntries();
		const keys = new Set<string>();
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
			if (!previous && released && (!matchingHook || matchingHook.pid === released.agentPid)) continue;
			if (!previous && released) adoptedAt = Math.max(Date.now(), (released.adoptedAt as number) + 1);
			if (previous?.agentPid && matchingHook && previous.agentPid !== matchingHook.pid) adoptedAt = Math.max(Date.now(), previous.adoptedAt + 1);
			const claim: Claim = {
				file,
				canonicalFile: this.identity(file),
				terminalKey: key,
				ownerId: this.ownerId,
				adoptedAt,
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
			} else {
				this.ownClaims.set(key, claim);
			}
		}
		for (const [key, claim] of this.ownClaims) {
			if (keys.has(key)) continue;
			if (alive(claim.agentPid ?? claim.pid) === false) {
				this.release(claim);
				this.ownClaims.delete(key);
			} else {
				// Tracker disappearance without a real-close event is retained as blocked evidence.
				claim.available = false;
				claim.state = "unknown";
				claim.launching = false;
			}
		}
		return local;
	}

	private release(claim: Ordered & { terminalKey?: string; agentPid?: number }, agentPid?: number): void {
		const terminalKey = claim.terminalKey as string;
		const previous = this.releases.get(terminalKey);
		if (!previous || order(claim, previous) > 0)
			this.releases.set(terminalKey, { terminalKey, adoptedAt: claim.adoptedAt, ownerId: claim.ownerId, agentPid: positive(agentPid) ?? claim.agentPid });
		else if (order(claim, previous) === 0 && !previous.agentPid) previous.agentPid = positive(agentPid) ?? claim.agentPid;
	}

	private ownManifest(): Manifest {
		return {
			version: VERSION,
			ownerId: this.ownerId,
			startedAt: this.startedAt,
			hostPid: process.pid,
			heartbeat: Date.now(),
			active: this.ready && !this.disposed,
			ownerLabel: this.ownerLabel,
			sessions: [...this.ownClaims.values()],
			releases: [...this.releases.values()],
		};
	}

	private publish(force = false): boolean {
		const rec = this.ownManifest();
		const signature = JSON.stringify({ ...rec, heartbeat: 0 });
		this.manifests.set(this.ownerId, rec);
		if (!force && signature === this.published) return true;
		const tmp = path.join(this.dir, `${this.ownerId}.${crypto.randomBytes(4).toString("hex")}.tmp`);
		try {
			const json = JSON.stringify(rec);
			if (Buffer.byteLength(json) > MAX_MANIFEST) throw new Error("Реестр этого окна OMP превысил безопасный размер");
			fs.writeFileSync(tmp, json, { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, this.manifestPath);
			this.published = signature;
			return true;
		} catch (err) {
			this.healthy = false;
			this.warn("publish", err);
			return false;
		} finally {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// A stray temp file is harmless.
			}
		}
	}

	private fresh(rec: Manifest): boolean {
		const age = Date.now() - rec.heartbeat;
		const failedAt = this.failedOwners.get(rec.ownerId);
		return rec.active && age >= -HEARTBEAT_MS && age < FRESH_MS && alive(rec.hostPid) === true && (failedAt === undefined || rec.heartbeat > failedAt);
	}

	private buildVisible(local: Map<string, OpenSession>, ignoredReservationToken?: string): Map<string, VisibleSession> {
		const winners = new Map<string, { claim: Claim; rec: Manifest }>();
		const released = new Map<string, Release | undefined>();
		for (const rec of this.manifests.values()) {
			for (const entry of rec.releases) {
				const old = released.get(entry.terminalKey);
				if (!old || order(entry, old) > 0) released.set(entry.terminalKey, entry);
			}
			for (const claim of rec.sessions) {
				const old = winners.get(claim.terminalKey);
				if (!old || order(claim, old.claim) > 0) winners.set(claim.terminalKey, { claim, rec });
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
		const byFile = new Map<string, VisibleSession[]>();
		const add = (descriptor: VisibleSession) => {
			const identity = this.identity(descriptor.file);
			const list = byFile.get(identity) ?? [];
			list.push(descriptor);
			byFile.set(identity, list);
		};
		for (const [key, { claim, rec }] of winners) {
			const exactLocal = rec.ownerId === this.ownerId && local.get(claim.file)?.terminalKey === key && this.terminalAlive(local.get(claim.file));
			const kind: SessionKind = exactLocal && claim.available ? "local" : rec.ownerId !== this.ownerId && claim.available && this.fresh(rec) ? "remote" : "unavailable";
			add({
				file: claim.file,
				id: claim.id || path.basename(claim.file, ".jsonl"),
				title: claim.title || path.basename(claim.file, ".jsonl"),
				cwd: claim.cwd || "",
				state: kind === "unavailable" ? "unknown" : claim.state,
				launching: kind !== "unavailable" && claim.launching === true,
				unreadCompletion: claim.unreadCompletion === true,
				ownerId: rec.ownerId,
				ownerLabel: rec.ownerLabel,
				terminalKey: key,
				kind,
				adoptedAt: claim.adoptedAt,
			});
		}
		for (const [key, hook] of this.hooks) {
			if (alive(hook.pid) === false) continue;
			const winner = winners.get(key);
			if (winner && this.identity(winner.claim.file) === this.identity(hook.file) && (!winner.claim.agentPid || winner.claim.agentPid === hook.pid)) continue;
			const tombstone = released.get(key);
			if (!winner && tombstone?.agentPid === hook.pid) continue;
			const info = this.index.find(hook.file);
			add({
				file: hook.file,
				id: info?.id || hook.id || path.basename(hook.file, ".jsonl"),
				title: info?.title || path.basename(hook.file, ".jsonl"),
				cwd: hook.cwd || info?.cwd || "",
				state: "unknown",
				launching: false,
				unreadCompletion: false,
				ownerId: winner?.rec.ownerId || "",
				ownerLabel: winner?.rec.ownerLabel || "окно недоступно",
				terminalKey: key,
				kind: "unavailable",
			});
		}
		for (const reservation of this.reservations.values()) {
			if (reservation.ownerId === this.ownerId && reservation.token === ignoredReservationToken) continue;
			const info = this.index.find(reservation.file);
			add({
				file: reservation.file,
				id: info?.id || path.basename(reservation.file, ".jsonl"),
				title: info?.title || path.basename(reservation.file, ".jsonl"),
				cwd: info?.cwd || "",
				state: "unknown",
				launching: false,
				unreadCompletion: false,
				ownerId: reservation.ownerId,
				ownerLabel: reservation.ownerLabel,
				terminalKey: `launch-${reservation.token}`,
				kind: "unavailable",
				reason: "Запуск этой сессии зарезервирован окном VS Code. Повторный запуск OMP заблокирован.",
			});
		}
		const out = new Map<string, VisibleSession>();
		for (const [file, candidates] of byFile) {
			const distinct = new Set(candidates.map((entry) => entry.terminalKey));
			const value = candidates.find((entry) => entry.kind === "local") || candidates[0];
			out.set(
				file,
				distinct.size > 1 || candidates.some((entry) => entry.kind === "unavailable" && entry.terminalKey === value.terminalKey && entry !== value)
					? { ...value, kind: "unavailable", state: "unknown", launching: false, ambiguous: distinct.size > 1 }
					: value,
			);
		}
		return out;
	}

	private refresh(force = false): void {
		if (this.disposed) return;
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
		} catch (err) {
			this.healthy = false;
			this.warn("refresh", err);
		}
	}

	/** Canonical session file -> the session's live owner, across every local VS Code window. */
	sessions(): Map<string, VisibleSession> {
		return new Map(this.visible);
	}

	private unavailable(file: string, expected: SessionTarget | undefined, reason: string): UnavailableTarget {
		return {
			...(this.visible.get(validFile(file) ? this.identity(file) : file) ?? {}),
			file,
			kind: "unavailable",
			state: "unknown",
			launching: false,
			...(expected?.ownerId ? { ownerId: expected.ownerId } : {}),
			...(expected?.terminalKey ? { terminalKey: expected.terminalKey } : {}),
			reason,
		};
	}

	async resolve(file: string, expected?: SessionTarget): Promise<Resolution> {
		if (!validFile(file)) return this.unavailable(String(file), expected, "Некорректный путь сессии OMP");
		file = normPath(file);
		this.refresh();
		let target = this.visible.get(this.identity(file));
		if ((expected?.ownerId && target?.ownerId !== expected.ownerId) || (expected?.terminalKey && target?.terminalKey !== expected.terminalKey))
			return this.unavailable(file, expected, "Выбранное окно или терминал уже изменились. Обновите список сессий; копия OMP не запущена.");
		if (!target)
			return expected?.ownerId || expected?.terminalKey
				? this.unavailable(file, expected, "Выбранный терминал больше не доступен; автоматический повторный запуск запрещён.")
				: this.healthy
					? { kind: "closed", file }
					: this.unavailable(file, expected, "Не удалось проверить общий реестр окон. Повторный запуск OMP заблокирован.");
		if (target.kind !== "remote") return target;
		const remote = target;
		try {
			const response = await this.request(target, "inspect");
			if (response.status === "owned") return target;
			if (response.status === "released") {
				this.release(target, response.agentPid);
				this.publish();
				this.refresh();
				target = this.visible.get(this.identity(file));
				return (
					target ||
					(expected?.ownerId || expected?.terminalKey
						? this.unavailable(file, expected, "Выбранный терминал закрыт; повторный запуск по устаревшей ссылке запрещён.")
						: this.healthy
							? { kind: "closed", file }
							: this.unavailable(file, expected, "Не удалось проверить общий реестр окон."))
				);
			}
			return this.unavailable(file, expected, response.reason || "Владелец не подтвердил выбранный терминал. Копия OMP не запущена.");
		} catch {
			this.failedOwners.set(remote.ownerId, this.manifests.get(remote.ownerId)?.heartbeat ?? Date.now());
			this.refresh();
			return this.unavailable(file, expected, "Окно с этой сессией не отвечает. Сессия может продолжать работать; повторный запуск OMP заблокирован.");
		}
	}

	async canRestore(file: string): Promise<boolean> {
		return (await this.resolve(file)).kind === "closed";
	}

	/** tracker.sessionRouter: true when an existing owner handled the open. */
	async route(opts: LaunchOptions): Promise<boolean> {
		const target = await this.resolve(opts.sessionFile as string, opts);
		if (target.kind === "closed") return false;
		if (target.kind === "unavailable")
			throw new Error(
				target.reason ||
					(target.ambiguous
						? "Несколько терминалов заявили одну сессию. Повторный запуск OMP заблокирован."
						: "Сессия связана с недоступным окном или живым процессом OMP. Дождитесь подключения владельца; копия не запущена."),
			);
		if (target.kind === "local") {
			await this.tracker.focusExisting({ ...opts, sessionFile: target.file, terminalKey: target.terminalKey });
			await vscode.commands.executeCommand("workbench.action.focusWindow");
			return true;
		}
		try {
			const response = await this.request(target, "focus", opts);
			if (response.status !== "focused") throw new Error(response.reason || "Владелец отказался переключать изменившийся терминал. Копия OMP не запущена.");
			return true;
		} catch (err) {
			this.failedOwners.set(target.ownerId, this.manifests.get(target.ownerId)?.heartbeat ?? Date.now());
			this.refresh();
			throw new Error(`Не удалось переключиться в окно с сессией OMP. Повторный запуск запрещён: ${(err as Error).message}`);
		}
	}

	private request(target: VisibleSession, op: WindowRequest["op"], opts: LaunchOptions = {}): Promise<WindowReply> {
		return new Promise((resolve, reject) => {
			const requestId = crypto.randomUUID();
			const socketPath = path.join(this.socketDir, `${target.ownerId}.sock`);
			const socket = net.createConnection(socketPath);
			let bytes = 0;
			const chunks: Buffer[] = [];
			let settled = false;
			const finish = (err: unknown, response?: WindowReply) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (err) reject(err);
				else resolve(response as WindowReply);
			};
			const timer = setTimeout(() => finish(new Error("Окно-владелец не подтвердило запрос вовремя")), REQUEST_MS);
			socket.on("error", (err) => finish(err));
			socket.on("close", () => finish(new Error("Окно-владелец разорвало соединение без подтверждения")));
			socket.on("connect", () => {
				const message =
					JSON.stringify({
						version: VERSION,
						requestId,
						op,
						ownerId: target.ownerId,
						file: target.file,
						terminalKey: target.terminalKey,
						adoptedAt: target.adoptedAt,
						location: opts.location === "panel" || opts.location === "editor" ? opts.location : undefined,
						preserveFocus: opts.preserveFocus === true,
					}) + "\n";
				if (Buffer.byteLength(message) > MAX_MESSAGE) return finish(new Error("Слишком большой запрос окна OMP"));
				socket.write(message);
			});
			socket.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_MESSAGE) return finish(new Error("Слишком большой ответ окна OMP"));
				chunks.push(chunk);
				if (!chunk.includes(10)) return;
				try {
					const response = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8").trim());
					if (
						response?.version !== VERSION ||
						response.requestId !== requestId ||
						response.ownerId !== target.ownerId ||
						response.file !== target.file ||
						response.terminalKey !== target.terminalKey
					)
						throw new Error("Ответ не соответствует выбранному терминалу OMP");
					finish(undefined, response);
				} catch (err) {
					finish(err);
				}
			});
		});
	}

	private accept(socket: net.Socket): void {
		this.connections.add(socket);
		const deadline = setTimeout(() => socket.destroy(), REQUEST_MS);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			clearTimeout(deadline);
			this.connections.delete(socket);
		});
		let bytes = 0;
		const chunks: Buffer[] = [];
		let received = false;
		socket.on("data", (chunk: Buffer) => {
			if (received) return socket.destroy();
			bytes += chunk.length;
			if (bytes > MAX_MESSAGE) return socket.destroy();
			chunks.push(chunk);
			if (!chunk.includes(10)) return;
			received = true;
			let request: WindowRequest;
			try {
				request = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8").trim());
				if (
					request?.version !== VERSION ||
					typeof request.requestId !== "string" ||
					request.requestId.length > 64 ||
					request.ownerId !== this.ownerId ||
					!validFile(request.file) ||
					normPath(request.file) !== request.file ||
					!validKey(request.terminalKey) ||
					!positive(request.adoptedAt) ||
					!["inspect", "focus"].includes(request.op) ||
					(request.location !== undefined && !["panel", "editor"].includes(request.location))
				)
					throw new Error("Недопустимый запрос окна OMP");
			} catch {
				socket.destroy();
				return;
			}
			void this.answer(request, socket)
				.then((reply) => {
					if (!socket.destroyed) this.reply(socket, request, reply);
				})
				.catch(() => {
					if (!socket.destroyed) this.reply(socket, request, { status: "refused", reason: "Не удалось подтвердить существующий терминал; OMP не запущен повторно." });
				});
		});
	}

	private reply(socket: net.Socket, request: WindowRequest, reply: WindowReply): void {
		const message = JSON.stringify({ version: VERSION, requestId: request.requestId, ownerId: this.ownerId, file: request.file, terminalKey: request.terminalKey, ...reply }) + "\n";
		if (Buffer.byteLength(message) > MAX_MESSAGE) socket.destroy();
		else socket.end(message);
	}

	private async answer(request: WindowRequest, socket: net.Socket): Promise<WindowReply> {
		this.refresh();
		const claim = this.ownClaims.get(request.terminalKey);
		const entry = this.localEntries().get(request.file);
		const released = this.releases.get(request.terminalKey);
		if (released && order({ adoptedAt: request.adoptedAt, ownerId: this.ownerId }, released) <= 0) return { status: "released", agentPid: released.agentPid };
		if (
			this.disposed ||
			!claim ||
			claim.file !== request.file ||
			claim.adoptedAt !== request.adoptedAt ||
			!claim.available ||
			entry?.terminalKey !== request.terminalKey ||
			!this.terminalAlive(entry) ||
			alive(claim.agentPid) === false ||
			socket.destroyed
		)
			return { status: "refused", reason: "Выбранный терминал больше не принадлежит этому окну или не подтверждён живым. Копия OMP не запущена." };
		const winner = this.visible.get(this.identity(request.file));
		if (winner?.kind !== "local" || winner.ownerId !== this.ownerId || winner.terminalKey !== request.terminalKey)
			return { status: "refused", reason: "Владение сессией изменилось или неоднозначно. Копия OMP не запущена." };
		if (request.op === "inspect") return { status: "owned" };
		await this.tracker.focusExisting({ sessionFile: request.file, terminalKey: request.terminalKey, location: request.location, preserveFocus: request.preserveFocus === true });
		const current = this.localEntries().get(request.file);
		if (socket.destroyed || this.disposed || current?.terminalKey !== request.terminalKey || !this.terminalAlive(current) || alive(claim.agentPid) === false)
			return { status: "refused", reason: "Запрос переключения устарел." };
		await vscode.commands.executeCommand("workbench.action.focusWindow");
		return { status: "focused" };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.heartbeat);
		clearTimeout(this.refreshTimer);
		for (const watcher of this.watchers) watcher.close();
		for (const disposable of this.disposables) disposable.dispose();
		// Keep both claims and close tombstones. A stopped extension host is not a stopped OMP.
		this.publish(true);
		this.identityCache.clear();
		for (const socket of this.connections) socket.destroy();
		this.server?.close();
		try {
			if (fs.lstatSync(this.socketPath).isSocket()) fs.rmSync(this.socketPath);
		} catch {
			// Already gone.
		}
		this.changed.dispose();
	}
}
