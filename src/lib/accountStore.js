import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'timers/promises';

export function readAccount(filename) {
    let account;
    try { account = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new Error(`Cannot read credentials in ${filename}; restore a valid file or sign in again. The file was preserved.`);
    }
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
        !['accessToken', 'refreshToken', 'codeVerifier'].every(key => account[key] === undefined || account[key] === null || typeof account[key] === 'string')) {
        throw new Error(`Invalid credentials in ${filename}; sign in again. The file was preserved.`);
    }
    return account;
}

export function writeAccount(filename, account) {
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(account));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (err) { /* Preserve the original write error; temporary files are private. */ }
    }
}

// Hold the lock across read -> OAuth rotation -> atomic replacement, not just
// the final write. All updated plugin/UI/CLI writers use identical lock options.
export async function withAccountLock(filename, parentSignal, operation) {
    filename = path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', cancel, { once: true });
    if (parentSignal.aborted) cancel();
    let release;
    const deadline = performance.now() + 15000;
    try {
        for (;;) {
            controller.signal.throwIfAborted();
            try {
                release = await lockfile.lock(filename, {
                    realpath: false, stale: 10000, update: 3000,
                    onCompromised: err => controller.abort(err)
                });
                break;
            } catch (err) {
                if (err.code !== 'ELOCKED' || performance.now() >= deadline) throw err;
                await delay(100, undefined, { signal: controller.signal });
            }
        }
        controller.signal.throwIfAborted();
        return await operation(controller.signal);
    } finally {
        parentSignal.removeEventListener('abort', cancel);
        if (release) await release();
    }
}
