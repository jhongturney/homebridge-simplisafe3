const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');
const { createRequire } = require('node:module');

const root = path.resolve(process.env.SIMPLISAFE_LOG_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const fromPlugin = createRequire(path.join(root, 'package.json'));
const { default: safeLogger, safeLogValue, redactText, lineLogger } = require(path.join(root, 'lib/safeLogger'));
const sentinels = ['fixture-access-secret', 'fixture-refresh-secret', 'fixture-verifier-secret', 'fixture-room-secret', 'fixture-key-secret'];
function assertSafe(value) {
    const rendered = util.inspect(value, { depth: 20 });
    for (const secret of sentinels) assert.equal(rendered.includes(secret), false, 'credential escaped to logging sink');
}
function recordingLogger() {
    const calls = [];
    const logger = function (...args) { calls.push({ level: 'default', args, receiver: this }); };
    for (const level of ['info', 'debug', 'warn', 'error', 'success', 'log']) {
        logger[level] = function (...args) { calls.push({ level, args, receiver: this }); };
    }
    return { logger, calls };
}

test('Axios errors retain diagnostic status/code while dropping token-bearing request data', () => {
    const axios = fromPlugin('axios');
    const error = new axios.AxiosError('OAuth request failed', 'ERR_BAD_REQUEST', {
        headers: { Authorization: `Bearer ${sentinels[0]}` },
        data: JSON.stringify({ refresh_token: sentinels[1], code_verifier: sentinels[2] }),
        url: `https://fixture.invalid/?access_token=${sentinels[3]}`,
    }, undefined, { status: 429 });
    const before = JSON.stringify(error.toJSON());
    assert.ok(before.includes(sentinels[1]), 'fixture exercises the original leak');
    const safe = safeLogValue(error);
    assertSafe(safe);
    assert.equal(safe.code, 'ERR_BAD_REQUEST');
    assert.equal(safe.status, 429);
    assert.equal(safe.message, 'OAuth request failed');
    assert.equal(safe.config, undefined);
    assert.equal(JSON.stringify(error.toJSON()), before, 'redaction must not alter the active request');
});

test('nested credentials, JSON bodies, SRTP keys and binary data are detached and redacted', () => {
    const source = {
        response: { accessToken: sentinels[0], refresh_token: sentinels[1], nested: { codeVerifier: sentinels[2], userToken: sentinels[3] } },
        data: JSON.stringify({ grant_type: 'refresh_token', refresh_token: sentinels[1] }),
        video: { srtp_key: Buffer.from(sentinels[4]), srtp_salt: Buffer.from(sentinels[4]), width: 1280 },
        statusCode: 503, type: 'SettingsInProgress', binary: Buffer.from(sentinels[0]),
    };
    const safe = safeLogValue(source);
    assertSafe(safe);
    assert.equal(safe.statusCode, 503);
    assert.equal(safe.type, 'SettingsInProgress');
    assert.equal(safe.video.width, 1280);
    assert.equal(source.response.accessToken, sentinels[0]);
    assert.notEqual(source, safe);
});

for (const text of [
    `Bearer ${sentinels[0]}`,
    `Authorization: Bearer ${sentinels[0]}\r\nRetry-After: 10`,
    `https://fixture.invalid/rtc?access_token=${sentinels[3]}&protocol=15`,
    `com.simplisafe.mobile://callback?code=${sentinels[2]}&state=fixture`,
    `-srtp_out_params ${sentinels[4]} -payload_type 99`,
    `failure: {"refresh_token":"${sentinels[1]}","password":"${sentinels[0]} with spaces"}`,
    `a=ice-pwd:${sentinels[4]}\r\n`,
    `https://fixture:${sentinels[0]}@fixture.invalid/video`,
]) {
    test(`credential text is redacted: ${text.split(/[ :/?]/)[0]}`, () => {
        const safe = redactText(text);
        assertSafe(safe);
        assert.ok(safe.includes('[REDACTED]'));
    });
}

test('ordinary logs preserve status codes, callback messages and logger receivers at every level', () => {
    const { logger, calls } = recordingLogger();
    const wrapped = safeLogger(logger);
    wrapped('connected', 200);
    for (const level of ['info', 'debug', 'warn', 'error', 'success', 'log']) {
        wrapped[level]('fixture', { status: 503, code: 503, type: 'SettingsInProgress' }, { accessToken: sentinels[0] });
    }
    assert.equal(calls.length, 7);
    assert.deepEqual(calls[0].args, ['connected', 200]);
    assert.ok(calls.every(call => call.receiver === logger));
    assertSafe(calls);
    assert.equal(safeLogger(wrapped), wrapped, 'shared loggers are wrapped once');
    assert.equal(safeLogger(logger), wrapped);
});

test('custom serializers, getters and circular errors cannot leak request internals', () => {
    let invoked = false;
    const value = { status: 503, toJSON() { invoked = true; return { secret: sentinels[0] }; } };
    value.self = value;
    Object.defineProperty(value, 'request', { enumerable: true, get() { invoked = true; throw new Error('must not read'); } });
    value[util.inspect.custom] = () => { invoked = true; return sentinels[0]; };
    const error = new Error('connection failed', { cause: value });
    error.toJSON = () => { invoked = true; throw new Error('must not serialize'); };
    const safe = safeLogValue(error);
    assertSafe(safe);
    assert.equal(invoked, false);
    assert.equal(safe.cause.status, 503);
    assert.equal(safe.cause.self, '[Circular]');
});

test('line logger handles credentials split across chunks and bounds oversized lines', () => {
    const lines = [];
    const log = lineLogger(line => lines.push(line));
    const text = `HTTP 401 Authorization: Bearer ${sentinels[0]}\nhttps://fixture.invalid/?access_token=${sentinels[3]}\n`;
    for (const byte of text) log(byte);
    assertSafe(lines);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /401/);
    log('x'.repeat(8193) + sentinels[0] + '\n');
    log('recovered\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], 'recovered');
    log('Authorization: Bearer ' + sentinels[0]);
    assert.equal(lines.length, 3, 'incomplete diagnostics are not emitted');
});

test('actual camera prepare logging redacts HomeKit keys without altering the response', () => {
    const Delegate = require(path.join(root, 'lib/streamingDelegate')).default;
    const { logger, calls } = recordingLogger();
    const delegate = Object.assign(Object.create(Delegate.prototype), {
        ss3Camera: { debug: true, getStreamProvider: () => 'legacy' }, log: safeLogger(logger),
        api: { hap: { uuid: { unparse: () => 'fixture-session' } } }, pendingSessions: {},
    });
    const key = Buffer.from(sentinels[4]);
    let response;
    delegate.prepareStream({ sessionID: 'fixture', targetAddress: '127.0.0.1', video: { port: 5000, srtp_key: key, srtp_salt: key } }, (error, value) => {
        assert.equal(error, undefined); response = value;
    });
    assertSafe(calls);
    assert.equal(calls[0].args[1].video.srtp_key, '[REDACTED]');
    assert.equal(response.video.srtp_key, key);
    assert.equal(delegate.pendingSessions['fixture-session'].video_srtp.length, key.length * 2);
});

test('scheduled OAuth failures reach the real logger with status but without stored secrets', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const axios = fromPlugin('axios');
    const adapter = axios.defaults.adapter;
    t.after(() => { axios.defaults.adapter = adapter; });
    axios.defaults.adapter = async config => {
        throw new axios.AxiosError('Fixture OAuth rejected', 'ERR_BAD_REQUEST', config, undefined, { status: 429 });
    };
    const authPath = require.resolve(path.join(root, 'lib/authManager'));
    delete require.cache[authPath];
    t.after(() => { delete require.cache[authPath]; });
    const Auth = require(authPath).default;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-log-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { logger, calls } = recordingLogger();
    const auth = new Auth(directory, logger, true);
    let tick;
    t.mock.method(global, 'setInterval', callback => { tick = callback; return {}; });
    await auth._storeToken({ access_token: sentinels[0], refresh_token: sentinels[1], expires_in: 3600, token_type: 'Bearer' });
    tick();
    await new Promise(setImmediate);
    const errors = calls.filter(call => call.level === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].args[0].status, 429);
    assert.equal(errors[0].args[0].code, 'ERR_BAD_REQUEST');
    assertSafe(calls);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'simplisafe3auth.json'))).refreshToken, sentinels[1]);
});

test('platform startup logs a failed refresh without invoking credential-bearing toJSON', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const Auth = require(path.join(root, 'lib/authManager')).default;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-platform-log-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const error = new Error('Fixture offline');
    error.code = 'ECONNRESET';
    error.config = { headers: { Authorization: `Bearer ${sentinels[0]}` }, data: { refresh_token: sentinels[1] } };
    error.toJSON = () => assert.fail('platform must not call toJSON');
    t.mock.method(Auth.prototype, 'refreshCredentials', async () => { throw error; });
    const { logger, calls } = recordingLogger();
    let Platform;
    require(root).default({ hap: { uuid: {} }, registerPlatform: (name, alias, constructor) => { Platform = constructor; } });
    const platform = new Platform(logger, { name: 'Fixture' }, { user: { storagePath: () => directory }, on: () => {} });
    await platform.initialLoad;
    assertSafe(calls);
    const failure = calls.find(call => call.args[0] === 'SimpliSafe login failed with error:');
    assert.ok(failure);
    assert.equal(failure.args[1].code, 'ECONNRESET');
});
