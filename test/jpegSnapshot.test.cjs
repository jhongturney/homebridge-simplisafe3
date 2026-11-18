const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const jpegSnapshot = require('../dist/lib/jpegSnapshot').default;

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const url = 'https://media.simplisafe.com/v1/camera/mjpg?x=1280&fr=1';

function transport(t, { statusCode = 200, chunks = [], end = true, error } = {}) {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    const response = new PassThrough();
    response.statusCode = statusCode;
    response.statusMessage = 'test response';
    let calledOptions;
    const mock = t.mock.method(https, 'get', (target, options, callback) => {
        assert.equal(target, url);
        calledOptions = options;
        process.nextTick(() => {
            if (error) {
                request.emit('error', error);
                return;
            }
            callback(response);
            for (const chunk of chunks) {
                if (!response.destroyed) response.write(chunk);
            }
            if (end && !response.destroyed) response.end();
        });
        return request;
    });
    return { request, response, mock, options: () => calledOptions };
}

test('returns only the first JPEG from a multipart stream and closes the connection', async t => {
    const http = transport(t, { chunks: [Buffer.concat([
        Buffer.from('--boundary\r\nContent-Type: image/jpeg\r\n\r\n'),
        jpeg, Buffer.from('\r\n--boundary\r\n'), jpeg,
    ])], end: false });
    const result = await jpegSnapshot(url, { headers: { Authorization: 'Bearer test-token' } });
    assert.deepEqual(result, jpeg);
    assert.equal(http.request.destroyed, true);
    assert.equal(http.response.destroyed, true);
    assert.equal(http.options().headers.Authorization, 'Bearer test-token');
    assert.equal(http.options().rejectUnauthorized, undefined, 'use normal certificate verification');
});

test('handles JPEG markers split at every possible network chunk boundary', async t => {
    for (let split = 1; split < jpeg.length; split++) {
        const http = transport(t, { chunks: [jpeg.subarray(0, split), jpeg.subarray(split)] });
        assert.deepEqual(await jpegSnapshot(url), jpeg);
        http.mock.mock.restore();
    }
});

test('handles one-byte chunks including a multipart preamble', async t => {
    const body = Buffer.concat([Buffer.from('headers\r\n\r\n'), jpeg]);
    transport(t, { chunks: [...body].map(byte => Buffer.from([byte])) });
    assert.deepEqual(await jpegSnapshot(url), jpeg);
});

test('rejects unauthorized responses and redirects without making another request', async t => {
    for (const statusCode of [401, 403, 302, 500]) {
        const http = transport(t, { statusCode });
        await assert.rejects(jpegSnapshot(url), { statusCode });
        assert.equal(http.mock.mock.callCount(), 1);
        assert.equal(http.request.destroyed, true);
        assert.equal(http.response.destroyed, true);
        http.mock.mock.restore();
    }
});

test('rejects incomplete and empty responses', async t => {
    for (const chunks of [[], [jpeg.subarray(0, -1)], [Buffer.from('not an image')]]) {
        const http = transport(t, { chunks });
        await assert.rejects(jpegSnapshot(url), /before a complete JPEG/);
        assert.equal(http.request.destroyed, true);
        http.mock.mock.restore();
    }
});

test('bounds memory even if the response never sends an image', async t => {
    const http = transport(t, { chunks: [Buffer.alloc(5), Buffer.alloc(5)], end: false });
    await assert.rejects(jpegSnapshot(url, { maxBytes: 8 }), /size limit/);
    assert.equal(http.request.destroyed, true);
    assert.equal(http.response.destroyed, true);
});

test('times out and cancels a stalled response body', async t => {
    const http = transport(t, { chunks: [jpeg.subarray(0, 3)], end: false });
    await assert.rejects(jpegSnapshot(url, { timeoutMs: 20 }), /timed out/);
    assert.equal(http.request.destroyed, true);
    assert.equal(http.response.destroyed, true);
});

test('times out before headers arrive and rejects DNS or TLS errors', async t => {
    const request = new EventEmitter();
    request.destroy = () => { request.destroyed = true; };
    const get = t.mock.method(https, 'get', () => request);
    await assert.rejects(jpegSnapshot(url, { timeoutMs: 20 }), /timed out/);
    assert.equal(request.destroyed, true);
    get.mock.restore();

    transport(t, { error: new Error('certificate verification failed') });
    await assert.rejects(jpegSnapshot(url), /certificate verification failed/);
});

test('rejects an interrupted response and releases the request', async t => {
    const http = transport(t, { end: false });
    const pending = jpegSnapshot(url);
    process.nextTick(() => http.response.destroy(new Error('connection reset')));
    await assert.rejects(pending, /connection reset/);
    assert.equal(http.request.destroyed, true);
});

test('caller cancellation closes a stalled snapshot request and response', async t => {
    const http = transport(t, { end: false });
    const controller = new AbortController();
    const failed = assert.rejects(jpegSnapshot(url, { signal: controller.signal }), /fixture stopped/);
    await new Promise(setImmediate);
    controller.abort(new Error('fixture stopped'));
    await failed;
    assert.equal(http.request.destroyed, true);
    assert.equal(http.response.destroyed, true);
});

test('an already cancelled snapshot never opens a connection', async t => {
    const http = transport(t);
    const controller = new AbortController();
    controller.abort(new Error('fixture stopped'));
    await assert.rejects(jpegSnapshot(url, { signal: controller.signal }), /fixture stopped/);
    assert.equal(http.mock.mock.callCount(), 0);
});
