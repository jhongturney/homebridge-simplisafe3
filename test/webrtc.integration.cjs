const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const dgram = require('node:dgram');

const root = path.resolve(process.env.SIMPLISAFE_WEBRTC_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const requireFromPlugin = createRequire(path.join(root, 'package.json'));
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket } = requireFromPlugin('werift');
const LiveKitSource = require(path.join(root, 'lib', 'liveKitSource')).default;

const loopback = {
    iceServers: [], iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: '127.0.0.1' },
};

function connected(peer) {
    if (peer.connectionState === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
        const done = error => {
            clearTimeout(timer);
            subscription.unSubscribe();
            if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => done(new Error(`Local WebRTC connection timed out: ${peer.connectionState}`)), 8000);
        const subscription = peer.connectionStateChange.subscribe(state => {
            if (state === 'connected') done();
            else if (state === 'failed' || state === 'closed') done(new Error(`Local WebRTC connection ${state}`));
        });
    });
}

test('LiveKit adapter receives H264 and Opus over a real loopback WebRTC connection', { timeout: 15000 }, async t => {
    // Empty ICE server lists fall back to the library's public STUN server.
    // Supply an actual local STUN responder to keep every packet on loopback.
    const stun = dgram.createSocket('udp4');
    let bindings = 0;
    stun.on('message', (request, remote) => {
        if (request.length < 20 || request.readUInt16BE(0) !== 1 || request.readUInt32BE(4) !== 0x2112a442) return;
        assert.equal(remote.address, '127.0.0.1');
        bindings++;
        const response = Buffer.alloc(32);
        response.writeUInt16BE(0x0101, 0);
        response.writeUInt16BE(12, 2);
        request.copy(response, 4, 4, 20);
        response.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
        response.writeUInt16BE(8, 22);
        response[25] = 1;
        response.writeUInt16BE(remote.port ^ 0x2112, 26);
        response.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 28);
        stun.send(response, remote.port, remote.address);
    });
    await new Promise((resolve, reject) => {
        stun.once('error', reject);
        stun.bind(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => stun.close(resolve)));
    const localIce = { ...loopback, iceServers: [{ urls: `stun:127.0.0.1:${stun.address().port}` }] };
    const source = new LiveKitSource({ simplisafe: {}, log: () => {}, debug: false, name: 'Loopback camera' });
    const signals = [];
    source._handleJoin({ room: { name: 'local-fixture' }, iceServers: localIce.iceServers }, message => signals.push(message));
    const subscriber = source.pc;
    subscriber.setConfiguration(localIce);
    const publisher = new RTCPeerConnection({ ...localIce, codecs: subscriber.getConfiguration().codecs });
    t.after(async () => {
        await Promise.all([subscriber.close(), publisher.close()]);
        source.close();
    });

    let firstVideo = 0;
    source._onFirstVideo = () => { firstVideo++; };
    const expectedVideo = Buffer.from([0x65, 0x88, 0x84, 0x00]);
    const expectedAudio = Buffer.from([0xf8, 0xff, 0xfe]);
    const received = new Map();
    source.onVideoRtp = packet => received.set('video', packet);
    source.onAudioRtp = packet => received.set('audio', packet);
    const video = new MediaStreamTrack({ kind: 'video' });
    const audio = new MediaStreamTrack({ kind: 'audio' });
    publisher.addTrack(video);
    publisher.addTrack(audio);

    await publisher.setLocalDescription(await publisher.createOffer());
    assert.match(publisher.localDescription.sdp, /127\.0\.0\.1/);
    await subscriber.setRemoteDescription(publisher.localDescription);
    await subscriber.setLocalDescription(await subscriber.createAnswer());
    await publisher.setRemoteDescription(subscriber.localDescription);
    await Promise.all([connected(subscriber), connected(publisher)]);
    for (const description of [subscriber.localDescription, publisher.localDescription]) {
        const candidates = description.sdp.match(/^a=candidate:.+$/gm) || [];
        assert.ok(candidates.length > 0);
        assert.ok(candidates.every(line => line.split(' ')[4] === '127.0.0.1'));
    }

    assert.match(subscriber.localDescription.sdp, /H264\/90000/i);
    assert.match(subscriber.localDescription.sdp, /opus\/48000/i);
    assert.ok(signals.some(signal => signal.message.case === 'trickle'));
    assert.ok(bindings >= 2);
    let sequence = 1;
    const send = () => {
        video.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: sequence, timestamp: sequence * 3000, ssrc: 1001, marker: true }), expectedVideo));
        audio.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: sequence, timestamp: sequence * 960, ssrc: 1002 }), expectedAudio));
        sequence++;
    };
    const interval = setInterval(send, 20);
    t.after(() => clearInterval(interval));
    send();
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { clearInterval(check); reject(new Error('Loopback media did not arrive')); }, 4000);
            const check = setInterval(() => {
                if (received.size === 2) { clearInterval(check); clearTimeout(timeout); resolve(); }
            }, 10);
        });
    } finally {
        clearInterval(interval);
    }
    assert.deepEqual(received.get('video').payload, expectedVideo);
    assert.deepEqual(received.get('audio').payload, expectedAudio);
    assert.equal(source.streaming, true);
    assert.equal(firstVideo, 1);
});
