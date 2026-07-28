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

    // The compact card deck owns the same shortcuts as its full preview even
    // when no individual button or card has focus.
    const deckMoves = [];
    const deckPreviews = [];
    const deckDecisions = [];
    const deckItem = { path: 'sfw/deck.jpg', name: 'deck.jpg' };
    renderer.appState.mode = 'model-review';
    renderer.appState.view = 'grid';
    context.selectedModelReviewItem = () => deckItem;
    context.moveModelReviewSelection = direction => { deckMoves.push(direction); };
    context.previewPreferenceSuggestion = item => { deckPreviews.push(item.path); };
    context.resolveModelReviewDecision = (item, action) => {
        deckDecisions.push([item.path, action]);
    };
    const hiddenGalleryActions = [];
    context.controlAction = action => { hiddenGalleryActions.push(action); };
    renderer.handleGlobalKeydown(keyEvent('ArrowLeft'));
    renderer.handleGlobalKeydown(keyEvent('ArrowDown'));
    renderer.handleGlobalKeydown(keyEvent('Enter'));
    renderer.handleGlobalKeydown(keyEvent(' '));
    renderer.handleGlobalKeydown(keyEvent('a'));
    renderer.handleGlobalKeydown(keyEvent('x'));
    const focusBeforeHiddenShortcuts = context.document.activeElement;
    renderer.handleGlobalKeydown(keyEvent('h'));
    renderer.handleGlobalKeydown(keyEvent('/'));
    assert.deepEqual(deckMoves, [-1, 1]);
    assert.deepEqual(deckPreviews, [deckItem.path, deckItem.path]);
    assert.deepEqual(deckDecisions, [
        [deckItem.path, 'keep'],
        [deckItem.path, 'ban'],
    ]);
    assert.deepEqual(hiddenGalleryActions, []);
    assert.equal(context.document.activeElement, focusBeforeHiddenShortcuts);

    // Settings also hides the gallery toolbar and must not dispatch its
    // current-wallpaper shortcuts behind the form.
    renderer.appState.view = 'settings';
    renderer.handleGlobalKeydown(keyEvent('l'));
    renderer.handleGlobalKeydown(keyEvent('x'));
    assert.deepEqual(hiddenGalleryActions, []);
    renderer.appState.view = 'grid';

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

function testCarouselSelectionDoesNotRerenderWorkspace() {
    const first = { path: 'sfw/landscape/first.jpg' };
    const second = { path: 'sfw/landscape/second.jpg' };
    const scrolls = [];
    const focused = [];
    const makeCard = item => {
        const classes = new Set(['model-review-card']);
        return {
            dataset: { path: item.path },
            tabIndex: -1,
            classList: {
                contains: value => classes.has(value),
                toggle: (value, enabled) => {
                    if (enabled) classes.add(value);
                    else classes.delete(value);
                },
            },
            setAttribute: () => {},
            querySelectorAll: () => [],
            scrollIntoView: options => { scrolls.push([item.path, options.behavior]); },
            focus: () => { focused.push(item.path); },
        };
    };
    const cards = [makeCard(first), makeCard(second)];
    const carousel = {
        querySelectorAll: selector => selector === '.model-review-card' ? cards : [],
        querySelector: selector => cards.find(card => selector.includes(card.dataset.path)) || null,
    };
    let renders = 0;
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewData: {
                recommendations: [first, second],
                items: [],
            },
            modelReviewSelectedPath: first.path,
            modelReviewResolvedPaths: new Set(),
        },
        CSS: { escape: value => value },
        console,
        els: {
            wallpaperGrid: {
                querySelector: selector => selector === '.model-review-carousel'
                    ? carousel
                    : null,
            },
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['selectModelReviewItem', 'moveModelReviewSelection'],
    );
    context.renderModelReviewView = () => { renders++; };

    assert.equal(renderer.selectModelReviewItem(second.path, { focus: true }), true);
    assert.equal(context.appState.modelReviewSelectedPath, second.path);
    assert.equal(scrolls.at(-1)[0], second.path);
    assert.equal(scrolls.at(-1)[1], 'smooth');
    assert.equal(focused.at(-1), second.path);
    assert.equal(renders, 0);

    assert.equal(renderer.moveModelReviewSelection(1), false);
    assert.equal(context.appState.modelReviewSelectedPath, second.path);
    assert.equal(renders, 0);

    assert.equal(renderer.moveModelReviewSelection(-1), true);
    assert.equal(context.appState.modelReviewSelectedPath, first.path);
    assert.equal(renders, 0);
}

function testEnteringModelReviewReplacesLibraryImmediately() {
    const events = [];
    const classList = { add: () => {}, remove: () => {} };
    const context = {
        appState: {
            mode: 'pool',
            view: 'grid',
            purity: ['sfw'],
            currentOrient: 'landscape',
        },
        els: {
            wallpaperGrid: { classList },
            settingsView: { classList },
            btnSettings: { classList },
        },
        document: { body: { setAttribute: () => {} } },
        console,
        updateUI: () => { events.push('ui'); },
        renderModelReviewView: () => { events.push('render'); },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['setViewMode'],
    );

    void renderer.setViewMode('model-review');

    assert.equal(context.appState.mode, 'model-review');
    assert.ok(events.includes('render'));
    assert.equal(Object.hasOwn(context.appState, 'modelReviewLoading'), false);
}

function testLeavingModelReviewRestoresCachedPoolImmediately() {
    const events = [];
    const classList = { add: () => {}, remove: () => {} };
    const wallpaperGrid = { classList, innerHTML: 'model cards' };
    const context = {
        appState: {
            mode: 'model-review',
            view: 'grid',
            purity: ['sfw'],
            currentOrient: 'landscape',
            loadedImageMode: 'pool',
            loadedImageContextKey: JSON.stringify({
                mode: 'pool', purities: ['sfw'], orient: 'landscape',
            }),
        },
        els: {
            wallpaperGrid,
            settingsView: { classList },
            btnSettings: { classList },
        },
        document: { body: { setAttribute: () => {} } },
        console,
        updateUI: () => {},
        renderImages: () => {
            wallpaperGrid.innerHTML = 'pool images';
            events.push('pool');
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['setViewMode'],
    );

    void renderer.setViewMode('pool');

    assert.equal(context.appState.mode, 'pool');
    assert.deepEqual(events, ['pool']);
    assert.equal(wallpaperGrid.innerHTML, 'pool images');
}

function testLeavingModelReviewClearsDeckWithoutMatchingCache() {
    const classList = { add: () => {}, remove: () => {} };
    const wallpaperGrid = { classList, innerHTML: 'model cards' };
    const context = {
        appState: {
            mode: 'model-review',
            view: 'grid',
            purity: ['sfw'],
            currentOrient: 'landscape',
            loadedImageMode: 'favorites',
            loadedImageContextKey: JSON.stringify({
                mode: 'favorites', purities: ['sfw'], orient: 'landscape',
            }),
        },
        els: {
            wallpaperGrid,
            settingsView: { classList },
            btnSettings: { classList },
        },
        document: { body: { setAttribute: () => {} } },
        console,
        updateUI: () => {},
        renderImages: () => { throw new Error('stale library cache must not render'); },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['setViewMode'],
    );

    void renderer.setViewMode('pool');

    assert.equal(context.appState.mode, 'pool');
    assert.equal(wallpaperGrid.innerHTML, '');
}

function testModelReviewHydratesOnlyActiveCardAndNeighbors() {
    const makeImage = path => ({
        src: '',
        dataset: { src: path },
        loading: 'lazy',
        fetchPriority: 'low',
    });
    const makeCard = index => {
        const classes = new Set(['model-review-card']);
        const images = [
            makeImage(`image-${index}-backdrop`),
            makeImage(`image-${index}-foreground`),
        ];
        return {
            dataset: { path: `image-${index}` },
            classList: {
                contains: value => classes.has(value),
                toggle: (value, enabled) => {
                    if (enabled) classes.add(value);
                    else classes.delete(value);
                },
            },
            style: { setProperty: () => {} },
            setAttribute: () => {},
            querySelectorAll: selector => selector.includes('model-review-card-backdrop')
                ? images
                : [],
            images,
        };
    };
    const cards = Array.from({ length: 5 }, (_, index) => makeCard(index));
    const carousel = {
        dataset: {},
        classList: { contains: () => false },
        querySelectorAll: selector => selector === '.model-review-card' ? cards : [],
        closest: () => null,
    };
    const context = { console };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['markActiveModelReviewCard'],
    );

    renderer.markActiveModelReviewCard(carousel, 'image-2');

    for (const index of [0, 4]) {
        assert.ok(cards[index].images.every(image => image.src === ''));
    }
    for (const index of [1, 2, 3]) {
        assert.ok(cards[index].images.every(image => image.src !== ''));
    }
    assert.ok(cards[2].images.every(image => image.fetchPriority === 'high'));
    assert.ok(cards[1].images.every(image => image.fetchPriority === 'low'));
    assert.ok(cards[3].images.every(image => image.fetchPriority === 'low'));
}

function testReviewZeroStateDistinguishesCompletionLearningAndFailure() {
    const context = {
        appState: {
            config: { wallhaven: { filter_strategy: 'model' } },
        },
        console,
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['modelReviewZeroStatePresentation'],
    );

    const complete = renderer.modelReviewZeroStatePresentation({
        status: 'ready', recommendation_status: 'ready', filter_strategy: 'model',
    });
    assert.equal(complete.variant, 'complete');
    assert.equal(complete.title, 'You’re all caught up');
    assert.equal(complete.action, 'pool');
    assert.equal(complete.title.includes('No '), false);

    const learning = renderer.modelReviewZeroStatePresentation({
        status: 'ready', recommendation_status: 'untrained',
    });
    assert.equal(learning.variant, 'learning');
    assert.equal(learning.title, 'The model is still learning');
    assert.equal(learning.actionLabel, 'Browse Pool');

    const unavailable = renderer.modelReviewZeroStatePresentation({
        status: 'error', recommendation_status: 'error', error: 'request failed',
    });
    assert.equal(unavailable.variant, 'unavailable');
    assert.equal(unavailable.detail, 'request failed');
    assert.equal(unavailable.action, 'retry');
}

function testResolvedCardCollapsesBeforeRemovalWithoutSecondScroll() {
    const first = { path: 'sfw/landscape/first.jpg' };
    const second = { path: 'sfw/landscape/second.jpg' };
    const cards = [];
    const focused = [];
    const scrolls = [];
    const makeClassList = initial => {
        const values = new Set(initial);
        return {
            add: (...names) => names.forEach(name => values.add(name)),
            remove: (...names) => names.forEach(name => values.delete(name)),
            contains: name => values.has(name),
            toggle: (name, enabled) => {
                if (enabled) values.add(name);
                else values.delete(name);
            },
        };
    };
    const makeCard = item => {
        const listeners = {};
        const decision = { disabled: false };
        const card = {
            dataset: { path: item.path },
            classList: makeClassList(['model-review-card']),
            style: { setProperty: () => {} },
            tabIndex: -1,
            setAttribute: () => {},
            querySelectorAll: selector => selector === '.model-review-card-decision'
                ? [decision]
                : [],
            addEventListener: (name, listener) => { listeners[name] = listener; },
            removeEventListener: name => { delete listeners[name]; },
            remove: () => { cards.splice(cards.indexOf(card), 1); },
            focus: () => { focused.push(item.path); },
            listeners,
            decision,
        };
        return card;
    };
    const firstCard = makeCard(first);
    const secondCard = makeCard(second);
    cards.push(firstCard, secondCard);
    const deck = {
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const carousel = {
        dataset: { source: 'recommended', activePath: first.path },
        classList: makeClassList(['model-review-carousel']),
        querySelectorAll: selector => selector === '.model-review-card' ? cards : [],
        querySelector: selector => cards.find(card => selector.includes(card.dataset.path)) || null,
        closest: selector => selector === '.model-review-deck' ? deck : null,
        scrollTo: options => { scrolls.push(options); },
    };
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewSource: 'recommended',
            modelReviewData: { items: [], recommendations: [second] },
            modelReviewSelectedPath: second.path,
            modelReviewResolvedPaths: new Set([first.path]),
        },
        CSS: { escape: value => value },
        console,
        setTimeout: () => 1,
        els: {
            wallpaperGrid: {
                querySelector: selector => selector === '.model-review-carousel'
                    ? carousel
                    : null,
            },
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['removeResolvedModelReviewCard'],
    );
    context.renderModelReviewView = () => {};

    renderer.removeResolvedModelReviewCard(first.path, 'keep');

    assert.equal(carousel.classList.contains('is-resolving-card'), true);
    assert.equal(firstCard.classList.contains('is-resolving'), true);
    assert.equal(firstCard.classList.contains('resolve-keep'), true);
    assert.equal(secondCard.classList.contains('active'), true);
    assert.equal(secondCard.decision.disabled, true);
    assert.equal(scrolls.length, 0);

    firstCard.listeners.transitionend({ target: firstCard, propertyName: 'flex-basis' });

    assert.deepEqual(cards, [secondCard]);
    assert.equal(carousel.classList.contains('is-resolving-card'), false);
    assert.equal(secondCard.decision.disabled, false);
    assert.deepEqual(focused, [second.path]);
    assert.equal(scrolls.length, 0, 'removal must not launch a second smooth scroll');
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

function testInboxDecisionUpdatesDedicatedQueueState() {
    const first = {
        path: '.model-review/sfw/landscape/first.jpg',
        name: 'first.jpg',
        auto_filtered: true,
    };
    const second = {
        path: '.model-review/sfw/landscape/second.jpg',
        name: 'second.jpg',
        auto_filtered: true,
    };
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewData: {
                items: [first, second],
                pending_count: 2,
                learning: { pending_feedback: 1 },
            },
            modelReviewSelectedPath: first.path,
            modelReviewResolvedPaths: new Set(),
            status: {
                model_review_count: 2,
                pool_count: 10,
                blocklist_count: 4,
            },
        },
        console,
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['applyModelReviewDecisionResult', 'modelReviewQueueItems'],
    );

    const next = renderer.applyModelReviewDecisionResult(first, 'keep', {
        review: { new_path: 'sfw/landscape/first.jpg' },
        learning: { pending_feedback: 2 },
    });

    assert.equal(next, second.path);
    assert.equal(
        renderer.modelReviewQueueItems().map(item => item.path).join(','),
        second.path,
    );
    assert.equal(context.appState.modelReviewData.pending_count, 1);
    assert.equal(context.appState.modelReviewData.learning.pending_feedback, 2);
    assert.equal(context.appState.status.model_review_count, 1);
    assert.equal(context.appState.status.pool_count, 11);
    assert.equal(context.appState.status.blocklist_count, 4);
}

function testRecommendationDecisionDoesNotChangeHeldOrLibraryCounts() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        auto_filtered: true,
    };
    const first = { path: 'sfw/landscape/first.jpg', rank: 1 };
    const second = { path: 'sfw/landscape/second.jpg', rank: 2 };
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewData: {
                items: [held],
                recommendations: [first, second],
                pending_count: 1,
                recommendation_count: 2,
                learning: { pending_feedback: 1 },
            },
            modelReviewSelectedPath: first.path,
            modelReviewResolvedPaths: new Set(),
            status: {
                model_review_count: 1,
                pool_count: 10,
                blocklist_count: 4,
            },
        },
        console,
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['applyModelReviewDecisionResult', 'modelReviewQueueItems'],
    );

    const next = renderer.applyModelReviewDecisionResult(first, 'keep', {
        learning: { pending_feedback: 2 },
    });

    assert.equal(next, second.path);
    assert.equal(
        renderer.modelReviewQueueItems().map(item => item.path).join(','),
        [second.path, held.path].join(','),
    );
    assert.equal(context.appState.modelReviewData.items.length, 1);
    assert.equal(context.appState.modelReviewData.items[0], held);
    assert.equal(context.appState.modelReviewData.pending_count, 1);
    assert.equal(context.appState.modelReviewData.recommendation_count, 1);
    assert.equal(context.appState.modelReviewData.learning.pending_feedback, 2);
    assert.equal(context.appState.status.model_review_count, 1);
    assert.equal(context.appState.status.pool_count, 10);
    assert.equal(context.appState.status.blocklist_count, 4);
}

function testResolvingLastHoldMovesToRecommendationLane() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        auto_filtered: true,
    };
    const recommendation = { path: 'sfw/landscape/recommended.jpg', rank: 1 };
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewSource: 'held',
            modelReviewData: {
                items: [held],
                recommendations: [recommendation],
                pending_count: 1,
                recommendation_count: 1,
            },
            modelReviewSelectedPath: held.path,
            modelReviewResolvedPaths: new Set(),
            status: {
                model_review_count: 1,
                pool_count: 10,
                blocklist_count: 4,
            },
        },
        console,
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['applyModelReviewDecisionResult', 'modelReviewVisibleItems'],
    );

    const next = renderer.applyModelReviewDecisionResult(held, 'keep', {
        review: { new_path: 'sfw/landscape/held.jpg' },
    });

    assert.equal(context.appState.modelReviewSource, 'recommended');
    assert.equal(next, recommendation.path);
    assert.deepEqual(renderer.modelReviewVisibleItems(), [recommendation]);
}

async function testInboxRoutesDecisionsByCandidateSource() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        name: 'held.jpg',
        auto_filtered: true,
    };
    const keepRecommendation = {
        path: 'sfw/landscape/keep.jpg',
        name: 'keep.jpg',
    };
    const banRecommendation = {
        path: 'sfw/landscape/ban.jpg',
        name: 'ban.jpg',
    };
    const modelActions = [];
    const feedbackActions = [];
    const banActions = [];
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewData: {
                items: [held],
                recommendations: [keepRecommendation, banRecommendation],
                pending_count: 1,
                recommendation_count: 2,
            },
            modelReviewSelectedPath: held.path,
            modelReviewResolvedPaths: new Set(),
            modelReviewActionInFlight: new Set(),
            status: {
                model_review_count: 1,
                pool_count: 10,
                blocklist_count: 4,
            },
        },
        alert: () => {},
        CSS: { escape: value => value },
        console,
        els: {
            wallpaperGrid: { querySelector: () => null },
        },
        WayperApi: {
            modelReviewAction: async (path, action) => {
                modelActions.push([path, action]);
                return {
                    status: 'ok',
                    review: { new_path: 'sfw/landscape/held.jpg' },
                };
            },
            preferenceFeedback: async (path, action) => {
                feedbackActions.push([path, action]);
                return { status: 'ok', learning: { pending_feedback: 2 } };
            },
        },
        banImage: async (path, options) => {
            banActions.push([path, options]);
            return { status: 'ok', learning: { pending_feedback: 3 } };
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['resolveModelReviewDecision'],
    );
    context.updateStatusUI = () => {};
    context.renderModelReviewView = () => {};

    assert.equal(await renderer.resolveModelReviewDecision(held, 'keep'), true);
    context.appState.modelReviewSelectedPath = keepRecommendation.path;
    assert.equal(await renderer.resolveModelReviewDecision(keepRecommendation, 'keep'), true);
    assert.equal(await renderer.resolveModelReviewDecision(banRecommendation, 'ban'), true);

    assert.deepEqual(modelActions, [[held.path, 'keep']]);
    assert.deepEqual(feedbackActions, [[keepRecommendation.path, 'keep']]);
    assert.equal(banActions.length, 1);
    assert.equal(banActions[0][0], banRecommendation.path);
    assert.equal(banActions[0][1].preserveView, true);
    assert.equal(banActions[0][1].preferenceContext, 'model_review');
    assert.equal(banActions[0][1].returnResult, true);
    assert.equal(context.appState.status.model_review_count, 0);
    assert.equal(context.appState.status.pool_count, 11);
    assert.equal(context.appState.status.blocklist_count, 4);
}

async function testAutomaticHoldsStayVisibleWhenAutomaticFilteringIsOff() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        auto_filtered: true,
    };
    const recommendation = {
        path: 'sfw/landscape/recommended.jpg',
        rank: 1,
    };
    const requests = [];
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            imageRequestId: 7,
            preferenceSuggestionRequestId: 0,
            config: { wallhaven: { filter_strategy: 'rules' } },
        },
        console,
        isModelReviewMode: () => true,
        WayperApi: {
            modelReview: async (...args) => {
                requests.push(['held', ...args]);
                return {
                    status: 'ready',
                    filter_strategy: 'rules',
                    items: [held],
                    pending_count: 1,
                };
            },
            preferenceSuggestions: async (...args) => {
                requests.push(['recommendations', ...args]);
                return {
                    status: 'ready',
                    items: [recommendation],
                    diagnostics: { candidate_count: 1 },
                };
            },
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchModelReview'],
    );

    assert.equal(await renderer.fetchModelReview({ requestId: 7 }), true);
    assert.equal(context.appState.modelReviewSource, 'held');
    assert.equal(context.appState.modelReviewSelectedPath, held.path);
    assert.deepEqual(context.appState.modelReviewData.items, [held]);
    assert.deepEqual(context.appState.modelReviewData.recommendations, [recommendation]);
    assert.equal(requests.length, 2);
}

async function testHeldCardsRenderBeforeRecommendationRankingFinishes() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        auto_filtered: true,
    };
    const recommendation = { path: 'sfw/landscape/recommended.jpg', rank: 1 };
    let resolveRecommendations;
    let renders = 0;
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            imageRequestId: 4,
            preferenceSuggestionRequestId: 0,
            config: { wallhaven: { filter_strategy: 'model' } },
        },
        console,
        isModelReviewMode: () => true,
        renderModelReviewView: () => { renders++; },
        WayperApi: {
            modelReview: async () => ({
                status: 'ready', items: [held], pending_count: 1,
            }),
            preferenceSuggestions: () => new Promise(resolve => {
                resolveRecommendations = resolve;
            }),
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchModelReview'],
    );

    const pending = renderer.fetchModelReview({ requestId: 4 });
    await flushPromises();

    assert.deepEqual(context.appState.modelReviewData.items, [held]);
    assert.equal(context.appState.modelReviewData.recommendation_status, 'pending');
    assert.equal(context.appState.modelReviewSelectedPath, held.path);
    assert.ok(renders >= 1);

    resolveRecommendations({
        status: 'ready',
        items: [recommendation],
        diagnostics: { candidate_count: 1 },
    });
    assert.equal(await pending, true);
    assert.deepEqual(context.appState.modelReviewData.recommendations, [recommendation]);
}

async function testLateModelReviewResponseCannotRemountDeckAfterLeaving() {
    let resolveHeld;
    let resolveRecommendations;
    let renders = 0;
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            imageRequestId: 9,
            preferenceSuggestionRequestId: 0,
            config: { wallhaven: { filter_strategy: 'model' } },
        },
        console,
        isModelReviewMode: () => context.appState.mode === 'model-review',
        renderModelReviewView: () => { renders++; },
        WayperApi: {
            modelReview: () => new Promise(resolve => { resolveHeld = resolve; }),
            preferenceSuggestions: () => new Promise(resolve => {
                resolveRecommendations = resolve;
            }),
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchModelReview'],
    );

    const pending = renderer.fetchModelReview({ requestId: 9 });
    assert.equal(renders, 1);

    context.appState.mode = 'pool';
    context.appState.imageRequestId = 10;
    resolveHeld({ status: 'ready', items: [], pending_count: 0 });
    resolveRecommendations({ status: 'ready', items: [] });

    assert.equal(await pending, false);
    assert.equal(renders, 1, 'a stale response must not mount the review workspace again');
}

(async () => {
    await testSuggestionRefreshStaysInPlace();
    await testPreviewClosesBeforeBanCompletes();
    await testReviewRowsHandleKeyboardActions();
    await testInboxRoutesDecisionsByCandidateSource();
    await testAutomaticHoldsStayVisibleWhenAutomaticFilteringIsOff();
    await testHeldCardsRenderBeforeRecommendationRankingFinishes();
    await testLateModelReviewResponseCannotRemountDeckAfterLeaving();
    testReviewRowsUseSpatialArrowNavigation();
    testGridNavigationBridgesModelReview();
    testCarouselSelectionDoesNotRerenderWorkspace();
    testEnteringModelReviewReplacesLibraryImmediately();
    testLeavingModelReviewRestoresCachedPoolImmediately();
    testLeavingModelReviewClearsDeckWithoutMatchingCache();
    testModelReviewHydratesOnlyActiveCardAndNeighbors();
    testReviewZeroStateDistinguishesCompletionLearningAndFailure();
    testResolvedCardCollapsesBeforeRemovalWithoutSecondScroll();
    testReviewLightboxArrowNeighbors();
    testInboxDecisionUpdatesDedicatedQueueState();
    testRecommendationDecisionDoesNotChangeHeldOrLibraryCounts();
    testResolvingLastHoldMovesToRecommendationLane();
    console.log('model review action tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
