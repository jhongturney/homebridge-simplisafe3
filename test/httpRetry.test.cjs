const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const waitFor = require('./helpers/wait-for.cjs');

const packageRoot = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const apiPath = require.resolve(path.join(packageRoot, 'simplisafe'));
const authPath = require.resolve(path.join(packageRoot, 'lib', 'authManager'));

function realTransport(t, steps) {
    // The packaged smoke test resolves Axios from the installed plugin too.
    const { createRequire } = require('node:module');
    const requireFromPlugin = createRequire(path.join(packageRoot, 'package.json'));
    const transportAxios = requireFromPlugin('axios');
    const original = transportAxios.defaults.adapter;
    const calls = [];
    for (const module of ['node:http', 'node:https']) {
        t.mock.method(require(module), 'request', () => { throw new Error('Unexpected network request in retry test'); });
    }
    transportAxios.defaults.adapter = async config => {
        const step = steps[Math.min(calls.length, steps.length - 1)];
        calls.push(config);
        if (step.wait) await step.wait;
        if (step.code) throw new transportAxios.AxiosError('Fixture network failure', step.code, config);
        const response = {
            status: step.status ?? 200, statusText: 'Fixture response', headers: step.headers || {}, config,
            data: step.data || { error: 'fixture-failure' },
        };
        if (response.status >= 400) {
            throw new transportAxios.AxiosError('Fixture HTTP failure', 'ERR_BAD_RESPONSE', config, undefined, response);
        }
        return response;
    };
    delete require.cache[apiPath];
    delete require.cache[authPath];
    t.after(() => {
        transportAxios.defaults.adapter = original;
        delete require.cache[apiPath];
        delete require.cache[authPath];
    });
    const auth = require(authPath);
    const api = require(apiPath);
    const logger = Object.assign(() => {}, { error: () => {} });
    const apiAuth = Object.assign(new EventEmitter(), {
        isAuthenticated: () => true, tokenType: 'Bearer', accessToken: 'fixture-api-token',
    });
    return {
        calls,
        RateLimitError: api.RateLimitError,
        client: new api.default(15000, apiAuth, os.tmpdir(), logger, false),
        oauth: () => {
            const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-retry-test-'));
            const manager = new auth.default(storage, logger, false);
            manager.refreshToken = 'fixture-old-refresh';
            t.after(async () => {
                manager.dispose();
                await manager.refreshInFlight?.catch(() => {});
                fs.rmSync(storage, { recursive: true, force: true });
            });
            return { manager, storage };
        },
    };
}

for (const operation of ['wake', 'room']) {
    test(`camera ${operation} HTTP request is bounded and cancels its transport`, async t => {
        const { client, calls } = realTransport(t, [{ wait: new Promise(() => {}) }]);
        client.subId = 'fixture-sub';
        const controller = new AbortController();
        const pending = operation === 'wake' ? client.wakeCameras(controller.signal) : client.getCameraLiveView('fixture-camera', controller.signal);
        await new Promise(setImmediate);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].timeout, 20000);
        assert.equal(calls[0].signal.aborted, false);
        controller.abort(new Error('fixture camera cancelled'));
        await assert.rejects(pending, /fixture camera cancelled/);
        assert.equal(calls[0].signal.aborted, true);
        assert.equal(client.isBlocked, false);
    });
}

test('API GET retries two temporary server failures and preserves authorization', async t => {
    const { client, calls } = realTransport(t, [{ status: 503 }, { status: 500 }, { data: { ok: true } }]);
    assert.deepEqual(await client.request({ method: 'GET', url: '/fixture' }), { ok: true });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(config => config.headers.Authorization === 'Bearer fixture-api-token'));
    assert.equal(client.isBlocked, false);
});

test('API GET stops after the configured two retries', async t => {
    const { client, calls } = realTransport(t, [{ status: 503 }]);
    await assert.rejects(client.request({ method: 'GET', url: '/fixture' }), error => error.error === 'fixture-failure');
    assert.equal(calls.length, 3);
});

test('API state-changing POST is not repeated after a server error', async t => {
    const { client, calls } = realTransport(t, [{ status: 503 }]);
    await assert.rejects(client.request({ method: 'POST', url: '/fixture/state', data: { state: 'home' } }), error => error.error === 'fixture-failure');
    assert.equal(calls.length, 1);
});

test('API 403 stops immediately and activates the existing block handler', async t => {
    const { client, calls, RateLimitError } = realTransport(t, [{ status: 403 }]);
    await assert.rejects(client.request({ method: 'GET', url: '/fixture' }), error => error instanceof RateLimitError);
    assert.equal(calls.length, 1);
    assert.equal(client.isBlocked, true);
});

for (const status of [401, 429]) {
    test(`API ${status} is not automatically retried`, async t => {
        const { client, calls } = realTransport(t, [{ status }]);
        await assert.rejects(client.request({ method: 'GET', url: '/fixture' }), error => error.error === 'fixture-failure');
        assert.equal(calls.length, 1);
    });
}

test('API exhausted network retries reach the existing block handler', async t => {
    const { client, calls, RateLimitError } = realTransport(t, [{ code: 'ECONNRESET' }]);
    await assert.rejects(client.request({ method: 'GET', url: '/fixture' }), error => error instanceof RateLimitError);
    assert.equal(calls.length, 3);
    assert.equal(client.isBlocked, true);
});

test('OAuth network failures use the configured three retries before storing a token', async t => {
    const token = { access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', token_type: 'Bearer', expires_in: 3600 };
    const { calls, oauth } = realTransport(t, [
        { code: 'ECONNRESET' }, { code: 'ECONNRESET' }, { code: 'ECONNRESET' }, { data: token },
    ]);
    const { manager, storage } = oauth();
    await manager.refreshCredentials();
    assert.equal(calls.length, 4);
    assert.ok(calls.every(config => config.method === 'post' && config.url === '/token'));
    assert.equal(manager.accessToken, token.access_token);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'simplisafe3auth.json'), 'utf8')).refreshToken, token.refresh_token);
});

test('OAuth server errors do not repeat the POST or clear a valid refresh token', async t => {
    const { calls, oauth } = realTransport(t, [{ status: 503 }]);
    const { manager } = oauth();
    await assert.rejects(manager.refreshCredentials(), error => axios.isAxiosError(error) && error.response.status === 503);
    assert.equal(calls.length, 1);
    assert.equal(manager.refreshToken, 'fixture-old-refresh');
});

test('OAuth invalid credentials are not retried', async t => {
    const { calls, oauth } = realTransport(t, [{ status: 400, data: { error: 'invalid_grant' } }]);
    const { manager } = oauth();
    await assert.rejects(manager.refreshCredentials(), error => axios.isAxiosError(error) && error.response.status === 400);
    assert.equal(calls.length, 1);
    assert.equal(manager.refreshToken, null);
});

test('retryable API errors respect the server Retry-After delay', async t => {
    const nativeTimeout = global.setTimeout;
    const delays = [];
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
        delays.push(delay);
        return nativeTimeout(callback, delay === 1500 ? 0 : delay, ...args);
    });
    const { client } = realTransport(t, [{ status: 503, headers: { 'retry-after': '1.5' } }, { data: { ok: true } }]);
    assert.deepEqual(await client.request({ method: 'GET', url: '/fixture' }), { ok: true });
    assert.ok(delays.includes(1500));
});

test('real HTTP clients collapse twenty matching sensor reads into one request', async t => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const { client, calls } = realTransport(t, [{ wait, data: { sensors: [{ serial: 'sensor-1' }] } }]);
    client.subId = 'fixture-sub';
    const reads = Promise.all(Array.from({ length: 20 }, () => client.getSensors(true)));
    await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    release();
    assert.ok((await reads).every(sensors => sensors[0].serial === 'sensor-1'));
    assert.equal(calls.length, 1);
});

test('twenty requests with expired credentials share one real OAuth exchange', async t => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const token = { access_token: 'fixture-refreshed-access', refresh_token: 'fixture-refreshed-token', token_type: 'Bearer', expires_in: 3600 };
    const { client, calls, oauth } = realTransport(t, [{ wait, data: token }, { data: { ok: true } }]);
    const { manager } = oauth();
    client.authManager = manager;
    const reads = Promise.all(Array.from({ length: 20 }, (_, i) => client.request({ method: 'GET', url: `/fixture/${i}` })));
    await waitFor(() => calls.length === 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/token');
    release();
    assert.ok((await reads).every(value => value.ok));
    assert.equal(calls.filter(config => config.url === '/token').length, 1);
    const apiReads = calls.filter(config => config.url !== '/token');
    assert.equal(apiReads.length, 20);
    assert.ok(apiReads.every(config => config.headers.Authorization === 'Bearer fixture-refreshed-access'));
});

test('a timed-out cached HTTP read can be requested again without a poisoned cache', async t => {
    const nativeTimeout = global.setTimeout;
    let expire;
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
        if (delay === 20000) expire = callback;
        return nativeTimeout(callback, delay, ...args);
    });
    const { client, calls, RateLimitError } = realTransport(t, [{ wait: new Promise(() => {}) }, { data: { sensors: [{ serial: 'recovered' }] } }]);
    client.subId = 'fixture-sub';
    const failed = assert.rejects(client.getSensors(), error => error instanceof RateLimitError);
    await new Promise(setImmediate);
    expire();
    await failed;
    assert.equal(calls[0].signal.aborted, true);
    client.resetRateLimitHandler();
    assert.equal((await client.getSensors())[0].serial, 'recovered');
    assert.equal(calls.length, 2);
});

test('camera wake commands and short-lived stream tokens are not shared', async t => {
    const { client, calls } = realTransport(t, [{ data: {
        liveKitDetails: { liveKitURL: 'wss://fixture.invalid', userToken: 'fixture-camera-token' }, cameraStatus: 'online',
    } }]);
    client.subId = 'fixture-sub';
    await Promise.all([client.wakeCameras(), client.wakeCameras(), client.getCameraLiveView('camera-1'), client.getCameraLiveView('camera-1')]);
    assert.equal(calls.filter(config => config.method === 'post').length, 2);
    assert.equal(calls.filter(config => config.method === 'get').length, 2);
});

test('caller cancellation does not activate the API block handler', async t => {
    const { client, calls } = realTransport(t, [{ wait: new Promise(() => {}) }]);
    const controller = new AbortController();
    const failed = assert.rejects(client.request({ method: 'GET', url: '/fixture', signal: controller.signal }), /fixture cancellation/);
    await new Promise(setImmediate);
    controller.abort(new Error('fixture cancellation'));
    await failed;
    assert.equal(calls.length, 1);
    assert.equal(client.isBlocked, false);
});

test('an exhausted credential network failure is preserved without a response dereference error', async t => {
    const { client, calls, oauth } = realTransport(t, [{ code: 'ECONNRESET' }]);
    const { manager } = oauth();
    client.authManager = manager;
    await assert.rejects(client.request({ method: 'GET', url: '/fixture' }), error => axios.isAxiosError(error) && error.code === 'ECONNRESET');
    assert.equal(calls.length, 4);
    assert.ok(calls.every(config => config.url === '/token'));
    assert.equal(manager.refreshToken, 'fixture-old-refresh');
});

test('an already-cancelled API request does not start credential refresh', async t => {
    const { client, calls, oauth } = realTransport(t, [{ data: {} }]);
    client.authManager = oauth().manager;
    const controller = new AbortController();
    controller.abort(new Error('fixture already cancelled'));
    await assert.rejects(client.request({ method: 'GET', url: '/fixture', signal: controller.signal }), /fixture already cancelled/);
    assert.equal(calls.length, 0);
});
