const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('wallpaper display settings save, reload, translate and respect platform support', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-wallpaper-resize-'));
    try {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const args = [path.join(__dirname, 'fixtures', 'wallpaper-resize.cjs'), directory];
        if (process.platform === 'linux') args.unshift('--ozone-platform=headless');
        const result = spawnSync(require('electron'), args, {
            env,
            encoding: 'utf8',
            timeout: 20000,
            killSignal: 'SIGKILL',
            windowsHide: true,
        });
        assert.equal(result.status, 0, [result.error, result.stdout, result.stderr].join('\n'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
