import { get } from 'https';

const jpegStart = Buffer.from([0xff, 0xd8]);
const jpegEnd = Buffer.from([0xff, 0xd9]);

// Read one JPEG from a JPEG or MJPEG response, then close the stream immediately.
// Keep chunks separately so a large frame does not get copied on every packet.
export default function jpegSnapshot(url, { headers, timeoutMs = 7000, maxBytes = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let request;
        let response;
        let settled = false;
        let timer;
        let started = false;
        let previousByte;
        let received = 0;
        const chunks = [];

        const finish = (error, jpeg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (response) response.destroy();
            if (request) request.destroy();
            if (error) reject(error); else resolve(jpeg);
        };

        // This is a wall-clock deadline, including DNS, TLS and the response body.
        timer = setTimeout(() => finish(new Error('Camera snapshot timed out')), timeoutMs);
        request = get(url, { headers }, res => {
            response = res;
            res.on('error', error => finish(error));
            if (settled) {
                res.destroy();
                return;
            }
            if (res.statusCode !== 200) {
                // Do not follow redirects with the camera's authorization header.
                const error = new Error(`Camera snapshot returned HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.statusMessage = res.statusMessage;
                finish(error);
                return;
            }

            res.on('data', data => {
                if (settled || !data.length) return;
                received += data.length;
                if (received > maxBytes) {
                    finish(new Error('Camera snapshot exceeded the size limit'));
                    return;
                }

                let chunk = data;
                if (!started) {
                    if (previousByte === 0xff && chunk[0] === 0xd8) {
                        chunks.push(jpegStart.subarray(0, 1));
                    } else {
                        const start = chunk.indexOf(jpegStart);
                        if (start === -1) {
                            previousByte = chunk[chunk.length - 1];
                            return;
                        }
                        chunk = chunk.subarray(start);
                    }
                    started = true;
                    previousByte = undefined;
                }

                // Both JPEG markers can be split across incoming network chunks.
                if (previousByte === 0xff && chunk[0] === 0xd9) {
                    chunks.push(chunk.subarray(0, 1));
                    finish(null, Buffer.concat(chunks));
                    return;
                }
                const end = chunk.indexOf(jpegEnd);
                if (end !== -1) {
                    chunks.push(chunk.subarray(0, end + 2));
                    finish(null, Buffer.concat(chunks));
                    return;
                }
                chunks.push(chunk);
                previousByte = chunk[chunk.length - 1];
            });
            res.on('end', () => finish(new Error('Camera response ended before a complete JPEG arrived')));
            res.on('close', () => finish(new Error('Camera snapshot connection closed before a complete JPEG arrived')));
        });
        request.on('error', error => finish(error));
    });
}
