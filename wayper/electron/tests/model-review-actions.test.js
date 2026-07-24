const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRendererScript(filename, context, exportedNames) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const exportsSource = `\nglobalThis.__testExports = { ${exportedNames.join(', ')} };`;
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename });
    return context.__testExports;
}

async function flushPromises() {
    await new Promise(resolve => setImmediate(resolve));
}

async function testSuggestionRefreshStaysInPlace() {
    let suggestionRenders = 0;
    let resolveSuggestions;
    let postedBody = null;
    const context = {
        API_URL: 'http://127.0.0.1:8080',
        URLSearchParams,
        appState: {
            mode: 'trash',
            purity: ['sfw'],
            config: {
                wallhaven: {
                    exclude_tags: [],
                    exclude_combos: [],
                },
            },
            tagSuggestions: [{ tag: 'old' }],
            comboSuggestions: [],
            tagSuggestionsKey: null,
            tagSuggestionsGeneration: 0,
            allImages: [],
            images: [],
            currentBatchIndex: 0,
            status: {
                pool_count: 10,
                favorites_count: 2,
                blocklist_count: 4,
            },
        },
        document: {
            querySelectorAll: () => [],
        },
        console,
        renderBlocklistSuggestionsBar: () => { suggestionRenders++; },
        updateStatusUI: () => {},
        applyMonitorCurrentImages: () => {},
        refreshImages: () => {},
        WayperApi: {
            tagSuggestions: () => new Promise(resolve => { resolveSuggestions = resolve; }),
        },
        fetch: async (_url, options) => {
            postedBody = JSON.parse(options.body);
            return {
                ok: true,
                json: async () => ({ replacement_images: {} }),
            };
        },
    };
    context.window = context;

    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['banImage', 'blocklistSuggestionsKey', 'invalidateBlocklistSuggestions'],
    );
    const suggestionKey = renderer.blocklistSuggestionsKey();
    context.appState.tagSuggestionsKey = suggestionKey;

    const banned = await renderer.banImage('sfw/wallhaven-test.jpg', {
        preserveView: true,
        preferenceContext: 'model_review',
        refreshSuggestionsInPlace: true,
    });

    assert.equal(banned, true);
    assert.equal(suggestionRenders, 0, 'the existing suggestion bar should remain mounted');
    assert.equal(context.appState.tagSuggestionsKey, suggestionKey);
    assert.equal(postedBody.preference_context, 'model_review');
    assert.equal(typeof resolveSuggestions, 'function');

    resolveSuggestions({
        suggestions: [{ tag: 'fresh' }],
        combo_suggestions: [{ tags: ['fresh', 'combo'] }],
    });
    await flushPromises();

    assert.equal(suggestionRenders, 1, 'fresh suggestions should replace the bar once');
    assert.equal(context.appState.tagSuggestions[0].tag, 'fresh');
    assert.equal(context.appState.comboSuggestions[0].tags[1], 'combo');

    renderer.invalidateBlocklistSuggestions();
    assert.equal(context.appState.tagSuggestionsKey, null);
    assert.equal(suggestionRenders, 2, 'normal invalidation should still remove stale suggestions');
}

async function testPreviewClosesBeforeBanCompletes() {
    const busyStates = [];
    let resolveBan;
    let closeCalls = 0;
    let banOptions = null;
    const item = {
        path: 'sfw/wallhaven-preview.jpg',
        name: 'wallhaven-preview.jpg',
        reviewOnly: true,
    };
    const row = {
        dataset: { path: item.path },
        classList: {
            toggle: (_name, busy) => { busyStates.push(busy); },
        },
        querySelectorAll: () => [],
    };
    const context = {
        appState: {
            preferenceSuggestions: { items: [item] },
        },
        lightboxImg: item,
        document: {
            querySelectorAll: selector => selector === '.model-review-row' ? [row] : [],
        },
        console,
        banImage: (_path, options) => {
            banOptions = options;
            return new Promise(resolve => { resolveBan = resolve; });
        },
        closeLightbox: () => { closeCalls++; },
    };
    context.window = context;

    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['banLightboxReviewSuggestion'],
    );
    const pendingBan = renderer.banLightboxReviewSuggestion();

    assert.equal(closeCalls, 1, 'preview should close synchronously');
    assert.equal(busyStates[0], true);
    assert.equal(banOptions.preserveView, true);
    assert.equal(banOptions.preferenceContext, 'model_review');
    assert.equal(banOptions.refreshSuggestionsInPlace, true);

    resolveBan(false);
    assert.equal(await pendingBan, false);
    assert.equal(busyStates.at(-1), false);
}

(async () => {
    await testSuggestionRefreshStaysInPlace();
    await testPreviewClosesBeforeBanCompletes();
    console.log('model review action tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
