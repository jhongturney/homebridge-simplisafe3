const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dns = require('node:dns');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const root = path.resolve(process.env.SIMPLISAFE_CAMERA_TEST_ROOT || path.join(__dirname, '..', 'dist'));
async function start(t) {
    const lookup = t.mock.method(dns, 'lookup', (host, callback) => callback(null, '127.0.0.1', 4));
    lookup[promisify.custom] = async () => ({ address: '127.0.0.1', family: 4 });
    const cmd = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0,
        kill() { this.killed++; },
    });
    const spawn = t.mock.method(cp, 'spawn', () => cmd);
    const modulePath = require.resolve(path.join(root, 'lib/streamingDelegate'));
    delete require.cache[modulePath];
    const Delegate = require(modulePath).default;
    const forced = [], calls = [];
    const d = Object.assign(Object.create(Delegate.prototype), {
        pendingSessions: { fixture: { address: '127.0.0.1', video_ssrc: 1, audio_ssrc: 2, video_port: 5000, audio_port: 5002,
            video_srtp: Buffer.alloc(30), audio_srtp: Buffer.alloc(30) } }, ongoingSessions: {}, liveKitSessions: {},
        ss3Camera: { debug: false, ffmpegPath: 'fixture-ffmpeg', cameraOptions: { ffmpegPath: 'fixture-ffmpeg' },
            getStreamProvider: () => 'legacy', isUnsupported: () => false, authManager: { accessToken: 'fixture' },
            cameraDetails: { uuid: 'fixture-camera' } },
        cameraDetails: { cameraSettings: { admin: { fps: 15, bitRate: 300 } } },
        api: { hap: { uuid: { unparse: () => 'fixture' } } }, simplisafe: {},
        controller: { forceStopStreamingSession: id => forced.push(id) },
        log: Object.assign(() => {}, { error: () => {} }),
    });
    t.after(() => d.dispose());
    await d.handleStreamRequest({ sessionID: 'fixture', type: 'start', video: { width: 640, fps: 15, max_bit_rate: 300 }, audio: { codec: 'AAC-eld', sample_rate: 16, max_bit_rate: 24 } }, (...args) => calls.push(args));
    return { d, cmd, spawn, forced, calls };
}

test('legacy readiness waits for a frame, not an FFmpeg warning; completion happens once', async t => {
    const { cmd, spawn, calls, forced } = await start(t);
    assert.equal(spawn.mock.callCount(), 1);
    assert.deepEqual(spawn.mock.calls[0].arguments[1].slice(0, 3), ['-progress', 'pipe:1', '-nostats']);
    cmd.stderr.emit('data', Buffer.from('warning: fixture camera connecting\n'));
    assert.equal(calls.length, 0);
    cmd.stdout.emit('data', Buffer.from('fra'));
    cmd.stdout.emit('data', Buffer.from('me=1\nprogress=continue\n'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], undefined);
    cmd.emit('error', new Error('fixture failed after start'));
    cmd.emit('close', 1);
    assert.equal(calls.length, 1);
    assert.equal(forced.length, 1);
});

test('legacy spawn error followed by close reports one error and removes the session', async t => {
    const { d, cmd, calls } = await start(t);
    cmd.emit('error', new Error('fixture spawn failure'));
    cmd.emit('close', -2);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /spawn failure/);
    assert.equal(d.ongoingSessions.fixture, undefined);
});

test('early zero-code FFmpeg exit is a startup failure rather than a hanging callback', async t => {
    const { cmd, calls } = await start(t);
    cmd.emit('close', 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /before streaming started/);
});

test('legacy startup deadline kills a stalled process and returns one error', async t => {
    const original = global.setTimeout;
    const deadlines = [];
    t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
        if (delay === 20000) { deadlines.push(fn); return {}; }
        return original(fn, delay, ...args);
    });
    const { cmd, calls } = await start(t);
    deadlines.at(-1)();
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /startup timed out/);
    assert.equal(cmd.killed, 1);
    cmd.emit('close', null);
    assert.equal(calls.length, 1);
});

test('stop during legacy startup completes the pending callback and prevents later readiness', async t => {
    const { d, cmd, calls } = await start(t);
    let stopped = 0;
    await d.handleStreamRequest({ sessionID: 'fixture', type: 'stop' }, () => stopped++);
    cmd.stdout.emit('data', Buffer.from('frame=1\n'));
    assert.equal(stopped, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /stopped/);
});
