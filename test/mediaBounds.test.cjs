const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(process.env.SIMPLISAFE_CAMERA_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const Delegate = require(path.join(root, 'lib/streamingDelegate')).default;
const { default: Collector, maxFrameBytes } = require(path.join(root, 'lib/h264'));
function delegate() {
    return Object.assign(Object.create(Delegate.prototype), {
        ss3Camera: { debug: false, authManager: { tokenType: 'Bearer', accessToken: 'fixture' } },
        pendingSessions: {}, ongoingSessions: {}, liveKitSessions: {},
    });
}

test('event JPEG streaming stops and cancels its body at the four-MiB limit', async t => {
    let cancelled = false, chunks = 0;
    const body = new ReadableStream({
        pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
    });
    t.mock.method(global, 'fetch', async () => new Response(body));
    const d = delegate();
    await assert.rejects(d.fetchEventSnapshot('https://fixture.invalid'), /exceeded 4 MiB/);
    assert.equal(cancelled, true);
    assert.ok(chunks <= 6);
    assert.equal(d.cachedSnapshot, undefined);
});

test('an oversized declared event JPEG body is rejected and cancelled', async t => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    t.mock.method(global, 'fetch', async () => new Response(body, { headers: { 'content-length': String(5 * 1024 * 1024) } }));
    await assert.rejects(delegate().fetchEventSnapshot('https://fixture.invalid'), /exceeded 4 MiB/);
    assert.equal(cancelled, true);
});

test('normal streamed event JPEG bytes are cached unchanged', async t => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    t.mock.method(global, 'fetch', async () => new Response(jpeg));
    const d = delegate();
    assert.deepEqual(await d.fetchEventSnapshot('https://fixture.invalid'), jpeg);
    assert.deepEqual(d.cachedSnapshot, jpeg);
});

test('camera disposal aborts a stalled event body and prevents cache updates', async t => {
    let signal;
    t.mock.method(global, 'fetch', async (url, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        } }));
    });
    const d = delegate();
    const pending = d.fetchEventSnapshot('https://fixture.invalid');
    const failed = assert.rejects(pending, /Camera stopped/);
    await new Promise(setImmediate);
    d.dispose();
    await failed;
    assert.equal(signal.aborted, true);
    assert.equal(d.cachedSnapshot, null);
});

function packet(collector, payload, timestamp, sequenceNumber = 1, marker = false) {
    collector.push(payload, { timestamp, sequenceNumber, marker });
}
function parameters(collector, timestamp = 0) {
    packet(collector, Buffer.from([0x67, 1]), timestamp);
    packet(collector, Buffer.from([0x68, 1]), timestamp);
}

test('oversized H.264 access units are dropped and the next complete keyframe recovers', () => {
    const collector = new Collector();
    parameters(collector);
    const oversized = Buffer.alloc(maxFrameBytes + 1, 1); oversized[0] = 0x65;
    packet(collector, oversized, 0, 3);
    packet(collector, Buffer.from([0x65, 1]), 0, 4, true);
    assert.equal(collector.complete, false);
    assert.equal(collector.accessUnit.length, 0);
    packet(collector, Buffer.from([0x65, 2]), 1, 5, true);
    assert.equal(collector.complete, true);
    assert.ok(collector.annexB().length < 100);
});

test('fragmented H.264 NALs cannot grow beyond the frame budget', () => {
    const collector = new Collector();
    parameters(collector);
    const first = Buffer.alloc(1200); first[0] = 0x7c; first[1] = 0x85;
    packet(collector, first, 0, 1);
    const continuation = Buffer.alloc(1200); continuation[0] = 0x7c; continuation[1] = 0x05;
    for (let i = 2; i < Math.ceil(maxFrameBytes / 1198) + 4; i++) packet(collector, continuation, 0, i);
    assert.equal(collector.fragment, null);
    assert.equal(collector.accessUnit.length, 0);
    packet(collector, Buffer.from([0x65, 3]), 1, 1, true);
    assert.equal(collector.complete, true);
});

test('many tiny NALs are bounded by part count as well as byte count', () => {
    const collector = new Collector();
    parameters(collector);
    for (let i = 0; i < 8200; i++) packet(collector, Buffer.from([0x61, 1]), 0, i);
    assert.equal(collector.accessUnit.length, 0);
    packet(collector, Buffer.from([0x65, 4]), 1, 1, true);
    assert.equal(collector.complete, true);
});

test('oversized H.264 parameter sets are discarded without poisoning later frames', () => {
    const collector = new Collector();
    const oversized = Buffer.alloc(65537); oversized[0] = 0x67;
    packet(collector, oversized, 0);
    assert.equal(collector.sps, null);
    parameters(collector, 1);
    packet(collector, Buffer.from([0x65, 1]), 1, 3, true);
    assert.equal(collector.complete, true);
});
