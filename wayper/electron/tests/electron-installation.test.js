// A successful npm ci does not guarantee postinstall ran or finished extracting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageDir = path.dirname(require.resolve('electron/package.json'));
const binary = require('electron');
assert.ok(fs.statSync(binary).isFile(), 'Electron must include its native runtime');
assert.ok(fs.statSync(binary).size > 0, 'Electron runtime must not be empty');
assert.equal(
    fs.readFileSync(path.join(packageDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, ''),
    require('electron/package.json').version,
    'the extracted Electron runtime must match the installed package',
);
console.log('Electron installation smoke test passed');
