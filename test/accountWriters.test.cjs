const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(process.env.SIMPLISAFE_HTTP_TEST_ROOT || path.join(__dirname, '..', 'dist'));

test('two processes serialize token rotation and reload the most recently stored token', { timeout: 10000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-writers-'));
    const file = path.join(directory, 'simplisafe3auth.json');
    fs.writeFileSync(file, JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-initial' }));
    const workers = Array.from({ length: 2 }, () => fork(path.join(__dirname, 'helpers/auth-lock-worker.cjs'), [root, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const exited = workers.map(child => once(child, 'exit'));
    t.after(async () => {
        for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.all(exited);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await Promise.all(workers.map(child => once(child, 'message')));
    const answers = workers.map(child => once(child, 'message'));
    workers.forEach(child => child.send('refresh'));
    const messages = (await Promise.all(answers)).map(([message]) => message);
    assert.ok(messages.every(message => !message.error), JSON.stringify(messages));
    assert.deepEqual(messages.map(message => message.used).sort(), ['fixture-initial', 'fixture-initial-rotated']);
    assert.equal(JSON.parse(fs.readFileSync(file)).refreshToken, 'fixture-initial-rotated-rotated');
    assert.ok((await Promise.all(exited)).every(([code]) => code === 0));
    assert.equal(fs.existsSync(file + '.lock'), false);
});
