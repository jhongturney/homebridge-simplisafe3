const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(process.env.SIMPLISAFE_UI_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const serverPath = path.join(packageRoot, 'homebridge-ui', 'server.js');
const fixturePath = path.join(__dirname, 'helpers', 'ui-token-fixture.cjs');
const account = {
    accessToken: 'existing-test-access', refreshToken: 'existing-test-refresh', codeVerifier: 'existing-test-verifier',
};

async function openSettings(t, savedAccount = account) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'simplisafe-ui-test-'));
    const credentialsFile = path.join(storage, 'simplisafe3auth.json');
    if (savedAccount) fs.writeFileSync(credentialsFile, JSON.stringify(savedAccount));
    const child = fork(serverPath, [], {
        cwd: storage,
        execArgv: ['--require', fixturePath],
        env: {
            ...process.env,
            HOMEBRIDGE_STORAGE_PATH: storage,
            HOMEBRIDGE_CONFIG_PATH: path.join(storage, 'config.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
        fs.rmSync(storage, { recursive: true, force: true });
    });

    function waitForMessage(matches) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                child.off('message', onMessage);
                child.off('error', onError);
                child.off('exit', onExit);
            };
            const onMessage = message => {
                if (matches(message)) { cleanup(); resolve(message); }
            };
            const onError = error => { cleanup(); reject(error); };
            const onExit = () => { cleanup(); reject(new Error(`UI server exited before responding: ${stderr}`)); };
            const timer = setTimeout(() => { cleanup(); reject(new Error(`UI server did not respond: ${stderr}`)); }, 5000);
            child.on('message', onMessage);
            child.once('error', onError);
            child.once('exit', onExit);
        });
    }

    const ready = await waitForMessage(message => message.action === 'ready');
    assert.equal(ready.payload.server, true);
    let id = 0;
    return {
        child, credentialsFile, exited,
        request: async (route, body = {}) => {
            const requestId = String(++id);
            const response = waitForMessage(message => message.action === 'response' && message.payload.requestId === requestId);
            child.send({ action: 'request', path: route, requestId, body });
            return (await response).payload;
        },
    };
}

test('settings UI starts and detects saved credentials without modifying them', async t => {
    const ui = await openSettings(t);
    const before = fs.readFileSync(ui.credentialsFile, 'utf8');
    const credentials = await ui.request('/credentialsExist');
    assert.equal(credentials.success, true);
    assert.deepEqual(credentials.data, { success: true, credentialsExist: true });
    const verifier = await ui.request('/getCodeVerifier');
    assert.equal(verifier.data.codeVerifier, account.codeVerifier);
    const auth = await ui.request('/getSSAuthURL');
    assert.equal(auth.data.success, true);
    assert.equal(new URL(auth.data.url).hostname, 'auth.simplisafe.com');
    assert.equal(new URL(auth.data.url).searchParams.get('code_challenge_method'), 'S256');
    assert.equal(fs.readFileSync(ui.credentialsFile, 'utf8'), before);
});

test('settings UI handles missing credentials and valid or invalid redirect URLs', async t => {
    const ui = await openSettings(t, null);
    assert.deepEqual((await ui.request('/credentialsExist')).data, { success: true, credentialsExist: false });
    const valid = await ui.request('/getAuthCodeFromUrl', { redirectURLStr: 'com.SimpliSafe.mobile://callback?code=fixture-code' });
    assert.deepEqual(valid.data, { success: true, authCode: 'fixture-code' });
    const invalid = await ui.request('/getAuthCodeFromUrl', { redirectURLStr: 'not-a-url' });
    assert.equal(invalid.data.success, false);
    assert.match(invalid.data.error, /Invalid redirect URL/);
    assert.equal(fs.existsSync(ui.credentialsFile), false);
});

test('settings UI exchanges and stores test tokens and preserves them on a failed exchange', async t => {
    const ui = await openSettings(t);
    const success = await ui.request('/getToken', { authCode: 'fixture-code' });
    assert.deepEqual(success.data, {
        success: true, accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
    });
    const stored = JSON.parse(fs.readFileSync(ui.credentialsFile, 'utf8'));
    assert.equal(stored.accessToken, 'fixture-access-token');
    assert.equal(stored.refreshToken, 'fixture-refresh-token');
    const before = fs.readFileSync(ui.credentialsFile, 'utf8');
    const failure = await ui.request('/getToken', { authCode: 'fixture-rejected-code' });
    assert.equal(failure.data.success, false);
    assert.match(failure.data.error, /Fixture rejected authorization code/);
    assert.equal(fs.readFileSync(ui.credentialsFile, 'utf8'), before);
});

test('closing the settings IPC connection terminates the UI server with token refresh active', async t => {
    const ui = await openSettings(t);
    assert.equal((await ui.request('/getToken', { authCode: 'fixture-code' })).data.success, true);
    const stopped = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Settings UI process remained active after disconnect')), 3000);
        ui.exited.then(result => { clearTimeout(timeout); resolve(result); });
    });
    ui.child.disconnect();
    const result = await stopped;
    assert.equal(result.signal, 'SIGTERM');
});
