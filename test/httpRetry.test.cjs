const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');

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
            t.after(() => {
                clearInterval(manager.refreshInterval);
                fs.rmSync(storage, { recursive: true, force: true });
            });
            return { manager, storage };
        },
    };
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
    const { calls, oauth } = realTransport(t, [{ status: 400 }]);
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
        return nativeTimeout(callback, 0, ...args);
    });
    const { client } = realTransport(t, [{ status: 503, headers: { 'retry-after': '1.5' } }, { data: { ok: true } }]);
    assert.deepEqual(await client.request({ method: 'GET', url: '/fixture' }), { ok: true });
    assert.ok(delays.includes(1500));
});
