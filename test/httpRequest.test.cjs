const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { default: withRequestTimeout, requestTimeoutMs } = require('../dist/lib/httpRequest');

function deadlineClock(t) {
    const timers = new Map();
    let id = 0;
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const handle = ++id;
        timers.set(handle, { callback, delay });
        return handle;
    });
    t.mock.method(global, 'clearTimeout', handle => timers.delete(handle));
    return timers;
}

test('HTTP success releases the deadline and abort listeners', async t => {
    const timers = deadlineClock(t);
    const parent = new AbortController();
    let signal;
    const result = await withRequestTimeout(async options => {
        signal = options.signal;
        assert.equal(options.timeout, 20000);
        return 'fixture-result';
    }, parent.signal);
    assert.equal(result, 'fixture-result');
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('HTTP failure also releases the deadline and abort listeners', async t => {
    const timers = deadlineClock(t);
    const parent = new AbortController();
    await assert.rejects(withRequestTimeout(async () => { throw new Error('fixture failure'); }, parent.signal), /fixture failure/);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('deadline aborts and rejects even when a request ignores cancellation', async t => {
    const timers = deadlineClock(t);
    let signal;
    const request = withRequestTimeout(options => { signal = options.signal; return new Promise(() => {}); });
    const failed = assert.rejects(request, { name: 'TimeoutError' });
    await Promise.resolve();
    const deadline = [...timers.values()][0];
    assert.equal(deadline.delay, requestTimeoutMs);
    deadline.callback();
    await failed;
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
});

test('caller cancellation stops an active request and releases its deadline', async t => {
    const timers = deadlineClock(t);
    const parent = new AbortController();
    let signal;
    const request = withRequestTimeout(options => { signal = options.signal; return new Promise(() => {}); }, parent.signal);
    const failed = assert.rejects(request, /fixture cancellation/);
    await Promise.resolve();
    parent.abort(new Error('fixture cancellation'));
    await failed;
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('an already-cancelled caller never starts its request', async t => {
    const timers = deadlineClock(t);
    const parent = new AbortController();
    parent.abort();
    let started = false;
    await assert.rejects(withRequestTimeout(async () => { started = true; }, parent.signal), { name: 'AbortError' });
    assert.equal(started, false);
    assert.equal(timers.size, 0);
});

test('a late transport failure after timeout is still observed without leaking its deadline', async t => {
    const timers = deadlineClock(t);
    let failTransport;
    const request = withRequestTimeout(() => new Promise((_, reject) => { failTransport = reject; }));
    const failed = assert.rejects(request, { name: 'TimeoutError' });
    await Promise.resolve();
    [...timers.values()][0].callback();
    await failed;
    failTransport(new Error('fixture late transport failure'));
    await new Promise(setImmediate);
    assert.equal(timers.size, 0);
});
