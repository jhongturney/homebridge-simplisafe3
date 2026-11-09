const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAuthManager } = require('./helpers/load-auth-manager.cjs');

const waitFor = require('./helpers/wait-for.cjs');
const token = (refresh = 'fixture-new-refresh', expires = 3600) => ({
    access_token: 'fixture-new-access', refresh_token: refresh, token_type: 'Bearer', expires_in: expires,
});
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function manager(t, AuthManager) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-auth-concurrency-'));
    const auth = new AuthManager(storage, Object.assign(() => {}, { error: () => {} }), false);
    auth.refreshToken = 'fixture-old-refresh';
    t.after(async () => {
        auth.dispose();
        await auth.refreshInFlight?.catch(() => {});
        fs.rmSync(storage, { recursive: true, force: true });
    });
    return { auth, storage };
}

test('twenty concurrent credential refreshes perform one exchange and emit success once', async t => {
    const pending = deferred();
    let exchanges = 0;
    const { default: AuthManager, AUTH_EVENTS } = loadAuthManager({ postImpl: () => { exchanges++; return pending.promise; } });
    const { auth, storage } = manager(t, AuthManager);
    let events = 0;
    auth.on(AUTH_EVENTS.REFRESH_CREDENTIALS_SUCCESS, () => { events++; });
    const refreshes = Promise.all(Array.from({ length: 20 }, () => auth.refreshCredentials()));
    await waitFor(() => exchanges === 1);
    assert.equal(exchanges, 1);
    pending.resolve({ data: token() });
    await refreshes;
    assert.equal(events, 1);
    assert.equal(auth.accessToken, 'fixture-new-access');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'simplisafe3auth.json'), 'utf8')).refreshToken, 'fixture-new-refresh');
});

test('a failed shared refresh rejects all callers and permits the next attempt', async t => {
    const pending = deferred();
    let exchanges = 0;
    const { default: AuthManager } = loadAuthManager({ postImpl: () => ++exchanges === 1 ? pending.promise : Promise.resolve({ data: token() }) });
    const { auth } = manager(t, AuthManager);
    const outcomes = Promise.allSettled(Array.from({ length: 20 }, () => auth.refreshCredentials()));
    await waitFor(() => exchanges === 1);
    pending.reject(new Error('fixture temporary failure'));
    assert.ok((await outcomes).every(result => result.status === 'rejected' && /fixture temporary failure/.test(result.reason.message)));
    assert.equal(exchanges, 1);
    assert.equal(auth.refreshToken, 'fixture-old-refresh');
    await auth.refreshCredentials();
    assert.equal(exchanges, 2);
    assert.equal(auth.refreshToken, 'fixture-new-refresh');
});

test('scheduled and on-demand refreshes join the same exchange', async t => {
    const ticks = [];
    t.mock.method(global, 'setInterval', callback => { ticks.push(callback); return {}; });
    t.mock.method(global, 'clearInterval', () => {});
    const pending = deferred();
    let exchanges = 0;
    const { default: AuthManager } = loadAuthManager({ postImpl: () => ++exchanges === 1
        ? Promise.resolve({ data: token('first-refresh') }) : pending.promise });
    const { auth } = manager(t, AuthManager);
    await auth.refreshCredentials();
    const active = auth.refreshCredentials();
    ticks[0]();
    const joined = Promise.all(Array.from({ length: 20 }, () => auth.refreshCredentials()));
    await waitFor(() => exchanges === 2);
    assert.equal(exchanges, 2);
    pending.resolve({ data: token('second-refresh') });
    await Promise.all([active, joined]);
    assert.equal(auth.refreshToken, 'second-refresh');
    assert.equal(exchanges, 2);
});

test('credential refresh sharing is isolated between authentication managers', async t => {
    const pending = deferred();
    let exchanges = 0;
    const { default: AuthManager } = loadAuthManager({ postImpl: async (_url, data) => {
        exchanges++;
        await pending.promise;
        return { data: token(data.refresh_token + '-updated') };
    } });
    const first = manager(t, AuthManager).auth;
    const second = manager(t, AuthManager).auth;
    first.refreshToken = 'first';
    second.refreshToken = 'second';
    const refreshes = Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).refreshCredentials()));
    await waitFor(() => exchanges === 2);
    assert.equal(exchanges, 2);
    pending.resolve();
    await refreshes;
    assert.equal(first.refreshToken, 'first-updated');
    assert.equal(second.refreshToken, 'second-updated');
});

test('short or malformed token lifetimes cannot create a millisecond refresh loop', async t => {
    const delays = [];
    t.mock.method(global, 'setInterval', (_callback, delay) => { delays.push(delay); return {}; });
    t.mock.method(global, 'clearInterval', () => {});
    for (const expires of [30, 'not-a-lifetime', 3600]) {
        const { default: AuthManager } = loadAuthManager({ postImpl: async () => ({ data: token('fixture-new-refresh', expires) }) });
        const { auth } = manager(t, AuthManager);
        await auth.refreshCredentials();
    }
    assert.deepEqual(delays, [60000, 60000, 3300000]);
});

test('timed-out refreshes release all waiters and preserve credentials for recovery', async t => {
    const nativeTimeout = global.setTimeout;
    let expire, signal, exchanges = 0;
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
        if (delay === 20000) expire = callback;
        return nativeTimeout(callback, delay, ...args);
    });
    const { default: AuthManager } = loadAuthManager({ postImpl: (_url, _data, options) => {
        exchanges++;
        signal = options.signal;
        return exchanges === 1 ? new Promise(() => {}) : Promise.resolve({ data: token() });
    } });
    const { auth } = manager(t, AuthManager);
    const outcomes = Promise.allSettled(Array.from({ length: 20 }, () => auth.refreshCredentials()));
    await waitFor(() => typeof expire === 'function');
    expire();
    assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.name === 'TimeoutError'));
    assert.equal(signal.aborted, true);
    assert.equal(exchanges, 1);
    assert.equal(auth.refreshToken, 'fixture-old-refresh');
    await auth.refreshCredentials();
    assert.equal(exchanges, 2);
    assert.equal(auth.accessToken, 'fixture-new-access');
});
