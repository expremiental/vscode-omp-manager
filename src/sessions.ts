import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import * as vscode from "vscode";
import { isWithin, normPath, sessionsDir } from "./config";

/** Which CLI agent wrote a transcript, and so how to resume it. */
export type AgentKind = "omp" | "claude";

export interface SessionInfo {
	agent: AgentKind;
	id: string;
	file: string;
	cwd: string;
	/** Shown in lists; a placeholder when the session is empty. */
	title: string;
	/** No title and no prompt yet. Lists skip these unless `omp.sessions.showEmpty` is on. */
	empty: boolean;
	created: number;
	modified: number;
}

interface CacheEntry {
	mtimeMs: number;
	info: SessionInfo | null;
}

// The title and session header are the first two lines; the first prompt usually
// follows within a few KB. Title lines are padded so omp can rewrite them in place.
const HEAD_BYTES = 16 * 1024;
const FIRST_PROMPT_RE = /"role":"user","content":\[\{"type":"text","text":"((?:[^"\\]|\\.)*)/;
const DEBOUNCE_MS = 1000;
// Files parsed between yields to the event loop during a full scan. Each parse is a stat
// and a 16KB read, so a chunk stays well under a frame even on a slow disk.
const SCAN_CHUNK = 25;
const EMPTY_TITLE = "(empty session)";

function readHead(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(HEAD_BYTES);
		const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Title, header, and first prompt from a session file's head; null for foreign files. */
export function parseSession(file: string, mtimeMs: number): SessionInfo | null {
	const head = readHead(file);
	let title = "";
	let header: { id?: unknown; cwd?: unknown; timestamp?: unknown; title?: unknown } | undefined;
	for (const line of head.split("\n", 3)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "title" && typeof entry.title === "string") title = entry.title;
			else if (entry?.type === "session") header = entry;
		} catch {
			// partial or foreign line
		}
	}
	if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return null;
	if (!title && typeof header.title === "string") title = header.title;
	if (!title) {
		// Untitled sessions fall back to the first prompt; sessions without one are empty.
		const m = FIRST_PROMPT_RE.exec(head);
		if (m) {
			try {
				title = JSON.parse(`"${m[1]}"`);
			} catch {
				title = m[1];
			}
		}
	}
	const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
	return {
		agent: "omp",
		id: header.id,
		file,
		cwd: header.cwd,
		title: title ? oneLine(title) : EMPTY_TITLE,
		empty: !title,
		created: Number.isFinite(created) ? created : mtimeMs,
		modified: mtimeMs,
	};
}

// Claude Code transcripts open with metadata records (mode, owner, file snapshots) whose
// size varies, so the head is read in chunks until the first real prompt shows up.
const CLAUDE_CHUNK = 64 * 1024;
const CLAUDE_HEAD_MAX = 1024 * 1024;
// Claude appends `ai-title` / `custom-title` records as the session goes; the latest wins.
const CLAUDE_TAIL = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRange(fd: number, start: number, length: number): string {
	const buf = Buffer.allocUnsafe(length);
	const n = fs.readSync(fd, buf, 0, length, start);
	return buf.subarray(0, n).toString("utf8");
}

/** Complete JSON lines of `text`; a cut-off first or last line is dropped. */
function* records(text: string, skipFirst: boolean): Generator<Record<string, unknown>> {
	const lines = text.split("\n");
	if (skipFirst) lines.shift();
	for (const line of lines) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry && typeof entry === "object") yield entry;
		} catch {
			// partial line at a chunk edge
		}
	}
}

/** The text a user typed, or "" for tool results, slash-command echoes and other plumbing. */
function promptText(entry: Record<string, unknown>): string {
	if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return "";
	const message = entry.message as { content?: unknown } | undefined;
	let text = "";
	if (typeof message?.content === "string") text = message.content;
	else if (Array.isArray(message?.content)) {
		const block = message.content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
		text = block?.text ?? "";
	}
	text = text.trim();
	// `<command-name>`, `<local-command-stdout>` and similar wrap slash commands, not prompts.
	return /^<[a-z-]+>/.test(text) ? "" : text;
}

function titleOf(entry: Record<string, unknown>): { custom?: string; ai?: string } {
	if (entry.type === "custom-title") {
		const title = entry.customTitle ?? entry.title;
		return typeof title === "string" && title.trim() ? { custom: title } : {};
	}
	if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) return { ai: entry.aiTitle };
	return {};
}

/** Claude Code transcript: id, cwd and start from the head, title from the tail. Null for foreign files. */
export function parseClaudeSession(file: string, mtimeMs: number): SessionInfo | null {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		let id: string | undefined;
		let cwd: string | undefined;
		let timestamp: string | undefined;
		let prompt = "";
		let custom: string | undefined;
		let ai: string | undefined;
		let carry = "";
		let offset = 0;
		while (offset < Math.min(size, CLAUDE_HEAD_MAX) && !(id && cwd && prompt)) {
			const text = carry + readRange(fd, offset, CLAUDE_CHUNK);
			offset += CLAUDE_CHUNK;
			const cut = offset < size ? text.lastIndexOf("\n") + 1 : text.length;
			carry = text.slice(cut);
			for (const entry of records(text.slice(0, cut), false)) {
				if (!id && typeof entry.sessionId === "string") id = entry.sessionId;
				if (!cwd && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
				if (!timestamp && typeof entry.timestamp === "string") timestamp = entry.timestamp;
				if (!prompt) prompt = promptText(entry);
				const t = titleOf(entry);
				custom = t.custom ?? custom;
				ai = t.ai ?? ai;
			}
		}
		if (offset < size) {
			const start = Math.max(offset, size - CLAUDE_TAIL);
			for (const entry of records(readRange(fd, start, size - start), start > 0)) {
				const t = titleOf(entry);
				custom = t.custom ?? custom;
				ai = t.ai ?? ai;
			}
		}
		const base = path.basename(file, ".jsonl");
		if (!cwd || !(id || UUID_RE.test(base))) return null;
		const title = custom || ai || prompt;
		const created = timestamp ? Date.parse(timestamp) : NaN;
		return {
			agent: "claude",
			// `claude --resume` takes the id the file is named after.
			id: UUID_RE.test(base) ? base : (id as string),
			file,
			cwd,
			title: title ? oneLine(title) : EMPTY_TITLE,
			empty: !prompt && !custom && !ai,
			created: Number.isFinite(created) ? created : mtimeMs,
			modified: mtimeMs,
		};
	} finally {
		fs.closeSync(fd);
	}
}

const PARSERS: Record<AgentKind, (file: string, mtimeMs: number) => SessionInfo | null> = {
	omp: parseSession,
	claude: parseClaudeSession,
};

/** A transcript of either agent, for files outside any index (e.g. moved pinned sessions). */
export function parseAnySession(file: string, mtimeMs: number): SessionInfo | null {
	return parseSession(file, mtimeMs) ?? parseClaudeSession(file, mtimeMs);
}

export interface SessionIndexOptions {
	root?: string;
	debounceMs?: number;
	/** Transcript format under `root`; omp by default. */
	agent?: AgentKind;
}

/**
 * Index of top-level omp sessions (`<root>/<bucket>/*.jsonl`). Subagent transcripts
 * live in per-session subdirectories and are skipped. Like omp, a transcript may be a
 * symlink, but a bucket that is a symlink is not traversed.
 *
 * `ensure()` scans everything once, in chunks, so hundreds of sessions do not block the
 * extension host. After that the watcher names each changed file, and only those are
 * re-read. Every running omp appends to its session about once a second, so a full
 * rescan per change would cost time proportional to the whole history.
 */
export class SessionIndex implements vscode.Disposable {
	readonly root: string;
	readonly agent: AgentKind;
	private readonly parse: (file: string, mtimeMs: number) => SessionInfo | null;
	/** `root` with links resolved; set on the first symlinked transcript. */
	private realRoot: string | undefined;
	private readonly debounceMs: number;
	// Keyed by normPath(file).
	private readonly cache = new Map<string, CacheEntry>();
	private sorted: SessionInfo[] | undefined;
	/** The first full scan; set once `ensure()` is called. */
	private scanned: Promise<void> | undefined;
	// Scans and flushes run one at a time, so a rescan never races the first scan.
	private queue: Promise<unknown> = Promise.resolve();
	private readonly pending = new Set<string>();
	private rescan = false;
	private watcher: fs.FSWatcher | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	/** Raw watcher signal: a changed session file, or undefined when any file may have changed. */
	private readonly filesChanged = new vscode.EventEmitter<string | undefined>();
	readonly onDidChangeFiles = this.filesChanged.event;

	constructor(opts: SessionIndexOptions = {}) {
		this.root = opts.root ?? sessionsDir();
		this.agent = opts.agent ?? "omp";
		this.parse = PARSERS[this.agent];
		this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
		this.watch();
	}

	private watch(): void {
		try {
			this.watcher = fs.watch(this.root, { recursive: true }, (event, name) => this.onFsEvent(name, event));
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
				this.filesChanged.fire(undefined);
			});
		} catch {
			// No sessions dir yet; a later rescan starts the watcher once it exists.
			this.filesChanged.fire(undefined);
		}
	}

	private onFsEvent(name: string | Buffer | null | undefined, event: string): void {
		let changedFile: string | undefined;
		if (name == null) {
			this.rescan = true;
		} else {
			const parts = String(name).split(/[\\/]/);
			// A bucket directory itself changed (created, renamed, deleted): its files may go unreported.
			if (parts.length === 1) this.rescan = true;
			else if (parts.length === 2 && parts[1].endsWith(".jsonl")) {
				const file = path.join(this.root, ...parts);
				this.pending.add(file);
				if (event === "change") changedFile = file;
			} else return;
		}
		this.filesChanged.fire(changedFile);
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.run(() => this.flush()), this.debounceMs);
	}

	private run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.queue.then(job);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async flush(): Promise<void> {
		const files = [...this.pending];
		this.pending.clear();
		const rescan = this.rescan;
		this.rescan = false;
		// Nothing has been listed yet, so the first scan reads these anyway.
		if (!this.scanned) return;
		let dirty = false;
		if (rescan) dirty = await this.scan();
		else for (const file of files) dirty = this.update(file) || dirty;
		if (!dirty) return;
		this.sorted = undefined;
		this.changed.fire();
	}

	/** Re-reads one session file. Returns whether the listing changed. */
	private update(file: string): boolean {
		const key = normPath(file);
		let mtimeMs: number;
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile() || this.isAlias(file)) return this.cache.delete(key);
			mtimeMs = stat.mtimeMs;
		} catch {
			return this.cache.delete(key);
		}
		const cached = this.cache.get(key);
		if (cached?.mtimeMs === mtimeMs) return false;
		let info: SessionInfo | null = null;
		try {
			info = this.parse(file, mtimeMs);
		} catch {
			// unreadable; retried on the next change
		}
		this.cache.set(key, { mtimeMs, info });
		// A foreign file that stays foreign does not change what is listed.
		return !!(info || cached?.info);
	}

	/**
	 * A symlink to a transcript in another bucket, which is listed under its own path. omp
	 * lists such a pair once. Throws when the link is broken.
	 */
	private isAlias(file: string): boolean {
		if (!fs.lstatSync(file).isSymbolicLink()) return false;
		this.realRoot ??= fs.realpathSync(this.root);
		const rel = path.relative(this.realRoot, fs.realpathSync(file));
		const parts = rel.split(path.sep);
		return parts.length === 2 && parts[0] !== ".." && !path.isAbsolute(rel) && parts[1].endsWith(".jsonl");
	}

	/** Full scan of every bucket, yielding between chunks. Returns whether the listing changed. */
	private async scan(): Promise<boolean> {
		const seen = new Set<string>();
		let dirty = false;
		let parsed = 0;
		let buckets: fs.Dirent[];
		try {
			buckets = fs.readdirSync(this.root, { withFileTypes: true });
		} catch {
			buckets = [];
		}
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const dir = path.join(this.root, bucket.name);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				// A symlink's target is checked in update(); omp lists links that resolve to a file.
				if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
				const file = path.join(dir, entry.name);
				seen.add(normPath(file));
				dirty = this.update(file) || dirty;
				if (++parsed % SCAN_CHUNK === 0) await setImmediate();
			}
		}
		for (const key of this.cache.keys()) {
			if (!seen.has(key)) dirty = this.cache.delete(key) || dirty;
		}
		if (!this.watcher) this.watch();
		return dirty;
	}

	/** Resolves once the first full scan is done; starts it on the first call. */
	ensure(): Promise<void> {
		this.scanned ??= this.run(async () => {
			await this.scan();
			this.sorted = undefined;
		});
		return this.scanned;
	}

	/** Every session scanned so far, empty ones included, most recently modified first. Await `ensure()` first. */
	list(): SessionInfo[] {
		if (!this.sorted) {
			this.sorted = [];
			for (const { info } of this.cache.values()) if (info) this.sorted.push(info);
			this.sorted.sort((a, b) => b.modified - a.modified);
		}
		return this.sorted;
	}

	/** Metadata for one session file; parses it when it is not indexed (e.g. never listed). */
	find(file: string): SessionInfo | undefined {
		const cached = this.cache.get(normPath(file));
		if (cached) return cached.info ?? undefined;
		try {
			return this.parse(file, fs.statSync(file).mtimeMs) ?? undefined;
		} catch {
			return undefined;
		}
	}

	dispose(): void {
		clearTimeout(this.debounce);
		this.watcher?.close();
		this.changed.dispose();
		this.filesChanged.dispose();
	}
}

/** What the sidebar, the window registry and commands read: one index or several merged. */
export type SessionCatalog = Pick<SessionIndex, "list" | "find" | "ensure" | "onDidChange" | "onDidChangeFiles"> & vscode.Disposable;

/** omp's and Claude Code's indexes as one listing, most recently modified first. */
export class SessionIndexes implements SessionCatalog {
	private sorted: SessionInfo[] | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly filesChanged = new vscode.EventEmitter<string | undefined>();
	readonly onDidChangeFiles = this.filesChanged.event;
	private readonly subs: vscode.Disposable[] = [];

	constructor(private readonly sources: SessionIndex[]) {
		for (const source of sources) {
			this.subs.push(
				source.onDidChange(() => {
					this.sorted = undefined;
					this.changed.fire();
				}),
				source.onDidChangeFiles((file) => this.filesChanged.fire(file)),
			);
		}
	}

	async ensure(): Promise<void> {
		await Promise.all(this.sources.map((s) => s.ensure()));
	}

	list(): SessionInfo[] {
		if (!this.sorted) {
			this.sorted = this.sources.flatMap((s) => s.list());
			this.sorted.sort((a, b) => b.modified - a.modified);
		}
		return this.sorted;
	}

	find(file: string): SessionInfo | undefined {
		const owner = this.sources.find((s) => isWithin(file, s.root));
		if (owner) return owner.find(file);
		for (const source of this.sources) {
			const info = source.find(file);
			if (info) return info;
		}
		return undefined;
	}

	dispose(): void {
		for (const sub of this.subs) sub.dispose();
		for (const source of this.sources) source.dispose();
		this.changed.dispose();
		this.filesChanged.dispose();
	}
}
