const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUpdateFunctions(context) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer-data.js'), 'utf8');
    const exportsSource = '\nglobalThis.__testExports = {'
        + ' renderUpdateIndicator, checkForAppUpdates };';
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename: 'renderer-data.js' });
    return context.__testExports;
}

function createClassList(...initialClasses) {
    const classes = new Set(initialClasses);
    return {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value),
    };
}

function createIndicator() {
    const attributes = new Map();
    return {
        classList: createClassList('hidden'),
        onclick: null,
        title: '',
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
    };
}

async function testAvailableUpdateUsesCompactBrandIndicator() {
    const updateInfo = {
        current_version: '1.6.11',
        latest_version: 'v1.7.0',
        update_available: true,
        release_url: 'https://github.com/yuukidach/wayper/releases/tag/v1.7.0',
    };
    const indicator = createIndicator();
    const opened = [];
    const context = {
        appState: { updateInfo: null },
        els: { updateIndicator: indicator },
        WayperApi: { updateCheck: async force => {
            assert.equal(force, true);
            return updateInfo;
        } },
        window: { open: (...args) => opened.push(args) },
        console,
    };
    const renderer = loadUpdateFunctions(context);

    await renderer.checkForAppUpdates(true);

    assert.equal(context.appState.updateInfo, updateInfo);
    assert.equal(indicator.classList.contains('hidden'), false);
    assert.equal(
        indicator.title,
        'Wayper v1.7.0 is available. Current version: 1.6.11.',
    );
    assert.equal(
        indicator.getAttribute('aria-label'),
        'Wayper v1.7.0 is available. Open the release page.',
    );

    indicator.onclick();
    assert.deepEqual(opened, [[updateInfo.release_url, '_blank']]);
}

function testCurrentVersionKeepsIndicatorHidden() {
    const indicator = createIndicator();
    indicator.classList.remove('hidden');
    indicator.onclick = () => {};
    const context = {
        appState: { updateInfo: null },
        els: { updateIndicator: indicator },
        window: { open: () => {} },
        console,
    };
    const renderer = loadUpdateFunctions(context);

    renderer.renderUpdateIndicator({
        current_version: '1.6.11',
        latest_version: 'v1.6.11',
        update_available: false,
    });

    assert.equal(indicator.classList.contains('hidden'), true);
    assert.equal(indicator.onclick, null);
}

(async () => {
    await testAvailableUpdateUsesCompactBrandIndicator();
    testCurrentVersionKeepsIndicatorHidden();
    console.log('update indicator tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
