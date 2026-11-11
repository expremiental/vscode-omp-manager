'use strict';
const assert = require('node:assert/strict');
const { EventEmitter: NodeEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

class HostEmitter {
    listeners = new Set();
    event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}
const host = {
    EventEmitter: HostEmitter,
    workspace: {
        name: 'identity-cache-test',
        workspaceFolders: [],
        getConfiguration: () => ({ get: (key, fallback) => key === 'sessions.scope' ? 'all' : fallback }),
    },
};
// Load the installed implementations, substituting only the unavailable VS Code host.
const load = Module._load;
let WindowSessions, SessionIndex, OmpViewProvider;
try {
    Module._load = function (name, ...args) {
        return name === 'vscode' ? host : load.call(this, name, ...args);
    };
    ({ WindowSessions } = require('../out/windows'));
    ({ SessionIndex } = require('../out/sessions'));
    ({ OmpViewProvider } = require('../out/views'));
} finally {
    Module._load = load;
}

function transcript(file, id) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id, cwd: path.dirname(file), title: id }) + '\n');
    return file;
}

function fixture(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omp-identity-')));
    const root = path.join(dir, 'sessions');
    fs.mkdirSync(root);
    let callback;
    const watcher = new NodeEmitter();
    watcher.close = () => {};
    t.mock.method(fs, 'watch', (_root, _options, listener) => {
        callback = listener;
        return watcher;
    });
    const index = new SessionIndex({ root, debounceMs: 60_000 });
    const windows = new WindowSessions({}, {}, {}, index);
    windows.dir = path.join(dir, 'registry');
    windows.manifestPath = path.join(windows.dir, windows.ownerId + '.json');
    windows.socketPath = path.join(dir, 'absent.sock');
    fs.mkdirSync(windows.dir);
    // Do not start IPC, heartbeat, or ownership discovery in the isolated host.
    windows.refresh = () => {};
    t.after(() => {
        windows.dispose();
        index.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const realpath = fs.realpathSync;
    let calls = 0;
    t.mock.method(fs, 'realpathSync', function (...args) {
        calls++;
        return realpath.apply(this, args);
    });
    return { dir, root, index, windows, watcher, event: (event, name) => callback(event, name), calls: () => calls };
}

test('sidebar identity cache', async (t) => {
    await t.test('fixed expiry, fresh defaults, and failed lookups save actual realpath calls', (t) => {
        const f = fixture(t);
        let now = 10_000;
        t.mock.method(Date, 'now', () => now);
        const file = transcript(path.join(f.root, 'bucket', 'one.jsonl'), 'one');
        assert.equal(f.windows.identity(file, true), file);
        assert.equal(f.calls(), 1);
        now += 4999;
        assert.equal(f.windows.identity(file, true), file);
        assert.equal(f.calls(), 1);
        now++;
        assert.equal(f.windows.identity(file, true), file);
        assert.equal(f.calls(), 2, 'cache hits must not slide expiry');
        f.windows.identity(file);
        f.windows.identity(file);
        assert.equal(f.calls(), 4, 'default ownership callers must always resolve');
        const missing = path.join(f.root, 'missing.jsonl');
        assert.equal(f.windows.identity(missing, true), missing);
        assert.equal(f.windows.identity(missing, true), missing);
        assert.equal(f.calls(), 5, 'negative lookups are cached too');
    });

    await t.test('alias joins preserve local/remote tuples, selection, pins, and missing bookmarks', (t) => {
        const f = fixture(t);
        const target = transcript(path.join(f.root, 'bucket', 'one.jsonl'), 'one');
        const alias = path.join(f.root, 'bucket', 'alias.jsonl');
        fs.symlinkSync(target, alias);
        f.index.update(target);
        assert.equal(f.index.update(alias), false, 'an indexed internal alias stays suppressed');
        const saved = transcript(path.join(f.dir, 'outside.jsonl'), 'outside');
        const gone = path.join(f.dir, 'gone.jsonl');
        const pins = [{ id: 'one', file: alias }, { id: 'outside', file: saved }, { id: 'gone', file: gone }];
        const terminal = {};
        const tracker = { openSessions: () => new Map([[alias, { terminal, terminalKey: 'local-key' }]]) };
        const attention = { selectedEditorTerminal: () => terminal, isUnread: () => false };
        const messages = [];
        const provider = Object.assign(Object.create(OmpViewProvider.prototype), {
            index: f.index, windows: f.windows, tracker, attention,
            pins: { has: (id) => pins.some(pin => pin.id === id), list: () => pins },
            view: { webview: { postMessage: (message) => messages.push(message) } },
        });
        const owner = { file: alias, id: 'one', kind: 'local', ownerId: 'owner', terminalKey: 'local-key', state: 'working', unreadCompletion: true };
        f.windows.visible.set(target, owner);
        const snapshotStart = f.calls();
        provider.postSessions();
        const first = messages.at(-1).items;
        assert.equal(first.length, 3);
        assert.deepEqual(first.map(item => item.id).sort(), ['gone', 'one', 'outside']);
        assert.deepEqual(first.find(item => item.id === 'one'), {
            file: alias, id: 'one', title: 'one', detail: 'bucket', time: fs.statSync(target).mtimeMs,
            cwd: path.dirname(target), state: 'working', pinned: true, missing: false,
            unreadCompletion: true, ownerId: 'owner', terminalKey: 'local-key', kind: 'local', current: true,
        });
        assert.equal(first.find(item => item.id === 'gone').missing, true);
        const count = f.calls();
        provider.postSessions();
        assert.deepEqual(messages.at(-1).items, first);
        assert.equal(f.calls(), count, 'a repeated real provider snapshot adds no realpath calls');
        t.diagnostic(`real postSessions realpath calls: first snapshot ${count - snapshotStart}; repeated snapshot ${f.calls() - count}`);
        Object.assign(owner, { kind: 'remote', ownerId: 'remote-owner', terminalKey: 'remote-key', state: 'waiting' });
        provider.postSessions();
        const remote = messages.at(-1).items.find(item => item.id === 'one');
        assert.equal(remote.ownerId, 'remote-owner');
        assert.equal(remote.terminalKey, 'remote-key');
        assert.equal(remote.state, 'waiting');
        assert.equal(remote.current, false);
        assert.equal(remote.pinned, true);
        transcript(saved, 'reused');
        provider.postSessions();
        assert.equal(messages.at(-1).items.find(item => item.id === 'outside').missing, true, 'reused paths do not adopt the old pin');
    });

    await t.test('missing ownership survives expiry/invalidation and observes newer remote hints', async (t) => {
        const f = fixture(t);
        let now = 10_000;
        t.mock.method(Date, 'now', () => now);
        const target = transcript(path.join(f.root, 'bucket', 'one.jsonl'), 'one');
        const alias = path.join(f.dir, 'alias.jsonl');
        fs.symlinkSync(target, alias);
        assert.equal(f.windows.identity(alias, true), target);
        fs.unlinkSync(alias);
        f.index.filesChanged.fire();
        assert.equal(f.windows.identity(alias, true), target);
        now += 5000;
        assert.equal(f.windows.identity(alias, true), target);
        const owner = { kind: 'local', ownerId: 'owner', terminalKey: 'key', file: alias };
        f.windows.visible.set(target, owner);
        assert.equal(await f.windows.resolve(alias), owner, 'missing transcript still routes to its known owner');
        const replacement = transcript(path.join(f.dir, 'replacement.jsonl'), 'replacement');
        const remoteId = 'a'.repeat(24);
        fs.writeFileSync(path.join(f.windows.dir, remoteId + '.json'), JSON.stringify({
            version: 1, ownerId: remoteId, startedAt: 1, hostPid: process.pid, releases: [],
            sessions: [{ file: alias, canonicalFile: replacement, terminalKey: 'remote-key', adoptedAt: 1 }],
        }));
        f.windows.readManifests();
        const count = f.calls();
        assert.equal(f.windows.identity(alias, true), replacement, 'cached failure uses newly received canonical evidence');
        assert.equal(f.calls(), count);
        fs.symlinkSync(target, alias);
        f.index.filesChanged.fire();
        assert.equal(f.windows.identity(alias, true), target, 'recreation replaces missing-path evidence');
        f.windows.readManifests();
        assert.equal(f.windows.identity(alias, true), target, 'successful local lookup outranks a remote hint');
        fs.unlinkSync(alias);
        fs.symlinkSync(replacement, alias);
        assert.equal(f.windows.identity(alias, true), target);
        const replacementOwner = { ...owner, file: replacement, terminalKey: 'replacement-key' };
        f.windows.visible.set(replacement, replacementOwner);
        assert.equal(await f.windows.resolve(alias), replacementOwner, 'ownership resolution bypasses a stale sidebar result');
        fs.unlinkSync(alias);
        fs.symlinkSync(target, alias);
        now += 5000;
        assert.equal(f.windows.identity(alias, true), target, 'TTL also bounds changes outside watcher coverage');
        const moved = path.join(f.root, 'bucket', 'moved.jsonl');
        fs.renameSync(target, moved);
        f.event('rename', 'bucket/one.jsonl');
        assert.equal(f.windows.identity(alias, true), target, 'a move does not discard ownership evidence for a broken alias');
        fs.unlinkSync(alias);
        fs.symlinkSync(moved, alias);
        f.event('rename', 'bucket/moved.jsonl');
        assert.equal(f.windows.identity(alias, true), moved, 'structural invalidation sees the moved transcript');
    });

    await t.test('filtered watcher events invalidate immediately, including unchanged metadata and errors', async (t) => {
        const f = fixture(t);
        const target = transcript(path.join(f.root, 'bucket', 'one.jsonl'), 'one');
        const other = transcript(path.join(f.root, 'bucket', 'two.jsonl'), 'two');
        const alias = path.join(f.dir, 'alias.jsonl');
        fs.symlinkSync(target, alias);
        f.index.update(target);
        f.index.scanned = Promise.resolve();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let refreshes = 0;
        f.windows.refresh = () => {
            refreshes++;
            f.windows.identity(target);
        };
        const assertNoOwnershipWork = () => {
            const before = f.calls();
            t.mock.timers.tick(25);
            assert.equal(refreshes, 0, 'filesystem invalidation must not bypass metadata debounce');
            assert.equal(f.calls(), before, 'no fresh ownership filesystem work runs after 20ms');
        };
        const events = [];
        let metadataChanges = 0;
        f.index.onDidChangeFiles(file => events.push(file));
        f.index.onDidChange(() => metadataChanges++);
        const warm = () => [target, other, alias].forEach(file => f.windows.identity(file, true));
        warm();
        f.event('change', 'bucket/one.jsonl');
        assert.deepEqual(events, [target]);
        assert.equal(f.windows.identityCache.has(target), false);
        assert.equal(f.windows.identityCache.has(alias), false, 'target change evicts cached aliases');
        assert.equal(f.windows.identityCache.has(other), true);
        assertNoOwnershipWork();
        const count = f.calls();
        warm();
        assert.equal(f.calls(), count + 2, 'unrelated entries retain their filesystem savings');
        await f.index.flush();
        assert.equal(metadataChanges, 0, 'invalidation does not depend on metadata changes');
        const debounce = f.index.debounce;
        for (const name of ['bucket/one/advisor.jsonl', 'bucket/one/assets/image.png', 'bucket/readme.txt'])
            f.event('rename', name);
        assert.equal(events.length, 1);
        assert.equal(f.index.pending.size, 0);
        assert.equal(f.index.rescan, false);
        assert.equal(f.index.debounce, debounce, 'ignored events do not schedule work');
        assert.equal(f.windows.identityCache.size, 3);
        for (const [event, name] of [['rename', 'bucket/one.jsonl'], ['change', 'bucket'], ['change', null], ['change', undefined], ['unknown', 'bucket/one.jsonl']]) {
            warm();
            f.event(event, name);
            assert.equal(events.at(-1), undefined);
            assert.equal(f.windows.identityCache.size, 0);
            assertNoOwnershipWork();
            const before = f.calls();
            warm();
            assert.equal(f.calls(), before + 3, 'next ordinary lookups refresh structurally invalidated entries');
        }
        warm();
        f.watcher.emit('error', new Error('watcher failed'));
        assert.equal(f.windows.identityCache.size, 0);
        assert.equal(f.index.watcher, undefined);
        assertNoOwnershipWork();
        const afterError = f.calls();
        warm();
        assert.equal(f.calls(), afterError + 3, 'next ordinary lookups refresh after a watcher error');
        t.mock.method(fs, 'watch', () => { throw new Error('watch unavailable'); });
        f.index.watch();
        assert.equal(f.windows.identityCache.size, 0, 'watch setup failure invalidates too');
        assertNoOwnershipWork();
        warm();
        assert.equal(f.index.filesChanged.listeners.size, 2);
        f.windows.dispose();
        assert.equal(f.windows.identityCache.size, 0);
        assert.equal(f.index.filesChanged.listeners.size, 1, 'window disposal detaches its subscription');
        f.index.dispose();
        assert.equal(f.index.filesChanged.listeners.size, 0);
    });
});
