const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Instantiate the host's API in the test harness without starting a bridge.
// The matrix installs Homebridge 1 and 2, so these checks use each host's real HAP.
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const initialize = require('../dist').default;
const StreamingDelegate = require('../dist/lib/streamingDelegate').default;

test('plugin registers against the real Homebridge API', () => {
    const api = new HomebridgeAPI();
    const registrations = [];
    api.on('registerPlatform', (...args) => registrations.push(args));
    initialize(api);
    assert.equal(registrations.length, 1);
    const [name, constructor, plugin] = registrations[0];
    assert.equal(name, 'SimpliSafe 3');
    assert.equal(typeof constructor, 'function');
    assert.equal(plugin, 'homebridge-simplisafe3');
});

for (const provider of ['legacy', 'livekit']) {
    test(`${provider} camera configures with the real Homebridge camera controller`, () => {
        const api = new HomebridgeAPI();
        const delegate = new StreamingDelegate({
            api,
            simplisafe: { isBlocked: false },
            log: Object.assign(() => {}, { error: () => {} }),
            cameraOptions: null,
            cameraDetails: {
                uuid: 'test-camera',
                cameraSettings: {
                    admin: { fps: 20, bitRate: 300 },
                    pictureQuality: '720p',
                    cameraName: 'Test camera',
                },
            },
            getStreamProvider: () => provider,
        });
        const accessory = new api.platformAccessory('Test camera', api.hap.uuid.generate(`ss3-test-${provider}`));
        accessory.configureController(delegate.controller);
        assert.equal(accessory.services.filter(service => service.UUID === api.hap.Service.CameraRTPStreamManagement.UUID).length, 2);
        accessory.removeController(delegate.controller);
    });
}
