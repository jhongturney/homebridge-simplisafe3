const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const SimpliSafe3 = require(path.join(root, 'simplisafe')).default;
const flush = () => new Promise(setImmediate);
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function client(t, request, knownSubscription = true) {
    const auth = Object.assign(new EventEmitter(), { isAuthenticated: () => true });
    const logger = Object.assign(() => {}, { error: () => {}, warn: () => {} });
    const api = new SimpliSafe3(15000, auth, '/unused-fixture', logger, false);
    if (knownSubscription) api.subId = 'fixture-sub';
    const traffic = t.mock.method(api, 'request', request);
    return { api, traffic };
}

test('twenty concurrent sensor reads use one request and return the same data', async t => {
    const waiting = deferred();
    const { api, traffic } = client(t, () => waiting.promise);
    const reads = Promise.all(Array.from({ length: 20 }, () => api.getSensors(true)));
    await flush();
    assert.equal(traffic.mock.callCount(), 1);
    waiting.resolve({ sensors: [{ serial: 'sensor-1' }] });
    assert.deepEqual(await reads, Array.from({ length: 20 }, () => [{ serial: 'sensor-1' }]));
    await api.getSensors(true);
    assert.equal(traffic.mock.callCount(), 1);
});

test('concurrent startup discovery sends one request per endpoint', async t => {
    const { api, traffic } = client(t, async ({ url }) => {
        if (url === '/api/authCheck') return { userId: 'fixture-user' };
        if (url.startsWith('/users/')) return { subscriptions: [{ sid: 'fixture-sub', sStatus: 20, location: {} }] };
        if (url.startsWith('/subscriptions/')) return { subscription: { serial: 'system-1' } };
        if (url.includes('/sensors?')) return { sensors: [{ serial: 'sensor-1' }] };
        throw new Error(`Unexpected endpoint: ${url}`);
    }, false);
    await Promise.all(Array.from({ length: 20 }, () => api.getSensors(true)));
    const urls = traffic.mock.calls.map(call => call.arguments[0].url);
    assert.equal(urls.length, 4);
    assert.equal(new Set(urls).size, 4);
});

test('ordinary and forced sensor updates share only their matching request', async t => {
    const { api, traffic } = client(t, async ({ url }) => ({ sensors: [{ serial: url.endsWith('=true') ? 'forced' : 'ordinary' }] }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => api.getSensors(i % 2 === 0)));
    assert.equal(traffic.mock.callCount(), 2);
    assert.deepEqual(results[0], [{ serial: 'forced' }]);
    assert.deepEqual(results[1], [{ serial: 'ordinary' }]);
});

test('subscription and lock reads each share matching in-flight requests', async t => {
    const { api, traffic } = client(t, async ({ url }) => url.startsWith('/doorlock/')
        ? [{ serial: 'lock-1' }] : { subscription: { revision: 1 } });
    await Promise.all(Array.from({ length: 20 }, () => api.getSubscription()));
    await Promise.all(Array.from({ length: 20 }, () => api.getLocks()));
    assert.equal(traffic.mock.callCount(), 2);
    assert.equal(api.refreshLockoutEnabled, true);
});

test('successful reads expire after three seconds without timers or wall-clock dependence', async t => {
    let clock = 1000;
    let wall = 100000;
    t.mock.method(performance, 'now', () => clock);
    t.mock.method(Date, 'now', () => wall);
    const { api, traffic } = client(t, async () => ({ sensors: [{ serial: 'sensor-1' }] }));
    const timers = t.mock.method(global, 'setTimeout', () => { throw new Error('Read caches should not allocate timers'); });
    await api.getSensors();
    clock += 2999;
    await api.getSensors();
    assert.equal(traffic.mock.callCount(), 1);
    wall -= 100000;
    clock++;
    await api.getSensors();
    assert.equal(traffic.mock.callCount(), 2);
    assert.equal(timers.mock.callCount(), 0);
});

test('forced refresh bypasses completed cache but shares concurrent refreshes', async t => {
    const waiting = deferred();
    let count = 0;
    const { api, traffic } = client(t, () => ++count === 1
        ? Promise.resolve({ subscription: { revision: 1 } }) : waiting.promise);
    assert.equal((await api.getSubscription()).revision, 1);
    const updates = Promise.all(Array.from({ length: 20 }, () => api.getSubscription(true)));
    await flush();
    assert.equal(traffic.mock.callCount(), 2);
    waiting.resolve({ subscription: { revision: 2 } });
    assert.ok((await updates).every(value => value.revision === 2));
    assert.equal((await api.getSubscription()).revision, 2);
    assert.equal(traffic.mock.callCount(), 2);
});

test('a failed refresh clears its shared request and does not restore stale cache', async t => {
    let count = 0;
    const { api, traffic } = client(t, async () => {
        count++;
        if (count === 2) throw new Error('fixture failure');
        return { subscription: { revision: count } };
    });
    await api.getSubscription();
    await assert.rejects(Promise.all(Array.from({ length: 20 }, () => api.getSubscription(true))), /fixture failure/);
    assert.equal(traffic.mock.callCount(), 2);
    assert.equal((await api.getSubscription()).revision, 3);
    assert.equal(traffic.mock.callCount(), 3);
});

test('late reads from before a command cannot replace the new cached state', async t => {
    const old = deferred(), fresh = deferred();
    let reads = 0;
    const { api } = client(t, ({ method }) => {
        if (method === 'POST') return Promise.resolve({ ok: true });
        return ++reads === 1 ? old.promise : fresh.promise;
    });
    const previous = api.getSubscription();
    await flush();
    await api.setAlarmState('home');
    const updated = api.getSubscription();
    await flush();
    assert.equal(reads, 2);
    old.resolve({ subscription: { revision: 1 } });
    assert.equal((await previous).revision, 1);
    const joined = api.getSubscription();
    await flush();
    assert.equal(reads, 2);
    fresh.resolve({ subscription: { revision: 2 } });
    assert.equal((await updated).revision, 2);
    assert.equal((await joined).revision, 2);
    assert.equal((await api.getSubscription()).revision, 2);
    assert.equal(reads, 2);
});

test('alarm and lock commands are not shared and invalidate completed reads', async t => {
    let revision = 0;
    const { api, traffic } = client(t, async ({ method }) => method === 'POST'
        ? { ok: true } : { subscription: { revision: ++revision } });
    await api.getSubscription();
    await Promise.all([api.setAlarmState('home'), api.setAlarmState('home'), api.setLockState('lock-1', 'lock'), api.setLockState('lock-1', 'lock')]);
    assert.equal(traffic.mock.calls.filter(call => call.arguments[0].method === 'POST').length, 4);
    assert.equal((await api.getSubscription()).revision, 2);
});

test('read sharing is isolated between API clients', async t => {
    const first = client(t, async () => ({ subscription: { account: 'first' } }));
    const second = client(t, async () => ({ subscription: { account: 'second' } }));
    const [a, b] = await Promise.all([
        Promise.all(Array.from({ length: 20 }, () => first.api.getSubscription())),
        Promise.all(Array.from({ length: 20 }, () => second.api.getSubscription())),
    ]);
    assert.ok(a.every(value => value.account === 'first'));
    assert.ok(b.every(value => value.account === 'second'));
    assert.equal(first.traffic.mock.callCount(), 1);
    assert.equal(second.traffic.mock.callCount(), 1);
});

function pollClock(t) {
    const timers = [];
    t.mock.method(global, 'setInterval', (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    });
    t.mock.method(global, 'clearInterval', () => {});
    return timers;
}

for (const kind of ['sensor', 'alarm']) {
    test(`${kind} polling coalesces overlapping ticks and recovers after failure`, async t => {
        const timers = pollClock(t);
        const { api } = client(t, async () => { throw new Error('Unexpected HTTP request'); });
        const waiting = deferred();
        const delivered = [];
        const data = kind === 'sensor' ? [{ serial: 'fixture' }] : { serial: 'fixture' };
        let calls = 0;
        api[kind === 'sensor' ? 'getSensors' : 'getAlarmSystem'] = async () => {
            calls++;
            if (calls === 1) return waiting.promise;
            if (calls === 2) throw new Error('fixture poll failure');
            return data;
        };
        const errors = t.mock.method(api, 'handleErrorSuppression', () => {});
        api[kind === 'sensor' ? 'subscribeToSensor' : 'subscribeToAlarmSystem']('fixture', value => delivered.push(value));
        assert.equal(timers[0].delay, kind === 'sensor' ? 15000 : 62000);
        const active = timers[0].callback();
        await Promise.all(Array.from({ length: 20 }, () => timers[0].callback()));
        assert.equal(calls, 1);
        waiting.resolve(data);
        await active;
        assert.equal(delivered.length, 1);
        assert.equal(calls, 2);
        assert.equal(errors.mock.callCount(), 1);
        await timers[0].callback();
        assert.equal(calls, 3);
        assert.equal(delivered.length, 2);
    });
}

test('sensor polling can restart after its final subscription is removed', async t => {
    const timers = pollClock(t);
    const { api } = client(t, async () => { throw new Error('Unexpected HTTP request'); });
    api.getSensors = async () => [{ serial: 'fixture' }];
    api.subscribeToSensor('fixture', () => {});
    api.unsubscribeFromSensor('fixture');
    let updates = 0;
    api.subscribeToSensor('fixture', () => { updates++; });
    assert.equal(timers.length, 2);
    await timers[1].callback();
    assert.equal(updates, 1);
});

test('polling respects the existing lockout and skips empty subscriptions', async t => {
    const timers = pollClock(t);
    const { api } = client(t, async () => { throw new Error('Unexpected HTTP request'); });
    let reads = 0;
    api.getSensors = api.getAlarmSystem = async () => { reads++; return []; };
    api.subscribeToSensor('fixture', () => {});
    api.subscribeToAlarmSystem('fixture', () => {});
    api.refreshLockoutTimeoutID = true;
    await Promise.all(timers.map(timer => timer.callback()));
    api.refreshLockoutTimeoutID = undefined;
    api.sensorSubscriptions = [];
    api.alarmSubscriptions = [];
    await Promise.all(timers.map(timer => timer.callback()));
    assert.equal(reads, 0);
});

test('an alarm poll waits for an active sensor poll and runs before newer sensor ticks', async t => {
    const timers = pollClock(t);
    const { api } = client(t, async () => { throw new Error('Unexpected HTTP request'); });
    const first = deferred();
    const order = [];
    api.getSensors = async () => {
        order.push('sensor');
        await first.promise;
        return [];
    };
    api.getAlarmSystem = async () => {
        order.push('alarm');
        return { serial: 'fixture' };
    };
    api.subscribeToSensor('fixture', () => {});
    api.subscribeToAlarmSystem('fixture', () => {});
    const running = timers[0].callback();
    await timers[1].callback();
    await timers[0].callback();
    await timers[0].callback();
    assert.deepEqual(order, ['sensor']);
    first.resolve();
    await running;
    assert.deepEqual(order, ['sensor', 'alarm', 'sensor']);
});

test('an in-flight poll failure pauses queued work and recovery starts with a single poll', async t => {
    const timers = pollClock(t);
    const cooldownTimers = [];
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay };
        cooldownTimers.push(timer);
        return timer;
    });
    t.mock.method(global, 'clearTimeout', () => {});
    const { api } = client(t, async () => { throw new Error('Unexpected HTTP request'); });
    const { RateLimitError } = require(path.join(root, 'simplisafe'));
    const failedSensor = deferred();
    const failedAlarm = deferred();
    const order = [];
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    api.getSensors = async () => {
        order.push('sensor');
        return failedSensor.promise;
    };
    api.getAlarmSystem = async () => {
        order.push('alarm');
        return failedAlarm.promise;
    };
    api.subscribeToSensor('fixture', () => {});
    api.subscribeToAlarmSystem('fixture', () => {});
    const running = timers[0].callback();
    await timers[1].callback();

    api.setRateLimitHandler();
    failedSensor.reject(new RateLimitError('fixture timeout'));
    await running;
    assert.deepEqual(order, ['sensor']);
    assert.equal(cooldownTimers.at(-1).delay, 60000);
    now += 15000;
    await timers[0].callback();
    assert.deepEqual(order, ['sensor']);
    assert.equal(cooldownTimers.at(-1).delay, 45000);

    now += 45000;
    const recovery = cooldownTimers.at(-1).callback();
    await timers[1].callback();
    assert.deepEqual(order, ['sensor', 'alarm']);
    api.setRateLimitHandler();
    failedAlarm.reject(new RateLimitError('fixture forbidden'));
    await recovery;
    assert.deepEqual(order, ['sensor', 'alarm']);
    assert.equal(cooldownTimers.at(-1).delay, 120000);

    api.dispose();
    now += 120000;
    await cooldownTimers.at(-1).callback();
    assert.deepEqual(order, ['sensor', 'alarm']);
});
