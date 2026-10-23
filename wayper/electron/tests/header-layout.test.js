const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('header actions stay right-aligned after leaving model review', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-header-layout-'));
    try {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const args = [path.join(__dirname, 'fixtures', 'header-layout.cjs'), directory];
        if (process.platform === 'linux') args.unshift('--ozone-platform=headless');
        const result = spawnSync(require('electron'), args, {
            env,
            encoding: 'utf8',
            timeout: 20000,
            killSignal: 'SIGKILL',
        });
        assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
