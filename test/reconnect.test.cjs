const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const Client = require(path.join(root, 'simplisafe')).default;
function client() {
    return new Client(15000, Object.assign(new EventEmitter(), { isAuthenticated: () => true }), '/unused', Object.assign(() => {}, { warn: () => {}, error: () => {} }), false);
}

test('long outages keep reconnect timers within one minute instead of overflowing', t => {
    const delays = [];
    t.mock.method(global, 'setTimeout', (fn, delay) => { delays.push(delay); return {}; });
    t.mock.method(Math, 'random', () => 0.5);
    const api = client();
    for (const failures of [0, 1, 5, 6, 31, 1024, Infinity]) {
        api.nSocketConnectFailures = failures;
        api.isAwaitingSocketReconnect = false;
        api.handleSocketConnectionFailure();
    }
    assert.deepEqual(delays, [1100, 2200, 35200, 60000, 60000, 60000, 60000]);
    api.handleSocketConnectionFailure();
    assert.equal(delays.length, 7, 'duplicate failures share the scheduled reconnect');
});

test('connecting socket failures are terminated and failed reconnects schedule recovery', async t => {
    const scheduled = [];
    t.mock.method(global, 'setTimeout', (fn, delay) => { scheduled.push({ fn, delay }); return {}; });
    const api = client();
    const socket = Object.assign(new EventEmitter(), { readyState: 0, terminate: () => { socket.emit('error', new Error('handshake cancelled')); } });
    api.socket = socket;
    api.handleSocketConnectionFailure();
    assert.equal(api.socket, null);
    assert.equal(scheduled.length, 1);
    api.startListening = async () => { throw new Error('offline'); };
    await scheduled[0].fn();
    assert.equal(scheduled.length, 2);
    assert.equal(api.isAwaitingSocketReconnect, true);
});

test('user lookup failure during socket setup schedules a retry and frees setup slot', async t => {
    const scheduled = t.mock.method(global, 'setTimeout', () => ({}));
    const api = client();
    let lookups = 0;
    api.getUserId = async () => { lookups++; throw new Error('offline'); };
    await Promise.all([api.startListening(), api.startListening()]);
    assert.equal(lookups, 1);
    assert.equal(api.socketConnecting, false);
    assert.equal(api.isAwaitingSocketReconnect, true);
    assert.equal(scheduled.mock.callCount(), 1);
});
