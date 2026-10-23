const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const directory = process.argv.at(-1);
const root = path.resolve(__dirname, '..', '..');
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();

function inspectHeader({ mode, view, hidden, language }) {
    document.documentElement.lang = language;
    document.body.dataset.mode = mode;
    document.body.dataset.view = view;
    const clearButton = document.getElementById('model-review-clear-all');
    clearButton.hidden = hidden;
    const controls = document.querySelector('.controls');
    const search = document.querySelector('.search-wrapper');
    const header = document.querySelector('.header-content');
    const headerRect = header.getBoundingClientRect();
    return {
        controlsVisible: getComputedStyle(controls).display !== 'none',
        clearVisible: getComputedStyle(clearButton).display !== 'none',
        controlsRight: controls.getBoundingClientRect().right,
        clearRight: clearButton.getBoundingClientRect().right,
        rightEdge: headerRect.right - parseFloat(getComputedStyle(header).paddingRight),
        searchGap: controls.getBoundingClientRect().left - search.getBoundingClientRect().right,
        minGap: parseFloat(getComputedStyle(header).gap),
        viewport: innerWidth,
    };
}

app.whenReady().then(async () => {
    // Render the real markup and styles without loading the backend or user state.
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace('<head>', `<head><base href="${pathToFileURL(root + path.sep).href}">`);
    const fixture = path.join(directory, 'index.html');
    fs.writeFileSync(fixture, html);
    const window = new BrowserWindow({
        width: 1200,
        height: 720,
        show: false,
        webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await window.loadFile(fixture);
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

    const states = [
        { mode: 'pool', view: 'grid', hidden: true },
        { mode: 'model-review', view: 'grid', hidden: false },
        // Leaving the held queue can leave the button's hidden property unset.
        { mode: 'pool', view: 'grid', hidden: false },
        { mode: 'favorites', view: 'grid', hidden: false },
        { mode: 'trash', view: 'grid', hidden: false },
        { mode: 'pool', view: 'settings', hidden: false },
        { mode: 'model-review', view: 'settings', hidden: false },
        { mode: 'model-review', view: 'grid', hidden: true },
    ];
    for (const width of [600, 720, 900, 1200, 1600]) {
        window.setContentSize(width, 720);
        await window.webContents.executeJavaScript(`
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        `);
        for (const language of ['en', 'zh']) {
            for (const state of states) {
                const options = { ...state, language };
                const label = `${width}px ${JSON.stringify(options)}`;
                const layout = await window.webContents.executeJavaScript(
                    `(${inspectHeader.toString()})(${JSON.stringify(options)})`,
                );
                const controlsVisible = state.view === 'grid' && state.mode !== 'model-review';
                const clearVisible = state.view === 'grid'
                    && state.mode === 'model-review' && !state.hidden;
                assert.equal(layout.viewport, width, label);
                assert.equal(layout.controlsVisible, controlsVisible, label);
                assert.equal(layout.clearVisible, clearVisible, label);
                if (controlsVisible) {
                    assert.ok(Math.abs(layout.controlsRight - layout.rightEdge) < 1, label);
                    assert.ok(layout.searchGap >= layout.minGap - 1, label);
                }
                if (clearVisible) {
                    assert.ok(Math.abs(layout.clearRight - layout.rightEdge) < 1, label);
                }
            }
        }
    }
    app.exit(0);
}).catch(error => {
    console.error(error);
    app.exit(1);
});
