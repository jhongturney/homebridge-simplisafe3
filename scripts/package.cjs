const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(root, 'dist', 'npm-shrinkwrap.json'));
execFileSync('npm', ['pack', './dist', '--pack-destination', output], { cwd: root, stdio: 'inherit' });
