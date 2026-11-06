const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { createRequire } = require('node:module');
const cp = require('node:child_process');

const root = path.resolve(process.env.SIMPLISAFE_CAMERA_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const fromPlugin = createRequire(path.join(root, 'package.json'));
const wsPath = fromPlugin.resolve('ws');
// No cloud access: exercise the actual source lifecycle with a signalling fixture.
const sockets = [];
class Socket extends EventEmitter {
    constructor() { super(); sockets.push(this); }
    terminate() { this.terminated = true; }
    send() {}
}
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: Socket };
const Source = require(path.join(root, 'lib/liveKitSource')).default;
const Delegate = require(path.join(root, 'lib/streamingDelegate')).default;
const flush = () => new Promise(setImmediate);
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
function camera(simplisafe = {}) {
    return {
        id: 'fixture-camera', name: 'Fixture', debug: false,
        log: Object.assign(() => {}, { error: () => {} }),
        simplisafe: { wakeCameras: async () => {}, getCameraLiveView: async () => ({ liveKitURL: 'wss://fixture.invalid', userToken: 'fixture' }), ...simplisafe },
        authManager: { tokenType: 'Bearer', accessToken: 'fixture' },
    };
}
function delegate(cam = camera()) {
    // These operations need no Homebridge controller or real accessory.
    return Object.assign(Object.create(Delegate.prototype), {
        ss3Camera: cam, simplisafe: cam.simplisafe, log: cam.log,
        liveKitSessions: {}, snapshotWarming: null, snapshotRetryAfter: 0,
    });
}
function deadline(t, milliseconds) {
    const original = global.setTimeout;
    let fire;
    const timer = { fixture: true };
    t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
        if (delay === milliseconds) { fire = fn; return timer; }
        return original(fn, delay, ...args);
    });
    const clear = t.mock.method(global, 'clearTimeout');
    return { expire: () => { assert.equal(typeof fire, 'function'); fire(); }, cleared: () => clear.mock.calls.some(call => call.arguments[0] === timer) };
}

for (const phase of ['wake', 'room']) {
    test(`closing during ${phase} lookup rejects promptly and cannot open a late socket`, async () => {
        const waiting = deferred();
        let roomCalls = 0;
        const cam = camera({
            wakeCameras: () => phase === 'wake' ? waiting.promise : Promise.resolve(),
            getCameraLiveView: () => { roomCalls++; return waiting.promise; },
        });
        const source = new Source(cam);
        const before = sockets.length;
        const pending = source.connect();
        assert.equal(source.connect(), pending, 'one connection per source');
        await flush();
        source.close();
        await assert.rejects(pending, /session closed/);
        waiting.resolve({ liveKitURL: 'wss://fixture.invalid', userToken: 'fixture' });
        await flush();
        assert.equal(sockets.length, before);
        assert.equal(roomCalls, phase === 'wake' ? 0 : 1);
        await assert.rejects(source.connect(), /session closed/);
    });
}

test('connection deadline includes camera wake and aborts the pending request', async t => {
    const clock = deadline(t, 30000);
    let signal;
    const source = new Source(camera({ wakeCameras: value => { signal = value; return new Promise(() => {}); } }));
    const pending = source.connect();
    clock.expire();
    await assert.rejects(pending, /Timed out after 30000ms/);
    assert.equal(source.closed, true);
    assert.equal(signal.aborted, true);
    assert.ok(clock.cleared());
});

test('deadline before first video terminates signalling and clears its listeners', async t => {
    const clock = deadline(t, 30000);
    const source = new Source(camera());
    const pending = source.connect();
    await flush();
    const socket = sockets.at(-1);
    clock.expire();
    await assert.rejects(pending, /Timed out/);
    assert.equal(socket.terminated, true);
    assert.equal(socket.listenerCount('message'), 0);
});

test('closing during an offer prevents a late answer from reopening work', async () => {
    const { SignalResponse, SessionDescription } = fromPlugin('@livekit/protocol');
    const waiting = deferred();
    const source = new Source(camera());
    const pending = source.connect();
    await flush();
    let answers = 0;
    source.pc = {
        setRemoteDescription: () => waiting.promise,
        createAnswer: async () => { answers++; }, close: async () => {},
    };
    sockets.at(-1).emit('message', new SignalResponse({ message: { case: 'offer', value: new SessionDescription({ type: 'offer', sdp: 'fixture' }) } }).toBinary());
    await flush();
    source.close();
    await assert.rejects(pending, /session closed/);
    waiting.resolve();
    await flush();
    assert.equal(answers, 0);
});

test('first video clears setup deadline; ending a stream releases socket and async peer failure', async t => {
    const clock = deadline(t, 30000);
    const source = new Source(camera());
    const pending = source.connect();
    await flush();
    const socket = sockets.at(-1);
    let notifications = 0;
    source.onSessionEnded = () => { notifications++; };
    source.pc = { close: async () => { throw new Error('already closed'); } };
    source.streaming = true;
    source._onFirstVideo();
    await pending;
    assert.ok(clock.cleared());
    socket.emit('close');
    await flush();
    assert.equal(notifications, 1);
    assert.equal(source.closed, true);
    assert.equal(socket.terminated, true);
    assert.equal(socket.listenerCount('message'), 0);
    source.close();
    assert.equal(notifications, 1);
});

test('keyframe timeout cancels a connection still waiting for camera wake', async t => {
    const clock = deadline(t, 15000);
    let signal;
    const d = delegate(camera({ wakeCameras: value => { signal = value; return new Promise(() => {}); } }));
    const pending = d.warmSnapshot();
    clock.expire();
    await assert.rejects(pending, /keyframe/);
    assert.ok(signal.aborted);
    assert.equal(d.snapshotWarming, null);
});

test('event snapshot deadline aborts a stalled body and releases its timer', async t => {
    const clock = deadline(t, 15000);
    let signal;
    t.mock.method(global, 'fetch', async (url, options) => {
        signal = options.signal;
        return { ok: true, arrayBuffer: () => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) };
    });
    const d = delegate();
    const pending = d.fetchEventSnapshot('https://fixture.invalid/snapshot');
    await flush();
    clock.expire();
    await assert.rejects(pending, /Event snapshot timed out/);
    assert.ok(signal.aborted);
    assert.ok(clock.cleared());
    assert.equal(d.cachedSnapshot, undefined);
});

test('event snapshot discards error bodies and releases deadline on failure', async t => {
    const clock = deadline(t, 15000);
    let discarded = false;
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 401, body: { cancel: async () => { discarded = true; } } }));
    await assert.rejects(delegate().fetchEventSnapshot('https://fixture.invalid'), /HTTP 401/);
    assert.ok(discarded);
    assert.ok(clock.cleared());
});

test('stalled decoder is killed and its process exits after the snapshot deadline', async t => {
    const spawn = cp.spawn;
    let child;
    t.mock.method(cp, 'spawn', () => {
        child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)']);
        return child;
    });
    const clock = deadline(t, 8000);
    const pending = delegate().jpegFromKeyframe(Buffer.from('fixture'));
    const closed = once(child, 'close');
    clock.expire();
    await assert.rejects(pending, /decoder timed out/);
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.ok(clock.cleared());
});

test('snapshot decoder caps output and kills excessive producers', async t => {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => {} }),
        kill: signal => { child.killedWith = signal; },
    });
    t.mock.method(cp, 'spawn', () => child);
    const pending = delegate().jpegFromKeyframe(Buffer.from('fixture'));
    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(pending, /exceeded 4 MiB/);
    assert.equal(child.killedWith, 'SIGKILL');
});

test('successful decoder returns JPEG bytes and releases its deadline', async t => {
    const clock = deadline(t, 8000);
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => {} }),
        kill: () => assert.fail('successful decoder should not be killed'),
    });
    t.mock.method(cp, 'spawn', () => child);
    const pending = delegate().jpegFromKeyframe(Buffer.from('fixture'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    child.stdout.emit('data', jpeg);
    child.emit('close', 0);
    assert.deepEqual(await pending, jpeg);
    assert.ok(clock.cleared());
});
