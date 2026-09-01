const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const electronDir = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(electronDir, 'renderer-views.js'), 'utf8');
let reducedMotion = true;
const context = { console, matchMedia: () => ({ matches: reducedMotion }) };
context.window = context;
vm.createContext(context);
vm.runInContext(
    `${source}\nglobalThis.__test = { trashPermissionPresentation, rendererScrollBehavior, prepareWallpaperCardImage };`,
    context,
    { filename: 'renderer-views.js' },
);

const mac = context.__test.trashPermissionPresentation('darwin');
assert.match(mac.message, /Full Disk Access/);
assert.match(mac.settingsUrl, /^x-apple\.systempreferences:/);

const windows = context.__test.trashPermissionPresentation('win32');
assert.match(windows.message, /Recycle Bin/);
assert.equal(windows.settingsUrl, undefined);

const linux = context.__test.trashPermissionPresentation('linux');
assert.match(linux.message, /file permissions/);
assert.equal(linux.settingsUrl, undefined);

assert.equal(context.__test.rendererScrollBehavior('smooth'), 'auto');
reducedMotion = false;
assert.equal(context.__test.rendererScrollBehavior('smooth'), 'smooth');

const html = fs.readFileSync(path.join(electronDir, 'index.html'), 'utf8');
assert.match(html, /@fontsource-variable\/outfit\/index\.css/);
assert(!html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'),
    'desktop typography should not wait on an external web font');

const preload = fs.readFileSync(path.join(electronDir, 'preload.js'), 'utf8');
assert.match(preload, /platform:\s*process\.platform/,
    'renderer platform messaging should follow the actual Electron host');

async function testImageReveal() {
    const classes = new Set(['loading']);
    let finishDecode;
    const image = {
        classList: { remove: value => classes.delete(value) },
        complete: false,
        decode: () => new Promise(resolve => { finishDecode = resolve; }),
    };
    context.__test.prepareWallpaperCardImage(image);
    const loading = image.onload();
    await Promise.resolve();
    assert(classes.has('loading'), 'skeleton should remain until decoding completes');
    finishDecode();
    await loading;
    assert(!classes.has('loading'));

    let errors = 0;
    context.__test.prepareWallpaperCardImage(image, () => { errors += 1; });
    image.onerror();
    assert.equal(errors, 1);
}

testImageReveal()
    .then(() => console.log('platform UI tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
