const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(process.env.SIMPLISAFE_WEBRTC_TEST_ROOT || path.join(__dirname, '..', 'dist'));
const requireFromPlugin = createRequire(path.join(root, 'package.json'));
const { RtpHeader, RtpPacket } = requireFromPlugin('werift');
const StreamingDelegate = require(path.join(root, 'lib', 'streamingDelegate')).default;
const { OpusRepacketizer } = require(path.join(root, 'lib', 'opus'));
const keyAndSalt = Buffer.from(Array.from({ length: 30 }, (_, index) => index));

function channel() {
    const create = () => StreamingDelegate.prototype.createSrtpSession.call({}, keyAndSalt);
    const sender = create();
    const receiver = create();
    const packets = [];
    const destination = { port: 5010, address: '127.0.0.1' };
    const socket = {
        send: (encrypted, port, address) => {
            assert.equal(port, destination.port);
            assert.equal(address, destination.address);
            packets.push({ encrypted, decoded: RtpPacket.deSerialize(receiver.decrypt(encrypted)) });
        },
    };
    return {
        packets,
        forward: (packet, type = 99) => StreamingDelegate.prototype.forwardRtp.call(
            { ss3Camera: { debug: false } }, packet, sender, socket, type, 0x12345678, destination.port, destination.address
        ),
    };
}

test('video RTP is re-stamped, encrypted and decrypts with the HomeKit keys', () => {
    const media = channel();
    const payload = Buffer.from([0x65, 0x88, 0x84, 0x00]);
    const packet = new RtpPacket(new RtpHeader({
        payloadType: 96, ssrc: 123, sequenceNumber: 400, timestamp: 90000, marker: true,
        extension: true, extensions: [{ id: 1, payload: Buffer.from('extension') }],
    }), payload);
    media.forward(packet);
    const { encrypted, decoded } = media.packets[0];
    assert.deepEqual(decoded.payload, payload);
    assert.equal(decoded.header.payloadType, 99);
    assert.equal(decoded.header.ssrc, 0x12345678);
    assert.equal(decoded.header.sequenceNumber, 400);
    assert.equal(decoded.header.timestamp, 90000);
    assert.equal(decoded.header.marker, true);
    assert.equal(decoded.header.extension, false);
    assert.deepEqual(decoded.header.extensions, []);
    assert.notDeepEqual(encrypted, packet.serialize());
});

test('multi-frame Opus becomes decryptable single-frame HomeKit packets', () => {
    const media = channel();
    const packet = new RtpPacket(new RtpHeader({ sequenceNumber: 500, timestamp: 4294966336, padding: true }),
        Buffer.from([0x4b, 0x83, 1, 1, 0xa1, 0xb1, 0xc1]));
    for (const frame of new OpusRepacketizer().split(packet)) media.forward(frame, 110);
    assert.deepEqual(media.packets.map(({ decoded }) => ({
        sequence: decoded.header.sequenceNumber, timestamp: decoded.header.timestamp,
        payloadType: decoded.header.payloadType, padding: decoded.header.padding, payload: decoded.payload,
    })), [
        { sequence: 0, timestamp: 4294966336, payloadType: 110, padding: false, payload: Buffer.from([0x48, 0xa1]) },
        { sequence: 1, timestamp: 0, payloadType: 110, padding: false, payload: Buffer.from([0x48, 0xb1]) },
        { sequence: 2, timestamp: 960, payloadType: 110, padding: false, payload: Buffer.from([0x48, 0xc1]) },
    ]);
});

test('encrypted RTP remains decryptable across the sequence-number rollover', () => {
    const media = channel();
    for (const sequenceNumber of [65534, 65535, 0, 1]) {
        media.forward(new RtpPacket(new RtpHeader({ sequenceNumber, timestamp: 90000 }), Buffer.from([0x65, sequenceNumber & 0xff])));
    }
    assert.deepEqual(media.packets.map(({ decoded }) => decoded.header.sequenceNumber), [65534, 65535, 0, 1]);
    assert.deepEqual(media.packets.map(({ decoded }) => [...decoded.payload]), [[0x65, 254], [0x65, 255], [0x65, 0], [0x65, 1]]);
});
