const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const { default: SimpliSafe3, RateLimitError } = require(path.join(root, 'simplisafe'));

test('client shutdown closes a real in-flight HTTP request without starting rate-limit backoff', { timeout: 5000 }, async t => {
    let arrived, closed;
    const received = new Promise(resolve => { arrived = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((request, response) => { response.on('close', closed); arrived(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const auth = Object.assign(new EventEmitter(), { isAuthenticated: () => true, tokenType: 'Bearer', accessToken: 'fixture' });
    const api = new SimpliSafe3(15000, auth, '/unused', () => {});
    t.after(() => api.dispose());
    const failed = assert.rejects(api.request({ method: 'GET', url: `http://127.0.0.1:${server.address().port}/held`, proxy: false }), /stopped/);
    await received;
    api.dispose();
    await failed;
    await disconnected;
    assert.equal(api.isBlocked, false);
    await assert.rejects(api.request({ method: 'GET', url: '/cannot-reopen' }), /stopped/);
});

test('HTTP deadline closes a real stalled loopback connection', { timeout: 5000 }, async t => {
    let arrived, closed;
    const received = new Promise(resolve => { arrived = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((request, response) => {
        assert.equal(request.socket.remoteAddress, '127.0.0.1');
        response.on('close', closed);
        arrived();
        // Deliberately leave the response open until the client aborts it.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const nativeTimeout = global.setTimeout;
    let expire;
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
        if (delay === 20000 && !expire) expire = callback;
        return nativeTimeout(callback, delay, ...args);
    });
    const auth = Object.assign(new EventEmitter(), { isAuthenticated: () => true, tokenType: 'Bearer', accessToken: 'fixture-access' });
    const logger = Object.assign(() => {}, { error: () => {} });
    const api = new SimpliSafe3(15000, auth, '/unused-fixture', logger, false);
    const failed = assert.rejects(api.request({
        method: 'GET', url: `http://127.0.0.1:${server.address().port}/stalled`, proxy: false,
    }), error => error instanceof RateLimitError && /timed out/.test(error.message));
    await received;
    expire();
    await failed;
    await disconnected;
    assert.equal(api.isBlocked, true);
});

test('twenty matching reads use one real HTTP request while commands remain independent', { timeout: 5000 }, async t => {
    let reads = 0, writes = 0, arrived, release;
    const received = new Promise(resolve => { arrived = resolve; });
    const server = http.createServer((request, response) => {
        assert.equal(request.socket.remoteAddress, '127.0.0.1');
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'POST') {
            writes++;
            response.end(JSON.stringify({ ok: true }));
            return;
        }
        reads++;
        const result = JSON.stringify({ sensors: [{ serial: 'sensor-1', read: reads }] });
        if (reads === 1) {
            release = () => response.end(result);
            arrived();
        } else response.end(result);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const auth = Object.assign(new EventEmitter(), { isAuthenticated: () => true, tokenType: 'Bearer', accessToken: 'fixture-access' });
    const api = new SimpliSafe3(15000, auth, '/unused-fixture', () => {}, false);
    api.subId = 'fixture-sub';
    const request = api.request.bind(api);
    api.request = config => request({ ...config, baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false });
    const burst = Promise.all(Array.from({ length: 20 }, () => api.getSensors(true)));
    burst.catch(() => {});
    await received;
    await new Promise(setImmediate);
    assert.equal(reads, 1);
    release();
    assert.ok((await burst).every(sensors => sensors[0].read === 1));
    await Promise.all([api.setAlarmState('home'), api.setAlarmState('home')]);
    assert.equal(writes, 2);
    assert.equal((await api.getSensors(true))[0].read, 2);
    assert.equal(reads, 2);
});
