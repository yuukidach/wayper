const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const directory = process.argv.at(-1);
const root = path.resolve(__dirname, '..', '..');
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();

function prepareSettings() {
    window.fixtureConfig = {
        language: 'en', interval_min: 5, quota_mb: 4000, download_dir: '/test/wallpapers',
        autostart: false, mode: ['sfw'],
        transition: { resize: 'fit', resize_available: true },
        wallhaven: {
            categories: '111', top_range: '1M', sorting: 'toplist', ai_art_filter: 0,
            filter_strategy: 'rules', batch_size: 5,
        },
    };
    window.appState = { config: structuredClone(fixtureConfig) };
    window.els = Object.fromEntries(Object.entries({
        btnSaveSettings: 'btn-save-settings',
        btnSettings: 'btn-settings',
        wallpaperGrid: 'wallpaper-grid',
        settingsView: 'settings-view',
        btnPuritySketchy: 'btn-purity-sketchy',
        btnPurityNsfw: 'btn-purity-nsfw',
    }).map(([name, id]) => [name, document.getElementById(id)]));
    window.savedUpdates = [];
    window.alerts = [];
    window.alert = message => alerts.push(message);
    window.WayperApi = {
        config: async () => structuredClone(fixtureConfig),
        patchConfig: async updates => {
            if (window.fixtureSaveError) throw new Error('Unable to save');
            savedUpdates.push(structuredClone(updates));
            const transition = updates.transition
                ? { ...fixtureConfig.transition, ...updates.transition }
                : fixtureConfig.transition;
            fixtureConfig = { ...fixtureConfig, ...updates, transition };
        },
    };
    // Keep real settings, API mapping and translation logic; isolate other views and I/O.
    syncAISuggestionAppliedState = () => {};
    invalidateBlocklistSuggestions = () => {};
    window.updateUI = () => {};
    fetchStatus = fetchDiskUsage = refreshImages = async () => {};
    WayperI18n.setPreference('en');
    switchView('settings');
}

function inspectSettings() {
    const input = document.getElementById('input-wallpaper-resize');
    const rect = input.getBoundingClientRect();
    return {
        selected: input.value,
        disabled: input.disabled,
        options: [...input.options].map(option => [option.value, option.text]),
        label: document.querySelector('label[for="input-wallpaper-resize"]').textContent,
        description: document.getElementById('wallpaper-resize-description').textContent,
        noteHidden: document.getElementById('wallpaper-resize-apply-note').hidden,
        view: appState.view,
        left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
    };
}

app.whenReady().then(async () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace('<head>', '<head><base href="' + pathToFileURL(root + path.sep).href + '">');
    const fixture = path.join(directory, 'index.html');
    fs.writeFileSync(fixture, html);
    const window = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await window.loadFile(fixture);
    const run = code => window.webContents.executeJavaScript(code);
    const inspect = () => run('(' + inspectSettings.toString() + ')()');
    for (const file of ['i18n.js', 'renderer-data.js']) {
        await run(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    await run('(' + prepareSettings.toString() + ')()');
    const labels = {
        en: ['Crop to fill', 'Fit entire image', 'Stretch to fill', 'Original size'],
        zh: ['裁剪铺满', '完整显示', '拉伸铺满', '原始尺寸'],
    };
    const modes = ['crop', 'fit', 'stretch', 'no'];
    assert.equal((await inspect()).selected, 'fit');
    await run("document.getElementById('input-wallpaper-resize').value = 'stretch'; switchView('grid'); switchView('settings')");
    assert.equal((await inspect()).selected, 'fit', 'cancel discards the unsaved choice');

    for (const mode of modes) {
        await run("document.getElementById('input-wallpaper-resize').value = " + JSON.stringify(mode)
            + "; document.getElementById('input-wallpaper-resize').dispatchEvent(new Event('change'));");
        assert.equal((await inspect()).noteHidden, false);
        await run('saveSettings()');
        assert.deepEqual(await run('savedUpdates.at(-1).transition'), { resize: mode });
        assert.equal((await inspect()).view, 'grid');
        await run("switchView('settings')");
        assert.equal((await inspect()).selected, mode, 'saved choice survives reopening settings');
    }
    await run("fixtureSaveError = true; document.getElementById('input-wallpaper-resize').value = 'fit'; saveSettings()");
    assert.equal((await inspect()).view, 'settings', 'failed saves keep settings open');
    assert.equal(await run('fixtureConfig.transition.resize'), 'no');
    assert.match(await run('alerts.at(-1)'), /Unable to save/);
    await run('fixtureSaveError = false; fixtureConfig.transition.resize_available = false; fetchConfig()');
    await run("switchView('settings')");
    let state = await inspect();
    assert.equal(state.disabled, true);
    assert.equal(state.noteHidden, true);
    assert.equal(state.description, 'Available on Linux only');
    await run("document.getElementById('input-wallpaper-resize').value = 'fit'; saveSettings()");
    assert.equal(await run("Object.hasOwn(savedUpdates.at(-1), 'transition')"), false);
    assert.equal(await run('fixtureConfig.transition.resize'), 'no');
    await run('delete fixtureConfig.transition; fetchConfig()');
    await run("switchView('settings')");
    assert.equal((await inspect()).selected, 'crop');
    assert.equal((await inspect()).disabled, true, 'older backends cannot silently accept unsupported settings');

    await run("fixtureConfig.transition = { resize: 'fit', resize_available: true }; fetchConfig()");
    await run("switchView('settings')");
    for (const language of ['zh', 'en']) {
        await run('WayperI18n.setPreference(' + JSON.stringify(language) + '); '
            + "document.getElementById('input-language').value = " + JSON.stringify(language));
        state = await inspect();
        assert.deepEqual(state.options, modes.map((mode, index) => [mode, labels[language][index]]));
        assert.equal(state.label, language === 'zh' ? '壁纸显示方式' : 'Wallpaper Display Mode');
        assert.equal(state.description, language === 'zh'
            ? '保持比例完整显示图片，屏幕边缘可能留白。'
            : 'Show the whole image while keeping proportions; borders may appear.');
        for (const width of [600, 900, 1200]) {
            window.setContentSize(width, 800);
            await run('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
            state = await inspect();
            assert.ok(state.width > 200 && state.left >= 0 && state.right <= state.viewport,
                'display mode control fits the viewport: ' + JSON.stringify(state));
            if (process.argv.includes('--capture')) {
                const screenshot = await window.webContents.capturePage();
                fs.writeFileSync(path.join(directory, 'settings-' + language + '-' + width + '.png'),
                    screenshot.toPNG());
            }
        }
    }
    app.exit(0);
}).catch(error => {
    console.error(error);
    app.exit(1);
});
