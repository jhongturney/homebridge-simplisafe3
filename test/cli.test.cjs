const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bin = path.join(__dirname, '..', 'dist', 'bin', 'run');
const version = require('../dist/package.json').version;

function cli(t, args) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'simplisafe-cli-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
            ...process.env,
            XDG_CACHE_HOME: path.join(temporary, 'cache'),
            XDG_CONFIG_HOME: path.join(temporary, 'config'),
            XDG_DATA_HOME: path.join(temporary, 'data'),
        },
    });
    assert.ifError(result.error);
    return { ...result, output: result.stdout + result.stderr };
}

test('CLI reports the installed fork version', t => {
    const result = cli(t, ['--version']);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(`homebridge-simplisafe3/${version}`));
});

test('CLI discovers the login command and its help plugin', t => {
    const result = cli(t, ['--help']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /login.*Login with SimpliSafe/);
});

test('CLI login help retains the storage directory flag', t => {
    const result = cli(t, ['login', '--help']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /-d, --homebridgeDir/);
});

test('CLI rejects unknown login flags before attempting authentication', t => {
    const result = cli(t, ['login', '--not-a-real-flag']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /not-a-real-flag/);
    assert.doesNotMatch(result.output, /Redirect URL:/);
});

test('CLI parses a custom storage directory without touching real credentials', t => {
    const missing = path.join(os.tmpdir(), 'simplisafe-missing-storage', 'no-such-directory');
    const result = cli(t, ['login', '-d', missing]);
    assert.notEqual(result.status, 0);
    assert.ok(result.output.includes(`Supplied path ${missing} does not exist`));
    assert.doesNotMatch(result.output, /Redirect URL:/);
});
