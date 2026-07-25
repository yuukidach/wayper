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

async function testReviewRowsHandleKeyboardActions() {
    const itemA = { path: 'sfw/wallhaven-a.jpg', name: 'wallhaven-a.jpg' };
    const itemB = { path: 'sfw/wallhaven-b.jpg', name: 'wallhaven-b.jpg' };
    const actions = [];
    let panel;
    const makeRow = item => ({
        dataset: { path: item.path },
        classList: {
            contains: () => false,
            toggle: () => {},
        },
        closest: selector => selector === '.model-review-row'
            ? rowsByPath[item.path]
            : selector === '.model-review-panel' ? panel : null,
        querySelectorAll: () => [],
        focus: () => { actions.push(`focus:${item.path}`); },
        scrollIntoView: () => {},
    });
    const rowsByPath = {};
    rowsByPath[itemA.path] = makeRow(itemA);
    rowsByPath[itemB.path] = makeRow(itemB);
    const rows = [rowsByPath[itemA.path], rowsByPath[itemB.path]];
    panel = { querySelectorAll: () => rows };

    const context = {
        appState: {
            preferenceSuggestions: { items: [itemA, itemB] },
            preferenceReviewResolvedPaths: new Set(),
        },
        document: {
            activeElement: rows[0],
            querySelectorAll: selector => selector === '.model-review-row' ? rows : [],
        },
        console,
        showLightbox: image => { actions.push(`preview:${image.path}`); },
        WayperApi: {
            // Leave the operation pending; this test only needs to assert that
            // the keyboard dispatch reaches the correct review action.
            preferenceFeedback: path => {
                actions.push(`keep:${path}`);
                return new Promise(() => {});
            },
        },
        banImage: path => {
            actions.push(`ban:${path}`);
            return new Promise(() => {});
        },
    };
    context.window = context;

    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['handleModelReviewRowKeyboard'],
    );
    const eventFor = (key, row = rows[0]) => ({
        key,
        target: row,
        currentTarget: row,
        preventDefault: () => {},
        stopPropagation: () => {},
    });

    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('Enter')), true);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('k')), false);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('K')), false);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('a')), true);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('A', rows[1])), true);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('x')), true);
    assert.equal(renderer.handleModelReviewRowKeyboard(eventFor('ArrowRight')), true);

    assert.deepEqual(actions, [
        `preview:${itemA.path}`,
        `keep:${itemA.path}`,
        `keep:${itemB.path}`,
        `ban:${itemA.path}`,
        `focus:${itemB.path}`,
    ]);
}

function testReviewRowsUseSpatialArrowNavigation() {
    const items = Array.from({ length: 6 }, (_, index) => ({
        path: `sfw/wallhaven-${index}.jpg`,
        name: `wallhaven-${index}.jpg`,
    }));
    const focusLog = [];
    const rows = [];
    const rowAt = (index, left, top) => {
        const row = {
            dataset: { path: items[index].path },
            classList: { contains: () => false },
            getBoundingClientRect: () => ({
                left,
                top,
                right: left + 100,
                bottom: top + 80,
                width: 100,
                height: 80,
            }),
            focus: () => { focusLog.push(index); },
            scrollIntoView: () => {},
            closest: selector => selector === '.model-review-row' ? row : panel,
        };
        rows.push(row);
        return row;
    };
    const panel = {
        querySelector: selector => selector === '.model-review-list'
            ? { clientWidth: 900 }
            : null,
        querySelectorAll: () => rows,
    };
    rowAt(0, 0, 0);
    rowAt(1, 110, 0);
    rowAt(2, 220, 0);
    rowAt(3, 0, 100);
    rowAt(4, 110, 100);
    rowAt(5, 220, 100);
    rows.forEach(row => {
        row.closest = selector => selector === '.model-review-row' ? row : panel;
    });
    const firstCard = {
        focus: () => { focusLog.push('gallery'); },
        scrollIntoView: () => {},
    };
    const context = {
        appState: {
            preferenceSuggestions: { items },
            preferenceReviewResolvedPaths: new Set(),
            gridColumns: 3,
        },
        document: {
            activeElement: rows[0],
            querySelectorAll: selector => selector === '.model-review-row' ? rows : [],
            querySelector: selector => selector === '.wallpaper-card' ? firstCard : null,
        },
        PREFERENCE_REVIEW_GAP: 8,
        PREFERENCE_REVIEW_CARD_MIN_WIDTH: 285,
        console,
    };
    context.window = context;

    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['handleModelReviewRowKeyboard'],
    );
    const eventFor = (key, row) => ({
        key,
        target: row,
        currentTarget: row,
        preventDefault: () => {},
        stopPropagation: () => {},
    });

    renderer.handleModelReviewRowKeyboard(eventFor('ArrowDown', rows[0]));
    renderer.handleModelReviewRowKeyboard(eventFor('ArrowUp', rows[3]));
    renderer.handleModelReviewRowKeyboard(eventFor('ArrowRight', rows[0]));
    renderer.handleModelReviewRowKeyboard(eventFor('ArrowLeft', rows[1]));
    renderer.handleModelReviewRowKeyboard(eventFor('ArrowDown', rows[5]));

    assert.deepEqual(focusLog, [3, 0, 1, 0, 'gallery']);

    // When layout metrics are unavailable (for example while a panel is
    // being mounted), fall back to the responsive column count instead of
    // reverting to a flat next-item sequence.
    const fallbackRows = Array.from({ length: 6 }, (_, index) => ({
        dataset: { path: items[index].path },
        classList: { contains: () => false },
        focus: () => { focusLog.push(`fallback:${index}`); },
        scrollIntoView: () => {},
        closest: selector => selector === '.model-review-row' ? fallbackRows[index] : fallbackPanel,
    }));
    const fallbackPanel = {
        querySelector: selector => selector === '.model-review-list' ? { clientWidth: 900 } : null,
        querySelectorAll: () => fallbackRows,
    };
    fallbackRows.forEach(row => {
        row.closest = selector => selector === '.model-review-row' ? row : fallbackPanel;
    });
    const fallbackContext = {
        appState: {
            preferenceSuggestions: { items },
            preferenceReviewResolvedPaths: new Set(),
            gridColumns: 3,
        },
        document: {
            querySelectorAll: selector => selector === '.model-review-row' ? fallbackRows : [],
            querySelector: () => null,
        },
        PREFERENCE_REVIEW_GAP: 8,
        PREFERENCE_REVIEW_CARD_MIN_WIDTH: 285,
        console,
    };
    fallbackContext.window = fallbackContext;
    const fallbackRenderer = loadRendererScript(
        'renderer-views.js',
        fallbackContext,
        ['handleModelReviewRowKeyboard'],
    );
    fallbackRenderer.handleModelReviewRowKeyboard(eventFor('ArrowDown', fallbackRows[0]));
    assert.equal(focusLog.at(-1), 'fallback:3');
}

function testGridNavigationBridgesModelReview() {
    const elements = new Map();
    const makeElement = id => {
        const element = {
            id,
            classList: {
                contains: () => false,
                add: () => {},
                remove: () => {},
                toggle: () => {},
            },
            style: {},
            dataset: {},
            hidden: false,
            textContent: '',
            innerHTML: '',
            appendChild: child => { child.parentNode = element; },
            addEventListener: () => {},
            querySelector: () => null,
            querySelectorAll: () => [],
            getAttribute: () => null,
            setAttribute: () => {},
            scrollIntoView: () => {},
            focus: () => { context.document.activeElement = element; },
            blur: () => {},
        };
        elements.set(id, element);
        return element;
    };
    const ids = [
        'wallpaper-grid', 'btn-pool', 'btn-favorites', 'btn-blocklist',
        'btn-purity-sfw', 'btn-purity-sketchy', 'btn-purity-nsfw',
        'monitors-list', 'search-input', 'search-dropdown', 'search-clear',
        'settings-view', 'btn-save-settings', 'btn-cancel-settings',
        'daemon-dot', 'daemon-status', 'disk-usage', 'count-pool',
        'count-favorites', 'count-blocklist', 'search-count',
    ];
    ids.forEach(makeElement);

    const cards = [];
    const rows = [];
    const body = makeElement('body');
    const context = {
        URLSearchParams,
        appState: undefined,
        document: {
            body,
            activeElement: body,
            createElement: makeElement,
            getElementById: id => elements.get(id) || makeElement(id),
            getElementsByClassName: selector => selector === 'wallpaper-card' ? cards : [],
            querySelectorAll: selector => selector === '.model-review-row' ? rows : [],
            addEventListener: () => {},
        },
        console,
        WayperBlocklistPager: { createState: () => ({}) },
        getComputedStyle: () => ({ gridTemplateColumns: '2fr 2fr' }),
        setTimeout,
        clearTimeout,
    };
    context.window = context;
    context.appState = {}; // The renderer script replaces this with its state.

    const makeFocusable = className => {
        const element = makeElement(`${className}-${cards.length + rows.length}`);
        element.classList.contains = value => value === className;
        element.closest = selector => selector === `.${className}` ? element : null;
        element.focus = () => { context.document.activeElement = element; };
        return element;
    };
    const cardA = makeFocusable('wallpaper-card');
    const cardB = makeFocusable('wallpaper-card');
    const reviewA = makeFocusable('model-review-row');
    const reviewB = makeFocusable('model-review-row');
    cards.push(cardA, cardB);
    rows.push(reviewA, reviewB);

    const renderer = loadRendererScript(
        'renderer-state.js',
        context,
        ['navigateGrid', 'handleGlobalKeydown', 'appState'],
    );
    renderer.navigateGrid('ArrowDown');
    assert.equal(context.document.activeElement, reviewA);
    renderer.navigateGrid('ArrowDown');
    assert.equal(context.document.activeElement, reviewB);
    renderer.navigateGrid('ArrowRight');
    assert.equal(context.document.activeElement, cardA);

    context.document.activeElement = cardA;
    renderer.navigateGrid('ArrowUp');
    assert.equal(context.document.activeElement, reviewA);

    // Removing the review queue restores the original gallery-only behavior.
    rows.length = 0;
    context.document.activeElement = cardA;
    renderer.navigateGrid('ArrowRight');
    assert.equal(context.document.activeElement, cardB);

    const keyEvent = key => ({
        key,
        target: { tagName: 'DIV' },
        preventDefault: () => {},
    });

    // The existing Blocklist shortcut keeps using A for AI analysis when no
    // review surface owns the event.
    let aiAnalysisCalls = 0;
    context.fetchAISuggestions = () => { aiAnalysisCalls++; };
    renderer.appState.mode = 'trash';
    context.lightboxEl = null;
    renderer.handleGlobalKeydown(keyEvent('a'));
    assert.equal(aiAnalysisCalls, 1);

    const lightboxArrows = [];
    const lightboxKeepCalls = [];
    context.lightboxEl = { contains: () => false };
    context.lightboxImg = { reviewOnly: true };
    context.navigateReviewLightbox = direction => lightboxArrows.push(direction);
    context.keepLightboxReviewSuggestion = () => { lightboxKeepCalls.push(true); };
    renderer.handleGlobalKeydown(keyEvent('ArrowLeft'));
    renderer.handleGlobalKeydown(keyEvent('ArrowRight'));
    renderer.handleGlobalKeydown(keyEvent('a'));
    renderer.handleGlobalKeydown(keyEvent('A'));
    renderer.handleGlobalKeydown(keyEvent('k'));
    assert.deepEqual(lightboxArrows, [-1, 1]);
    assert.equal(lightboxKeepCalls.length, 2);
}

function testReviewLightboxArrowNeighbors() {
    const items = [
        { path: 'sfw/first.jpg' },
        { path: 'sfw/second.jpg' },
        { path: 'sfw/third.jpg' },
    ];
    const renderer = loadRendererScript(
        'renderer-lightbox.js',
        {},
        ['reviewLightboxNeighbor'],
    );
    assert.equal(
        renderer.reviewLightboxNeighbor(items, items[1].path, -1),
        items[0],
    );
    assert.equal(
        renderer.reviewLightboxNeighbor(items, items[1].path, 1),
        items[2],
    );
    assert.equal(renderer.reviewLightboxNeighbor(items, items[0].path, -1), null);
    assert.equal(renderer.reviewLightboxNeighbor(items, items[2].path, 1), null);
}

(async () => {
    await testSuggestionRefreshStaysInPlace();
    await testPreviewClosesBeforeBanCompletes();
    await testReviewRowsHandleKeyboardActions();
    testReviewRowsUseSpatialArrowNavigation();
    testGridNavigationBridgesModelReview();
    testReviewLightboxArrowNeighbors();
    console.log('model review action tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
