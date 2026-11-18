const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const metadata = require('../package.json');
const archive = path.join(root, 'artifacts', `${metadata.name}-${metadata.version}.tgz`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'simplisafe-package-'));
try {
    execFileSync('npm', ['install', '--prefix', temporary, '--omit=dev', '--save-exact', archive],
        { cwd: root, stdio: 'inherit', timeout: 180000 });
    const installed = path.join(temporary, 'node_modules', metadata.name);
    assert.equal(require(path.join(installed, 'package.json')).version, metadata.version);
    assert.ok(fs.existsSync(path.join(installed, 'npm-shrinkwrap.json')));
    assert.ok(fs.existsSync(path.join(installed, 'config.schema.json')));
    let registrations = 0;
    require(installed).default({
        hap: { uuid: {} },
        registerPlatform: () => { registrations++; },
    });
    assert.equal(registrations, 1);
    const cli = execFileSync(process.execPath, [path.join(installed, 'bin', 'run'), '--version'],
        { encoding: 'utf8', timeout: 15000 });
    assert.ok(cli.includes(metadata.version));
    execFileSync(process.execPath, ['--test', '--test-timeout=15000',
        'test/requestPerformance.test.cjs', 'test/httpRetry.test.cjs', 'test/uiServer.test.cjs'],
    {
        cwd: root,
        env: { ...process.env, SIMPLISAFE_HTTP_TEST_ROOT: installed, SIMPLISAFE_UI_TEST_ROOT: installed },
        stdio: 'inherit',
        timeout: 60000,
    });
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
