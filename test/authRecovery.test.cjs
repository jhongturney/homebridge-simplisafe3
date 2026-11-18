const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const waitFor = require('./helpers/wait-for.cjs');
const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const fromPlugin = createRequire(path.join(root, 'package.json'));
const { readAccount, writeAccount, withAccountLock } = require(path.join(root, 'lib/accountStore'));
const stored = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', codeVerifier: 'fixture-verifier' };
const next = { access_token: 'fixture-next-access', refresh_token: 'fixture-next-refresh', token_type: 'Bearer', expires_in: 3600 };
function storage(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, file: path.join(dir, 'simplisafe3auth.json') };
}
function setup(t, post) {
    const axios = fromPlugin('axios');
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = post;
    const modulePath = require.resolve(path.join(root, 'lib/authManager'));
    delete require.cache[modulePath];
    t.after(() => { axios.defaults.adapter = previous; delete require.cache[modulePath]; });
    const Auth = require(modulePath).default;
    const { dir, file } = storage(t);
    writeAccount(file, stored);
    const errors = [];
    const auth = new Auth(dir, Object.assign(() => {}, { error: (...args) => errors.push(args) }));
    t.after(async () => { auth.dispose(); await auth.refreshInFlight?.catch(() => {}); });
    return { auth, file, errors, Auth, axios };
}

test('atomic writes create private files and leave the prior file intact when rename fails', t => {
    const { file, dir } = storage(t);
    writeAccount(file, stored);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, destination) => {
        if (destination === file) throw new Error('fixture interrupted replacement');
        return rename(source, destination);
    });
    assert.throws(() => writeAccount(file, { ...stored, refreshToken: 'replacement' }), /interrupted/);
    assert.deepEqual(readAccount(file), stored);
    assert.deepEqual(fs.readdirSync(dir), ['simplisafe3auth.json']);
});

test('malformed account files are reported without crashing construction or rewriting evidence', t => {
    const { dir, file } = storage(t);
    fs.writeFileSync(file, '{broken fixture');
    const errors = [];
    const Auth = require(path.join(root, 'lib/authManager')).default;
    const auth = new Auth(dir, Object.assign(() => {}, { error: (...args) => errors.push(args) }));
    t.after(() => auth.dispose());
    assert.equal(auth.isAuthenticated(), false);
    assert.match(errors[0][0], /preserved/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken fixture');
    assert.throws(() => readAccount(file), /Cannot read credentials/);
});

test('a failed token write does not publish replacement credentials in memory', async t => {
    const { auth, file } = setup(t, async () => { throw new Error('unused'); });
    t.mock.method(fs, 'renameSync', () => { throw new Error('fixture disk unavailable'); });
    await assert.rejects(auth._storeToken(next), /Failed storing token/);
    assert.equal(auth.refreshToken, stored.refreshToken);
    assert.deepEqual(readAccount(file), stored);
});

test('OAuth throttling retains credentials, honors Retry-After, and then recovers', async t => {
    let calls = 0;
    const { auth, axios } = setup(t, async config => {
        if (++calls === 1) throw new axios.AxiosError('fixture throttle', 'ERR_BAD_RESPONSE', config, undefined, { status: 429, headers: { 'retry-after': '120' } });
        return { status: 200, headers: {}, data: next, config };
    });
    let faults = 0;
    auth.on('REFRESH_CREDENTIALS_FAILURE', () => faults++);
    await assert.rejects(auth.refreshCredentials(), /throttle/);
    assert.equal(auth.refreshToken, stored.refreshToken);
    assert.equal(faults, 0);
    await assert.rejects(auth.refreshCredentials(), /Waiting before retrying/);
    assert.equal(calls, 1);
    assert.ok(auth.retryAfter - Date.now() > 119000);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 121000);
    await auth.refreshCredentials();
    assert.equal(calls, 2);
    assert.equal(auth.refreshToken, next.refresh_token);
    assert.equal(auth.retryAfter, 0);
});

for (const [status, data, invalid] of [[400, { error: 'invalid_grant' }, true], [400, { error: 'invalid_request' }, false], [401, 'Unauthorized', true], [503, 'unavailable', false]]) {
    test(`OAuth ${status}/${typeof data === 'string' ? data : data.error} is classified correctly`, async t => {
        const { auth, axios, file } = setup(t, async config => { throw new axios.AxiosError('fixture rejected', 'ERR_BAD_RESPONSE', config, undefined, { status, data }); });
        let faults = 0;
        auth.on('REFRESH_CREDENTIALS_FAILURE', () => faults++);
        await assert.rejects(auth.refreshCredentials(), /fixture rejected/);
        assert.equal(auth.refreshToken, invalid ? null : stored.refreshToken);
        assert.equal(faults, invalid ? 1 : 0);
        assert.deepEqual(readAccount(file), stored);
    });
}

test('disposing during OAuth aborts the transport and prevents late credential writes', async t => {
    let release, signal;
    const waiting = new Promise(resolve => { release = resolve; });
    const { auth, file } = setup(t, async config => { signal = config.signal; await waiting; return { status: 200, config, headers: {}, data: next }; });
    const pending = auth.refreshCredentials();
    const failed = assert.rejects(pending, /stopped/);
    await waitFor(() => signal);
    auth.dispose();
    await failed;
    assert.equal(signal.aborted, true);
    release();
    await new Promise(setImmediate);
    assert.deepEqual(readAccount(file), stored);
    await assert.rejects(auth.refreshCredentials(), /stopped/);
});

test('waiting for a held account lock is cancellable and leaves the owner intact', async t => {
    const { file } = storage(t);
    const first = new AbortController(), second = new AbortController();
    let release, acquired = false;
    const waiting = new Promise(resolve => { release = resolve; });
    const owner = withAccountLock(file, first.signal, async () => { acquired = true; await waiting; });
    await waitFor(() => acquired);
    const blocked = withAccountLock(file, second.signal, async () => assert.fail('cancelled waiter acquired lock'));
    second.abort(new Error('fixture stopped'));
    await assert.rejects(blocked);
    assert.equal(fs.existsSync(file + '.lock'), true);
    release();
    await owner;
    assert.equal(fs.existsSync(file + '.lock'), false);
});

test('an abandoned stale account lock is recovered automatically', async t => {
    const { file } = storage(t);
    fs.mkdirSync(file + '.lock');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', old, old);
    let acquired = false;
    await withAccountLock(file, new AbortController().signal, async () => { acquired = true; });
    assert.equal(acquired, true);
    assert.equal(fs.existsSync(file + '.lock'), false);
});

test('reloading another writer\'s verifier keeps the next login URL challenge consistent', t => {
    const { dir, file } = storage(t);
    writeAccount(file, stored);
    const Auth = require(path.join(root, 'lib/authManager')).default;
    const auth = new Auth(dir);
    t.after(() => auth.dispose());
    writeAccount(file, { ...stored, codeVerifier: 'fixture-replacement-verifier' });
    auth.parseAccountsFile();
    const challenge = auth.base64URLEncode(auth.sha256(auth.codeVerifier));
    assert.equal(new URL(auth.getSSAuthURL()).searchParams.get('code_challenge'), challenge);
    assert.equal(auth.codeVerifier, 'fixture-replacement-verifier');
});
