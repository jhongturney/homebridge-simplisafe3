const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const { default: Client, EVENT_TYPES } = require(path.join(root, 'simplisafe'));
const Camera = require(path.join(root, 'accessories/camera')).default;
const DoorLock = require(path.join(root, 'accessories/doorLock')).default;
const Base = require(path.join(root, 'accessories/ss3Accessory')).default;
const Delegate = require(path.join(root, 'lib/streamingDelegate')).default;
const logger = Object.assign(() => {}, { error: () => {}, warn: () => {} });
const flush = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function delegate() {
    return Object.assign(Object.create(Delegate.prototype), {
        pendingSessions: {}, ongoingSessions: {}, liveKitSessions: {},
        ss3Camera: { debug: false }, log: logger, simplisafe: {},
    });
}

test('overlapping camera motion restarts one reset timer and disposal preserves other listeners', t => {
    const timers = [];
    const schedule = global.setTimeout, clear = global.clearTimeout;
    t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
        if (delay !== 5000) return schedule(fn, delay, ...args);
        const timer = { fn }; timers.push(timer); return timer;
    });
    t.mock.method(global, 'clearTimeout', timer => { if (timer?.fn) timer.cancelled = true; else clear(timer); });
    const bus = new EventEmitter();
    let foreign = 0;
    bus.on(EVENT_TYPES.CAMERA_MOTION, () => foreign++);
    const values = [];
    const camera = Object.assign(Object.create(Camera.prototype), {
        simplisafe: bus, log: logger, _validateEvent: () => true,
        streamingDelegate: { refreshSnapshotFromEvent() {}, dispose() {} },
        accessory: { getService: () => ({ updateCharacteristic: (type, value) => values.push(value) }) },
        api: { hap: { Service: { MotionSensor: 'motion' }, Characteristic: { MotionDetected: 'motion' } } },
    });
    camera.startListening();
    bus.emit(EVENT_TYPES.CAMERA_MOTION, {});
    bus.emit(EVENT_TYPES.CAMERA_MOTION, {});
    assert.equal(timers[0].cancelled, true);
    assert.equal(camera.timers.size, 1);
    assert.equal(camera.motionIsTriggered, true);
    timers[1].fn();
    assert.deepEqual(values, [true, true, false]);
    camera.dispose();
    camera.dispose();
    assert.equal(bus.listenerCount(EVENT_TYPES.CAMERA_MOTION), 1);
    bus.emit(EVENT_TYPES.CAMERA_MOTION, {});
    assert.equal(foreign, 3);
    assert.equal(values.length, 3);
});

test('failed lock-event lookup is caught rather than escaping as an unhandled rejection', async () => {
    const errors = [];
    const lock = Object.assign(Object.create(DoorLock.prototype), {
        simplisafe: new EventEmitter(), _validateEvent: () => true,
        getLockInformation: async () => { throw new Error('fixture offline'); },
        log: { error: (...args) => errors.push(args) },
    });
    lock.startListening();
    lock.simplisafe.emit(EVENT_TYPES.DOORLOCK_ERROR, {});
    await flush();
    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /offline/);
    lock.dispose();
});

test('failed shutter-state lookup completes the HomeKit snapshot callback exactly once', async t => {
    const d = delegate();
    d.ss3Camera = { debug: false, getStreamProvider: () => 'legacy', isUnsupported: () => false, supportsPrivacyShutter: () => true };
    d.cameraDetails = { cameraSettings: { cameraName: 'fixture' } };
    d.simplisafe.getAlarmSystem = async () => { throw new Error('fixture offline'); };
    const snapshot = require(path.join(root, 'lib/jpegSnapshot'));
    const download = t.mock.method(snapshot, 'default', async () => assert.fail('must not open a shutter'));
    const calls = [];
    await d.handleSnapshotRequest({ width: 640, height: 480 }, (...args) => calls.push(args));
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /offline/);
    assert.equal(download.mock.callCount(), 0);
});

test('shutdown while a privacy check is pending cancels the callback and prevents late downloading', async t => {
    const d = delegate();
    const waiting = deferred();
    d.ss3Camera = { debug: false, getStreamProvider: () => 'legacy', isUnsupported: () => false, supportsPrivacyShutter: () => true };
    d.cameraDetails = { cameraSettings: { cameraName: 'fixture', shutterOff: 'open' } };
    d.simplisafe.getAlarmSystem = () => waiting.promise;
    const snapshot = require(path.join(root, 'lib/jpegSnapshot'));
    const download = t.mock.method(snapshot, 'default', async () => assert.fail('late snapshot download'));
    const calls = [];
    const pending = d.handleSnapshotRequest({ width: 640, height: 480 }, (...args) => calls.push(args));
    d.dispose();
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].message, /stopped/);
    waiting.resolve({ alarmState: 'OFF' });
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(download.mock.callCount(), 0);
});

test('camera disposal releases prepared, active and legacy sessions idempotently', () => {
    const d = delegate();
    let prepared = 0, active = 0, socket = 0, killed = 0;
    d.pendingSessions.fixture = { liveKitSource: { close: () => prepared++ } };
    d.liveKitSessions.fixture = { source: { close: () => active++ }, socket: { close: () => socket++ } };
    d.ongoingSessions.fixture = { kill: () => killed++ };
    d.dispose(); d.dispose();
    assert.deepEqual([prepared, active, socket, killed], [1, 1, 1, 1]);
    assert.deepEqual(Object.keys(d.pendingSessions), []);
    assert.deepEqual(Object.keys(d.liveKitSessions), []);
    assert.equal(d.refreshSnapshot(), null);
});

test('camera disposal clears HomeKit wait timers even if background work never settles', async t => {
    const d = delegate();
    d.ss3Camera.getStreamProvider = () => 'livekit';
    d.cameraDetails = { cameraSettings: { cameraName: 'fixture' } };
    d.eventSnapshot = new Promise(() => {});
    const original = global.setTimeout;
    let timer;
    t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
        const value = original(fn, delay, ...args);
        if (delay === 3000) timer = value;
        return value;
    });
    const calls = [];
    const pending = d.handleSnapshotRequest({ width: 640, height: 480 }, (...args) => calls.push(args));
    d.dispose();
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(timer._destroyed, true);
});

test('disposing a client removes only its auth listener and stops polls and reconnects', () => {
    const auth = Object.assign(new EventEmitter(), { isAuthenticated: () => true });
    let other = 0;
    auth.on('REFRESH_CREDENTIALS_FAILURE', () => other++);
    const api = new Client(15000, auth, '/unused', logger);
    const first = api.subscribeToSensor('fixture', () => {});
    api.subscribeToSensor('fixture', () => {});
    first();
    assert.equal(api.sensorSubscriptions.length, 1);
    api.subscribeToAlarmSystem('fixture', () => {});
    api.handleSocketConnectionFailure();
    const timers = [api.sensorRefreshIntervalID, api.alarmRefreshIntervalID, api.socketReconnectTimeoutID];
    api.dispose(); api.dispose();
    assert.ok(timers.every(timer => timer._destroyed));
    assert.equal(api.sensorSubscriptions.length, 0);
    assert.equal(auth.listenerCount('REFRESH_CREDENTIALS_FAILURE'), 1);
    auth.emit('REFRESH_CREDENTIALS_FAILURE');
    assert.equal(other, 1);
});

test('client shutdown during user lookup prevents a late websocket connection', async t => {
    t.mock.method(require('node:https'), 'request', () => assert.fail('unexpected network connection'));
    const api = new Client(15000, Object.assign(new EventEmitter(), { isAuthenticated: () => true }), '/unused', logger);
    const waiting = deferred();
    api.getUserId = () => waiting.promise;
    const pending = api.startListening();
    api.dispose();
    waiting.resolve('fixture-user');
    await pending;
    assert.equal(api.socket, undefined);
});

test('disposed accessories cannot schedule replacement timers or process more events', () => {
    const accessory = Object.assign(Object.create(Base.prototype), { log: logger });
    const bus = new EventEmitter();
    let calls = 0;
    accessory.listen(bus, 'fixture', () => calls++);
    accessory.dispose();
    assert.equal(accessory.defer(() => calls++, 1), undefined);
    bus.emit('fixture');
    assert.equal(calls, 0);
});

test('platform shutdown prevents late discovery after an initial refresh completes', async t => {
    const fs = require('node:fs'), os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-shutdown-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const Auth = require(path.join(root, 'lib/authManager')).default;
    const waiting = deferred();
    t.mock.method(Auth.prototype, 'refreshCredentials', () => waiting.promise);
    let Platform;
    require(root).default({ hap: { uuid: {} }, registerPlatform: (name, alias, constructor) => { Platform = constructor; } });
    const api = Object.assign(new EventEmitter(), { user: { storagePath: () => dir } });
    const platform = new Platform(logger, { name: 'fixture' }, api);
    platform.configureAccessory({ UUID: 'fixture' });
    let discoveries = 0;
    platform.discoverSimpliSafeDevices = async () => discoveries++;
    api.emit('shutdown');
    api.emit('didFinishLaunching');
    waiting.resolve();
    await platform.initialLoad;
    await Promise.all(platform.cachedAccessoryConfig);
    assert.equal(discoveries, 0);
    assert.equal(platform.simplisafe.lifecycle.signal.aborted, true);
});

test('poll failures arriving after shutdown cannot recreate suppression timers', async t => {
    const ticks = [];
    t.mock.method(global, 'setInterval', fn => { ticks.push(fn); return {}; });
    const scheduled = t.mock.method(global, 'setTimeout', () => ({}));
    let reject;
    const pending = new Promise((resolve, fail) => { reject = fail; });
    const api = new Client(15000, new EventEmitter(), '/unused', logger);
    api.getSensors = () => pending;
    api.getAlarmSystem = () => pending;
    api.subscribeToSensor('fixture', () => {});
    api.subscribeToAlarmSystem('fixture', () => {});
    const polling = Promise.all(ticks.map(tick => tick()));
    api.dispose();
    reject(new Error('fixture cancelled poll'));
    await polling;
    assert.equal(scheduled.mock.callCount(), 0);
});
