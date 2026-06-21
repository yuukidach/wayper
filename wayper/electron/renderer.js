let API_URL = 'http://127.0.0.1:8080';
window.WayperAPI_URL = API_URL;

const _escDiv = document.createElement('div');
function esc(str) {
    _escDiv.textContent = str;
    return _escDiv.innerHTML;
}

function createTypeBadge(type) {
    const badge = document.createElement('span');
    badge.className = `search-type-badge ${type}`;
    badge.textContent = type;
    return badge;
}

// SVG icon templates
const ICONS = {
    setWallpaper: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
    favorite: (s = 16, filled = false) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    ban: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    restore: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg>`,
    externalLink: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    chevronLeft: (s = 24) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevronRight: (s = 24) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>`,
};

// Wallhaven helpers
function wallhavenId(name) {
    const stem = name.includes('.') ? name.split('.').slice(0, -1).join('.') : name;
    return stem.includes('-') ? stem.split('-').slice(1).join('-') : stem;
}

function openWallhavenUrl(name) {
    window.open(`https://wallhaven.cc/w/${wallhavenId(name)}`, '_blank');
}

function focusedCardImage() {
    const card = document.activeElement;
    if (!card || !card.classList.contains('wallpaper-card')) return null;
    return appState.images.find(i => i.path === card.dataset.path) || null;
}

// State
let appState = {
    mode: 'pool', // pool, favorites, trash
    purity: ['sfw'], // active purities: subset of ['sfw', 'sketchy', 'nsfw']
    monitors: [],
    selectedMonitor: null, // monitor name
    status: { running: false, pid: null },
    refreshing: false, // true while refreshImages is in-flight
    images: [],
    config: null, // Full config object
    view: 'grid', // grid, settings
    blocklistTab: 'recoverable', // recoverable, blocked
    blocklistData: null, // cached blocklist data
    tagSuggestions: null, // tag exclusion suggestions
    comboSuggestions: null, // auto-discovered combo exclusion suggestions
    tagSuggestionsKey: null, // current purity/exclusion context for suggestions
    tagSuggestionsGeneration: 0, // invalidates stale in-flight suggestion requests
    reviewingTag: null, // tag currently being reviewed in blocklist
    reviewingUploader: null, // uploader currently being reviewed in blocklist
    comboContext: [], // drill-down context for combo exclusion [tag1, tag2, ...]
    comboRefinements: [], // refinement suggestions for current context
    aiSuggestions: null,           // Result from /api/ai-suggestions
    aiLoading: false,              // Whether AI analysis is in progress
    aiStartTime: null,             // Timestamp when AI analysis started
    aiTimer: null,                 // Interval ID for elapsed time updates

    // Search
    searchQuery: '',
    searchMatches: null, // Set of filenames, or null = no search
    searchRequestId: 0,
    allImages: [], // unfiltered image list

    // Pagination
    batchSize: 60,
    pageSize: 120,
    currentBatchIndex: 0,
    totalImages: 0,
    nextOffset: null,
    imagesComplete: false,
    loadingMoreImages: false,
    imageRequestId: 0,
    currentOrient: 'landscape',

    // Layout
    gridColumns: 1
};

let observer = null;
let sentinel = null;

// Global Loader
const loader = document.createElement('div');
loader.className = 'global-loader';
loader.innerHTML = '<div class="spinner"></div>';
document.body.appendChild(loader);

const loaderStyle = document.createElement('style');
loaderStyle.textContent = `
.global-loader {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
    z-index: 9999; opacity: 0; pointer-events: none; transition: opacity 0.2s;
}
.global-loader.visible { opacity: 1; pointer-events: auto; }
.spinner {
    width: 40px; height: 40px; border: 4px solid var(--surface0);
    border-top-color: var(--blue); border-radius: 50%;
    animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
`;
document.head.appendChild(loaderStyle);

function showLoader() { loader.classList.add('visible'); }
function hideLoader() { loader.classList.remove('visible'); }

function applyMonitorCurrentImage(monitorName, imagePath) {
    if (!monitorName || !imagePath) return;
    const monitor = appState.monitors.find(m => m.name === monitorName);
    if (monitor) {
        monitor.current_image = imagePath;
    }
    renderMonitors();
    markCurrentWallpaper();
}

function applyMonitorCurrentImages(imagesByMonitor) {
    if (!imagesByMonitor) return;
    for (const [monitorName, imagePath] of Object.entries(imagesByMonitor)) {
        const monitor = appState.monitors.find(m => m.name === monitorName);
        if (monitor && imagePath) {
            monitor.current_image = imagePath;
        }
    }
    renderMonitors();
    markCurrentWallpaper();
}

// DOM Elements
const els = {
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnUndo: document.getElementById('btn-undo'),
    btnFav: document.getElementById('btn-fav-current'),
    btnLocate: document.getElementById('btn-locate-current'),
    btnBan: document.getElementById('btn-ban-current'),

    btnPool: document.getElementById('btn-pool'),
    btnFavorites: document.getElementById('btn-favorites'),
    btnBlocklist: document.getElementById('btn-blocklist'),

    btnPuritySfw: document.getElementById('btn-purity-sfw'),
    btnPuritySketchy: document.getElementById('btn-purity-sketchy'),
    btnPurityNsfw: document.getElementById('btn-purity-nsfw'),

    btnDaemon: document.getElementById('btn-daemon'),
    btnSettings: document.getElementById('btn-settings'),

    monitorsList: document.getElementById('monitors-list'),

    // Views
    mainContent: document.getElementById('main-content'),
    wallpaperGrid: document.getElementById('wallpaper-grid'),
    settingsView: document.getElementById('settings-view'),

    // Settings
    btnSaveSettings: document.getElementById('btn-save-settings'),
    btnCancelSettings: document.getElementById('btn-cancel-settings'),

    // Footer
    daemonDot: document.getElementById('daemon-dot'),
    daemonStatus: document.getElementById('daemon-status'),
    diskUsage: document.getElementById('disk-usage'),
    countPool: document.getElementById('count-pool'),
    countFavorites: document.getElementById('count-favorites'),
    countBlocklist: document.getElementById('count-blocklist'),

    // Search
    searchInput: document.getElementById('search-input'),
    searchCount: document.getElementById('search-count'),
    searchClear: document.getElementById('search-clear'),
    searchDropdown: document.getElementById('search-dropdown'),
};

// Init
document.addEventListener('DOMContentLoaded', init);

async function init() {
    // Resolve API port from main process (auto-selected free port)
    if (window.electronAPI?.getApiPort) {
        const port = await window.electronAPI.getApiPort();
        if (port > 0) {
            API_URL = `http://127.0.0.1:${port}`;
            window.WayperAPI_URL = API_URL;
        }
    }
    setupEventListeners();
    setupInfiniteScroll();

    // Resize listener for grid layout
    window.addEventListener('resize', debounce(() => {
        updateGridMetrics();
    }, 200));

    // Phase 1: config, monitors, and daemon start are independent
    await Promise.all([fetchConfig(), fetchMonitors(), ensureDaemon()]);
    // Phase 2: all depend on config/monitors being ready
    await Promise.all([fetchStatus(), fetchDiskUsage(), refreshImages()]);

    // Initial metrics update after images loaded (or attempted)
    setTimeout(updateGridMetrics, 500);

    // SSE for real-time mode changes
    connectSSE();

    // Poll status (counts, daemon state)
    setInterval(() => {
        if (!document.hidden) fetchStatus();
    }, 10000);
    setInterval(fetchDiskUsage, 30000);
}

function setupEventListeners() {
    // Top Controls
    els.btnPrev.onclick = () => controlAction('prev');
    els.btnNext.onclick = () => controlAction('next');
    els.btnUndo.onclick = () => undoBan();
    els.btnFav.onclick = () => controlAction('fav');
    els.btnLocate.onclick = () => scrollToCurrentWallpaper();
    els.btnBan.onclick = () => controlAction('ban');

    // Sidebar: Library
    els.btnPool.onclick = () => setViewMode('pool');
    els.btnFavorites.onclick = () => setViewMode('favorites');
    els.btnBlocklist.onclick = () => setViewMode('trash');

    // Sidebar: Purity toggles
    els.btnPuritySfw.onclick = () => toggleSinglePurity('sfw');
    els.btnPuritySketchy.onclick = () => toggleSinglePurity('sketchy');
    els.btnPurityNsfw.onclick = () => toggleSinglePurity('nsfw');

    // Sidebar: Daemon
    els.btnDaemon.onclick = toggleDaemon;

    // Sidebar: Settings
    els.btnSettings.onclick = () => switchView('settings');

    // Settings Form
    els.btnSaveSettings.onclick = saveSettings;
    els.btnCancelSettings.onclick = () => switchView('grid');
    document.getElementById('btn-add-tag').onclick = addExcludeTag;
    document.getElementById('input-exclude-tag').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addExcludeTag(); }
    });
    document.getElementById('btn-add-uploader').onclick = addExcludeUploader;
    document.getElementById('input-exclude-uploader').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addExcludeUploader(); }
    });

    // Search
    els.searchInput.addEventListener('input', onSearchInput);
    els.searchInput.addEventListener('keydown', handleSearchKeydown);
    els.searchInput.addEventListener('blur', () => {
        // Delay to allow click on dropdown items
        setTimeout(() => els.searchDropdown.classList.add('hidden'), 150);
    });
    els.searchInput.addEventListener('focus', () => {
        if (els.searchInput.value.trim()) {
            performSearch(els.searchInput.value.trim());
        }
    });
    els.searchClear.onclick = () => { clearSearch(); els.searchInput.blur(); };

    // Keyboard Shortcuts
    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('mouseup', handleMouseBack);
}

function handleMouseBack(e) {
    // Mouse back button (button 3) exits tag review or search
    if (e.button !== 3) return;
    if (lightboxEl) { closeLightbox(); return; }
    if (appState.reviewingTag) {
        e.preventDefault();
        exitComboLevel();
        return;
    }
    if (appState.searchQuery) {
        e.preventDefault();
        clearSearch();
    }
}

let _pendingG = null;

function handleGlobalKeydown(e) {
    // Ignore if typing in an input
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.target.tagName === 'INPUT' && e.target.id !== 'search-input') return;
    if (e.target.id === 'search-input') return; // handled by handleSearchKeydown

    // Lightbox-specific shortcuts
    if (lightboxEl) {
        switch(e.key) {
            case 'Escape':
                closeLightbox();
                return;
            case 'ArrowLeft':
                e.preventDefault();
                arrowPanOrNavigate(-1);
                return;
            case 'ArrowRight':
                e.preventDefault();
                arrowPanOrNavigate(1);
                return;
            case 'Enter':
                e.preventDefault();
                if (lightboxImg) { setWallpaper(lightboxImg.path); closeLightbox(); }
                return;
            case ' ':
                e.preventDefault();
                closeLightbox();
                return;
            case 'f':
                if (lightboxImg) { toggleFavoriteImage(lightboxImg.path); closeLightbox(); }
                return;
            case 'x':
            case 'Delete':
                if (lightboxImg) { banImage(lightboxImg.path); closeLightbox(); }
                return;
            case 'o':
                if (lightboxImg) openWallhavenUrl(lightboxImg.name);
                return;
            case '0':
                e.preventDefault();
                resetZoom();
                return;
            case '+':
            case '=':
                e.preventDefault();
                zoomAtCenter(ZOOM_STEP_FACTOR);
                return;
            case '-':
                e.preventDefault();
                zoomAtCenter(1 / ZOOM_STEP_FACTOR);
                return;
        }
        return;
    }

    // Purity toggles (F1/F2/F3)
    if (e.key === 'F1') { e.preventDefault(); toggleSinglePurity('sfw'); return; }
    if (e.key === 'F2') { e.preventDefault(); toggleSinglePurity('sketchy'); return; }
    if (e.key === 'F3') { e.preventDefault(); toggleSinglePurity('nsfw'); return; }

    // Check if a card is focused
    const focusedCard = document.activeElement && document.activeElement.classList.contains('wallpaper-card') ? document.activeElement : null;

    switch(e.key) {
        case 'Escape':
            if (appState.reviewingTag) {
                exitComboLevel();
            } else if (appState.searchQuery) {
                clearSearch();
            } else if (focusedCard) {
                document.activeElement.blur();
            }
            break;
        case 'l':
            controlAction('next');
            break;
        case 'h':
            controlAction('prev');
            break;
        case 'f':
            if (focusedCard) {
                toggleFavoriteImage(focusedCard.dataset.path);
            } else {
                controlAction('fav');
            }
            break;
        case 'x':
        case 'Delete':
            if (focusedCard) {
                banImage(focusedCard.dataset.path);
            } else {
                controlAction('ban');
            }
            break;
        case 'o':
            { const img = focusedCardImage(); if (img) openWallhavenUrl(img.name); }
            break;
        case 'u':
            undoBan();
            break;
        case 'g':
            if (_pendingG) {
                clearTimeout(_pendingG);
                _pendingG = null;
                scrollToFirst();
            } else {
                _pendingG = setTimeout(() => {
                    _pendingG = null;
                    scrollToCurrentWallpaper();
                }, 300);
            }
            break;
        case 'G':
            if (_pendingG) { clearTimeout(_pendingG); _pendingG = null; }
            scrollToLast();
            break;
        case '1':
            setViewMode('pool');
            break;
        case '2':
            setViewMode('favorites');
            break;
        case '3':
            setViewMode('trash');
            break;
        case '/':
            e.preventDefault();
            els.searchInput.focus();
            return;
        case 'a':
            if (appState.mode === 'trash' && !appState.aiLoading) {
                fetchAISuggestions();
            }
            break;
        case 's':
            switchView(appState.view === 'settings' ? 'grid' : 'settings');
            break;
        case '[':
            if (appState.mode === 'trash') {
                appState.blocklistTab = 'recoverable';
                renderBlocklistView();
            }
            break;
        case ']':
            if (appState.mode === 'trash') {
                appState.blocklistTab = 'blocked';
                renderBlocklistView();
            }
            break;
        case 'Enter':
        case ' ':
            e.preventDefault();
            { const img = focusedCardImage(); if (img) showLightbox(img); else controlAction('next'); }
            break;
    }

    // Grid Navigation
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        navigateGrid(e.key);
    }

    // Monitor shortcuts (4-9)
    if (e.key >= '4' && e.key <= '9') {
        const idx = parseInt(e.key) - 4;
        if (appState.monitors[idx]) {
            appState.selectedMonitor = appState.monitors[idx].name;
            renderMonitors();
            refreshImages();
        }
    }
}

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

const debouncedRefreshImages = debounce(() => refreshImages(), 300);

function updateGridMetrics() {
    const cards = document.getElementsByClassName('wallpaper-card');
    if (cards.length < 2) {
        // Fallback calculation if no cards to measure
        const containerWidth = els.wallpaperGrid.clientWidth;
        // minmax(260px, 1fr) + gap 24px (approx)
        const cardWidth = 260 + 24;
        appState.gridColumns = Math.max(1, Math.floor((containerWidth + 24) / cardWidth));
        return;
    }

    const firstTop = cards[0].getBoundingClientRect().top;
    for (let i = 1; i < cards.length; i++) {
        if (cards[i].getBoundingClientRect().top > firstTop) {
            appState.gridColumns = i;
            return;
        }
    }
    appState.gridColumns = cards.length; // All in one row
}

function navigateGrid(direction) {
    const cards = document.getElementsByClassName('wallpaper-card'); // Live collection
    if (cards.length === 0) return;

    const focused = document.activeElement;
    // Check if focused element is actually a card
    let index = -1;
    if (focused && focused.classList.contains('wallpaper-card')) {
        index = Array.prototype.indexOf.call(cards, focused);
    }

    // If no card focused, start at 0
    if (index === -1) {
        cards[0].focus();
        return;
    }

    // Read actual column count from CSS grid computed style
    const gridStyle = getComputedStyle(els.wallpaperGrid);
    const cols = gridStyle.gridTemplateColumns.split(' ').length || 1;
    let nextIndex = index;

    switch(direction) {
        case 'ArrowRight': nextIndex = index + 1; break;
        case 'ArrowLeft': nextIndex = index - 1; break;
        case 'ArrowDown': nextIndex = index + cols; break;
        case 'ArrowUp': nextIndex = index - cols; break;
    }

    if (nextIndex >= 0 && nextIndex < cards.length) {
        cards[nextIndex].focus({ preventScroll: true });
        requestAnimationFrame(() => {
            cards[nextIndex].scrollIntoView({ block: 'nearest', behavior: 'auto' });
        });
    }
}

// --- Navigation ---

function switchView(view) {
    appState.view = view;

    if (view === 'grid') {
        els.wallpaperGrid.classList.remove('hidden');
        els.settingsView.classList.add('hidden');
        els.btnSettings.classList.remove('active');
        // Restore active state of pool/favs
        updateUI();
    } else if (view === 'settings') {
        els.wallpaperGrid.classList.add('hidden');
        els.settingsView.classList.remove('hidden');
        els.btnSettings.classList.add('active');

        // Populate settings form
        populateSettingsForm();
    }
}

// --- Settings Logic ---

function populateSettingsForm() {
    if (!appState.config) return;
    const c = appState.config;
    const w = c.wallhaven;

    // General
    document.getElementById('input-interval').value = c.interval_min ?? 5;
    document.getElementById('input-quota').value = c.quota_mb;

    // Wallhaven
    document.getElementById('input-categories').value = w.categories;
    document.getElementById('input-top-range').value = w.top_range;
    document.getElementById('input-sorting').value = w.sorting;
    document.getElementById('input-ai-art').value = w.ai_art_filter;
    document.getElementById('input-min-favorites').value = w.min_favorites ?? 0;

    // Exclude tags & combos
    renderExcludeTags(w.exclude_tags || []);
    renderExcludeCombos(w.exclude_combos || []);
    renderExcludeUploaders(w.exclude_uploaders || []);

    // Network
    document.getElementById('input-proxy').value = c.proxy || '';

    // Pause on lock
    document.getElementById('input-pause-on-lock').checked = c.pause_on_lock !== false;

    // Safe mode
    document.getElementById('input-safe-mode').checked = !!c.safe_mode;

    // API key — show masked placeholder if set, empty if not
    const apiKeyInput = document.getElementById('input-api-key');
    apiKeyInput.value = '';
    apiKeyInput.placeholder = c.has_api_key ? '••••••••••••••••' : 'Your Wallhaven API key';

    // Wallhaven account
    document.getElementById('input-wh-username').value = c.wallhaven_username || '';
    const whPwdInput = document.getElementById('input-wh-password');
    whPwdInput.value = '';
    whPwdInput.placeholder = c.has_wh_password ? '••••••••••••••••' : 'Password';

    // Blacklist TTL
    const ttlInput = document.getElementById('input-blacklist-ttl');
    const neverCheckbox = document.getElementById('input-blacklist-never');
    if (ttlInput) {
        ttlInput.value = c.blacklist_ttl_days === 0 ? '' : (c.blacklist_ttl_days || 30);
        neverCheckbox.checked = c.blacklist_ttl_days === 0;
        ttlInput.disabled = c.blacklist_ttl_days === 0;
        neverCheckbox.onchange = () => { ttlInput.disabled = neverCheckbox.checked; };
    }
}

function renderChipList(containerId, items) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    items.forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = item;
        const btn = document.createElement('button');
        btn.className = 'tag-chip-remove';
        btn.textContent = '\u00d7';
        btn.onclick = () => chip.remove();
        chip.appendChild(btn);
        container.appendChild(chip);
    });
}

function getChipList(containerId) {
    const container = document.getElementById(containerId);
    return [...container.querySelectorAll('.tag-chip')].map(c => c.textContent.slice(0, -1));
}

function addChipItem(inputId, containerId, renderFn) {
    const input = document.getElementById(inputId);
    const name = input.value.trim();
    if (!name) return;
    const existing = getChipList(containerId);
    if (existing.some(e => e.toLowerCase() === name.toLowerCase())) { input.value = ''; return; }
    renderFn([...existing, name]);
    input.value = '';
}

function renderExcludeTags(tags) { renderChipList('exclude-tags-container', tags); }
function addExcludeTag() { addChipItem('input-exclude-tag', 'exclude-tags-container', renderExcludeTags); }
function getExcludeTags() { return getChipList('exclude-tags-container'); }

function renderExcludeCombos(combos) {
    const container = document.getElementById('exclude-combos-container');
    const field = document.getElementById('exclude-combos-field');
    container.innerHTML = '';
    if (!combos.length) { field.style.display = 'none'; return; }
    field.style.display = '';
    combos.forEach(combo => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip combo-chip';
        chip.textContent = combo.join(' + ');
        const btn = document.createElement('button');
        btn.className = 'tag-chip-remove';
        btn.textContent = '\u00d7';
        btn.onclick = () => chip.remove();
        chip.appendChild(btn);
        container.appendChild(chip);
    });
}

function getExcludeCombos() {
    const container = document.getElementById('exclude-combos-container');
    return [...container.querySelectorAll('.tag-chip')].map(c => {
        const text = c.textContent.slice(0, -1); // remove × button text
        return text.split(' + ').map(t => t.trim());
    });
}

function renderExcludeUploaders(uploaders) { renderChipList('exclude-uploaders-container', uploaders); }
function addExcludeUploader() { addChipItem('input-exclude-uploader', 'exclude-uploaders-container', renderExcludeUploaders); }
function getExcludeUploaders() { return getChipList('exclude-uploaders-container'); }

function blocklistSuggestionsKey() {
    const wallhaven = appState.config?.wallhaven || {};
    const purities = [...(appState.purity || [])].map(String).sort();
    const excludeTags = (wallhaven.exclude_tags || [])
        .map(t => String(t).toLowerCase())
        .sort();
    const excludeCombos = (wallhaven.exclude_combos || [])
        .map(combo => JSON.stringify(
            (Array.isArray(combo) ? combo : []).map(t => String(t).toLowerCase()).sort()
        ))
        .sort();
    return JSON.stringify({ purities, excludeTags, excludeCombos });
}

function blocklistSuggestionsAreCurrent() {
    return appState.tagSuggestionsKey !== null
        && appState.tagSuggestionsKey === blocklistSuggestionsKey();
}

function invalidateBlocklistSuggestions() {
    appState.tagSuggestionsKey = null;
    appState.tagSuggestionsGeneration++;
    renderBlocklistSuggestionsBar();
}

async function fetchTagSuggestions({ render = false, requestId = null } = {}) {
    const suggestionsKey = blocklistSuggestionsKey();
    const generation = appState.tagSuggestionsGeneration;
    try {
        const data = await WayperApi.tagSuggestions();
        if (
            generation !== appState.tagSuggestionsGeneration
            || suggestionsKey !== blocklistSuggestionsKey()
        ) {
            return false;
        }
        appState.tagSuggestions = data.suggestions || [];
        appState.comboSuggestions = data.combo_suggestions || [];
        appState.tagSuggestionsKey = suggestionsKey;
        if (
            render
            && appState.mode === 'trash'
            && (requestId === null || requestId === appState.imageRequestId)
            && blocklistSuggestionsAreCurrent()
        ) {
            renderBlocklistSuggestionsBar();
        }
        return true;
    } catch (e) {
        console.error('Failed to fetch tag suggestions:', e);
        return false;
    }
}

function aiSuggestionType(suggestion) {
    return WayperExclusionRules.suggestionType(suggestion);
}

function syncAISuggestionAppliedState() {
    WayperExclusionRules.syncAISuggestionAppliedState(appState.aiSuggestions, appState.config);
}

function recordAISuggestionFeedback(tags, action) {
    WayperApi.aiSuggestionFeedback(tags, action)
        .catch(e => console.error('Failed to record AI feedback:', e));
}

function markMatchingAISuggestionsApplied(tags, type, action) {
    const feedbackAction = action === 'add' ? 'applied_add' : 'applied_remove';
    const matches = WayperExclusionRules.matchingAISuggestions(appState.aiSuggestions, tags, type, action);
    for (const s of matches) {
        s._applied = true;
        if (s._feedbackAction !== feedbackAction) {
            s._feedbackAction = feedbackAction;
            recordAISuggestionFeedback(s.tags, feedbackAction);
        }
    }
}

function buildExclusionUpdate(type, tags, action, options = {}) {
    const wh = appState.config.wallhaven;
    const tagList = [...tags];
    const removeLower = WayperExclusionRules.lowerRuleSet(tagList);

    if (action === 'add') {
        if (type === 'uploader') {
            return { exclude_uploaders: [...(wh.exclude_uploaders || []), ...tagList] };
        }
        if (type === 'combo') {
            let combos = [...(wh.exclude_combos || [])];
            if (options.dropComboSupersets) {
                combos = combos.filter(existing => {
                    const existingLower = WayperExclusionRules.lowerRuleSet(existing);
                    return !(existingLower.size > removeLower.size
                        && [...removeLower].every(t => existingLower.has(t)));
                });
            }
            return { exclude_combos: [...combos, tagList] };
        }
        return { exclude_tags: [...(wh.exclude_tags || []), ...tagList] };
    }

    if (type === 'uploader') {
        return {
            exclude_uploaders: (wh.exclude_uploaders || []).filter(
                t => !removeLower.has(t.toLowerCase())
            ),
        };
    }
    if (type === 'combo') {
        return {
            exclude_combos: (wh.exclude_combos || []).filter(
                existing => !WayperExclusionRules.sameRuleSet(existing, tagList)
            ),
        };
    }
    return {
        exclude_tags: (wh.exclude_tags || []).filter(
            t => !removeLower.has(t.toLowerCase())
        ),
    };
}

async function applyExclusionUpdate({ type, tags, action = 'add', refreshSuggestions = false, render = true, ...options }) {
    const update = buildExclusionUpdate(type, tags, action, options);
    await WayperApi.patchConfig({ wallhaven: update });
    invalidateBlocklistSuggestions();
    markMatchingAISuggestionsApplied(tags, type, action);
    await fetchConfig();
    if (refreshSuggestions) await fetchTagSuggestions();
    if (render) renderBlocklistView();
}

async function applySearchResults(query, matches) {
    const requestId = ++appState.searchRequestId;
    appState.searchQuery = query;
    appState.searchMatches = new Set(matches || []);
    els.searchInput.value = query;
    els.searchClear.classList.remove('hidden');
    document.querySelector('.search-kbd')?.classList.add('hidden');
    els.searchDropdown.classList.add('hidden');
    await applySearchFilter(false, requestId);
    if (requestId !== appState.searchRequestId) return;
    updateSearchCount();
}

async function searchByTags(tagList) {
    // Use exact tag intersection search instead of text search
    const res = await fetch(`${API_URL}/api/search?tags=${encodeURIComponent(tagList.join(','))}`);
    if (!res.ok) return;
    const data = await res.json();
    console.log('[searchByTags]', tagList, '→', data.matches?.length, 'matches, allImages:', appState.allImages.length);
    await applySearchResults(tagList.join(' + '), data.matches);
}

async function searchByUploader(name) {
    const res = await fetch(`${API_URL}/api/search?uploader=${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const data = await res.json();
    console.log('[searchByUploader]', name, '→', data.matches?.length, 'matches');
    await applySearchResults(name, data.matches);
}

async function exitComboLevel() {
    els.searchInput.blur();
    if (appState.comboContext.length > 1) {
        // Pop one level — if going back to single tag, use text search for consistency
        appState.comboContext.pop();
        const ctx = appState.comboContext;
        // Restore reviewingTag to match the parent level
        if (ctx.length === 1) {
            const original = appState.tagSuggestions?.find(s => s.tag === ctx[0]);
            if (original) appState.reviewingTag = original;
        }
        navigateCombo(ctx).then(() => els.searchDropdown.classList.add('hidden'));
    } else {
        appState.reviewingTag = null;
        appState.comboContext = [];
        appState.comboRefinements = [];
        await clearSearch();
    }
}

async function navigateCombo(ctx) {
    await Promise.all([searchByTags(ctx), fetchComboRefinements(ctx)]);
    appState.reviewingTag = { ...appState.reviewingTag, count: appState.images.length };
    renderBlocklistView();
}

async function fetchComboRefinements(contextTags) {
    try {
        const data = await WayperApi.tagSuggestions(contextTags);
        appState.comboRefinements = data.suggestions || [];
    } catch (e) {
        console.error('Failed to fetch combo refinements:', e);
        appState.comboRefinements = [];
    }
}

async function fetchAISuggestions() {
    appState.aiLoading = true;
    appState.aiStartTime = Date.now();
    appState.aiSuggestions = null;
    renderBlocklistView();
    appState.aiTimer = setInterval(async () => {
        const txt = document.querySelector('.agent-btn-text');
        if (!txt || !appState.aiStartTime) return;
        const elapsed = Math.floor((Date.now() - appState.aiStartTime) / 1000);
        try {
            const status = await WayperApi.aiSuggestionStatus();
            if (status.phase === 'preparing') {
                txt.textContent = status.detail || 'Preparing\u2026';
            } else if (status.phase === 'analyzing') {
                txt.textContent = (status.detail ? status.detail + ' · ' : '') + elapsed + 's';
            } else {
                txt.textContent = elapsed + 's';
            }
        } catch {
            txt.textContent = elapsed + 's';
        }
    }, 1000);
    try {
        appState.aiSuggestions = await WayperApi.aiSuggestions();
    } catch (e) {
        appState.aiSuggestions = { error: `Connection error: ${e.message}` };
    } finally {
        clearInterval(appState.aiTimer);
        appState.aiTimer = null;
        appState.aiLoading = false;
        appState.aiStartTime = null;
        syncAISuggestionAppliedState();
        renderBlocklistView();
    }
}

async function applyAISuggestion(suggestion, action) {
    const type = aiSuggestionType(suggestion);
    await applyExclusionUpdate({ type, tags: suggestion.tags, action });
}

async function saveSettings() {
    const updates = {
        interval_min: parseInt(document.getElementById('input-interval').value) || 0,
        quota_mb: parseInt(document.getElementById('input-quota').value) || 4000,
        proxy: document.getElementById('input-proxy').value,
        pause_on_lock: document.getElementById('input-pause-on-lock').checked,
        safe_mode: document.getElementById('input-safe-mode').checked,
    };

    // Only send credentials if user entered a new value
    const apiKeyVal = document.getElementById('input-api-key').value;
    if (apiKeyVal) updates.api_key = apiKeyVal;

    const whUsername = document.getElementById('input-wh-username').value.trim();
    updates.wallhaven_username = whUsername;
    const whPwdVal = document.getElementById('input-wh-password').value;
    if (whPwdVal) updates.wallhaven_password = whPwdVal;

    // Blacklist TTL: 0 = never expire
    const neverExpire = document.getElementById('input-blacklist-never')?.checked;
    if (neverExpire) {
        updates.blacklist_ttl_days = 0;
    } else {
        updates.blacklist_ttl_days = parseInt(document.getElementById('input-blacklist-ttl').value) || 30;
    }

    updates.wallhaven = {
        categories: document.getElementById('input-categories').value,
        top_range: document.getElementById('input-top-range').value,
        sorting: document.getElementById('input-sorting').value,
        ai_art_filter: parseInt(document.getElementById('input-ai-art').value),
        min_favorites: Math.max(0, parseInt(document.getElementById('input-min-favorites').value) || 0),
        exclude_tags: getExcludeTags(),
        exclude_combos: getExcludeCombos(),
        exclude_uploaders: getExcludeUploaders()
    };

    // Calculate interval in seconds for backend if needed
    updates.interval = updates.interval_min * 60;

    els.btnSaveSettings.innerText = 'Saving...';
    try {
        await WayperApi.patchConfig(updates);

        await fetchConfig(); // Reload config
        invalidateBlocklistSuggestions();
        switchView('grid');
    } catch (e) {
        console.error("Failed to save settings", e);
        alert('Failed to save settings');
    } finally {
        els.btnSaveSettings.innerText = 'Save Changes';
    }
}

// --- Actions ---

async function controlAction(action) {
    try {
        const res = await fetch(`${API_URL}/api/control/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monitor_name: appState.selectedMonitor })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        applyMonitorCurrentImage(data.monitor || appState.selectedMonitor, data.current_image);
    } catch (e) {
        console.error(`Action ${action} failed:`, e);
    }
}

async function setViewMode(mode) {
    appState.mode = mode;
    switchView('grid'); // Ensure we are in grid view
    updateUI();
    debouncedRefreshImages();
}

function shakeButton(btn) {
    btn.classList.remove('shake');
    void btn.offsetWidth;
    btn.classList.add('shake');
}

let _purityHintTimer;
function showPurityHint(btn, message) {
    shakeButton(btn);
    const container = btn.closest('.purity-toggles');
    let hint = container.parentElement.querySelector('.purity-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'purity-hint';
        container.after(hint);
    }
    hint.textContent = message;
    hint.classList.add('visible');
    clearTimeout(_purityHintTimer);
    _purityHintTimer = setTimeout(() => hint.classList.remove('visible'), 2000);
}

function toggleSinglePurity(purity) {
    if (appState.safeMode && purity !== 'sfw') {
        const btn = purity === 'nsfw' ? els.btnPurityNsfw : els.btnPuritySketchy;
        showPurityHint(btn, 'Safe mode is enabled');
        return;
    }
    if (purity === 'nsfw' && !appState.purity.includes('nsfw') && !appState.hasApiKey) {
        showPurityHint(els.btnPurityNsfw, 'API key required for NSFW');
        return;
    }
    const current = appState.purity;
    if (current.includes(purity)) {
        if (current.length <= 1) return;
        setPurities(current.filter(p => p !== purity));
    } else {
        setPurities([...current, purity]);
    }
}

async function setPurities(purities) {
    appState.purity = purities;
    invalidateBlocklistSuggestions();

    try {
        await fetch(`${API_URL}/api/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purities })
        });
    } catch (e) {
        console.error("Failed to set purities", e);
    }

    updateUI();
    debouncedRefreshImages();
    fetchStatus();
}

async function ensureDaemon() {
    try {
        await fetch(`${API_URL}/api/daemon/start`, { method: 'POST' });
    } catch (e) {
        console.error("Auto-start daemon failed", e);
    }
}

async function toggleDaemon() {
    const action = appState.status.running ? 'stop' : 'start';
    els.btnDaemon.innerText = action === 'start' ? 'Starting...' : 'Stopping...';
    els.btnDaemon.disabled = true;

    try {
        await fetch(`${API_URL}/api/daemon/${action}`, { method: 'POST' });
    } catch (e) {
        console.error("Daemon toggle failed", e);
    }

    // Poll until state changes or timeout (5s)
    const wantRunning = action === 'start';
    for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await fetchStatus();
        if (appState.status.running === wantRunning) break;
    }
    els.btnDaemon.disabled = false;
    updateStatusUI();
}

async function setWallpaper(path) {
    if (!appState.selectedMonitor) return;

    // Optimistic UI update
    const card = document.querySelector(`[data-path="${path}"]`);
    if (card) card.classList.add('setting');

    try {
        applyMonitorCurrentImage(appState.selectedMonitor, path);
        const res = await fetch(`${API_URL}/api/wallpaper/set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                monitor: appState.selectedMonitor,
                image_path: path
            })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        applyMonitorCurrentImage(data.monitor || appState.selectedMonitor, data.current_image || path);

        if (card) card.classList.remove('setting');
    } catch (e) {
        console.error("Set wallpaper failed", e);
        fetchMonitors();
        if (card) card.classList.remove('setting');
    }
}

async function toggleFavoriteImage(path) {
    invalidateBlocklistSuggestions();
    removeImageFromState(path);
    // Update local counts so fetchStatus won't detect a "change" and trigger full refresh
    if (appState.status) {
        if (appState.mode === 'favorites') {
            appState.status.favorites_count--;
            appState.status.pool_count++;
        } else {
            appState.status.pool_count--;
            appState.status.favorites_count++;
        }
        updateStatusUI();
    }
    try {
        await fetch(`${API_URL}/api/image/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: path })
        });
    } catch (e) {
        console.error("Favorite toggle failed", e);
        refreshImages();
    }
}

async function banImage(path) {
    invalidateBlocklistSuggestions();
    removeImageFromState(path);
    // Update local counts so fetchStatus won't detect a "change" and trigger full refresh
    if (appState.status) {
        if (appState.mode === 'favorites') appState.status.favorites_count--;
        else if (appState.mode === 'trash') appState.status.pool_count--;
        else appState.status.pool_count--;
        appState.status.blocklist_count++;
        updateStatusUI();
    }
    try {
        const res = await fetch(`${API_URL}/api/image/ban`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: path })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        applyMonitorCurrentImages(data.replacement_images);
    } catch (e) {
        console.error("Ban failed", e);
        refreshImages();
    }
}

async function undoBan() {
    try {
        await controlAction('unban');
        // Refresh grid to show restored image
        refreshImages();
    } catch (e) {
        console.error("Undo failed", e);
    }
}

// --- Search ---

let searchDebounceTimer = null;
let searchHighlightIndex = -1;
let searchAbortController = null;

function onSearchInput() {
    const query = els.searchInput.value.trim();
    clearTimeout(searchDebounceTimer);

    if (!query) {
        clearSearch();
        return;
    }

    els.searchClear.classList.remove('hidden');
    document.querySelector('.search-kbd')?.classList.add('hidden');

    searchDebounceTimer = setTimeout(() => performSearch(query), 200);
}

async function performSearch(query) {
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();
    const requestId = ++appState.searchRequestId;

    appState.searchQuery = query;
    try {
        const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}`, { signal: searchAbortController.signal });
        if (!res.ok) {
            console.error('[search] API error:', res.status);
            return;
        }
        const data = await res.json();
        console.log('[search]', query, '→', data.matches?.length, 'matches, allImages:', appState.allImages.length);
        if (requestId !== appState.searchRequestId) return;
        appState.searchMatches = new Set(data.matches || []);
        renderSearchSuggestions(data.suggestions || [], data.uploader_suggestions || []);
        await applySearchFilter(false, requestId);
        if (requestId !== appState.searchRequestId) return;
        updateSearchCount();
    } catch (e) {
        if (e.name !== 'AbortError') console.error('Search failed:', e);
    }
}

async function clearSearch() {
    appState.searchRequestId++;
    if (searchAbortController) searchAbortController.abort();
    clearTimeout(searchDebounceTimer);
    els.searchInput.value = '';
    appState.searchQuery = '';
    appState.searchMatches = null;
    appState.reviewingTag = null;
    appState.reviewingUploader = null;
    appState.comboContext = [];
    appState.comboRefinements = [];
    searchHighlightIndex = -1;
    els.searchCount.classList.add('hidden');
    els.searchClear.classList.add('hidden');
    els.searchDropdown.classList.add('hidden');
    document.querySelector('.search-kbd')?.classList.remove('hidden');
    await applySearchFilter();
}

function updateSearchCount() {
    if (!appState.searchMatches) {
        els.searchCount.classList.add('hidden');
        return;
    }
    let count = appState.images.length;
    // In trash mode, include non-recoverable blocked matches too
    if (appState.mode === 'trash' && appState.blocklistData) {
        const blockedOnly = appState.blocklistData.entries.filter(
            e => !e.recoverable && appState.searchMatches.has(e.filename)
        ).length;
        count += blockedOnly;
    }
    els.searchCount.textContent = `${count}`;
    els.searchCount.classList.remove('hidden');
}

async function ensureAllImagesLoaded(searchRequestId) {
    while (!appState.imagesComplete) {
        if (searchRequestId !== undefined && searchRequestId !== appState.searchRequestId) return false;
        const loaded = await loadMoreImages({ render: false });
        if (searchRequestId !== undefined && searchRequestId !== appState.searchRequestId) return false;
        if (!loaded) break;
    }
    return true;
}

async function applySearchFilter(preserveFocus = false, searchRequestId) {
    if (appState.searchMatches && !appState.imagesComplete) {
        const completed = await ensureAllImagesLoaded(searchRequestId);
        if (!completed) return;
    }

    if (appState.searchMatches) {
        appState.images = appState.allImages.filter(img => appState.searchMatches.has(img.name));
        console.log('[filter]', appState.allImages.length, '→', appState.images.length, 'images (mode:', appState.mode + ')');
    } else {
        appState.images = [...appState.allImages];
    }

    if (!preserveFocus) {
        els.mainContent.scrollTop = 0;
        renderImages();
        return;
    }

    // --- Diff-based update: only add/remove changed cards, never touch existing ones ---

    const existingCards = new Map();
    for (const card of [...els.wallpaperGrid.querySelectorAll('.wallpaper-card')]) {
        existingCards.set(card.dataset.path, card);
    }

    // First render — nothing to diff against
    if (existingCards.size === 0) {
        renderImages();
        return;
    }

    const newPaths = new Set(appState.images.map(img => img.path));

    // Remove cards for images no longer present (animated)
    for (const [path, card] of existingCards) {
        if (!newPaths.has(path)) {
            if (document.activeElement === card) {
                const neighbor = card.nextElementSibling?.classList?.contains('wallpaper-card')
                    ? card.nextElementSibling
                    : card.previousElementSibling?.classList?.contains('wallpaper-card')
                        ? card.previousElementSibling : null;
                if (neighbor) neighbor.focus({ preventScroll: true });
            }
            card.classList.add('removing');
            card.addEventListener('animationend', () => card.remove(), { once: true });
            existingCards.delete(path);
        }
    }

    // Insert new cards at correct positions in the new order
    const renderUpTo = Math.min(
        Math.max(appState.currentBatchIndex, existingCards.size),
        appState.images.length,
    );

    if (sentinel.parentNode) sentinel.remove();

    let ref = els.wallpaperGrid.firstElementChild;
    while (ref && !ref.classList?.contains('wallpaper-card')) ref = ref.nextElementSibling;
    for (let i = 0; i < renderUpTo; i++) {
        const img = appState.images[i];
        if (existingCards.has(img.path)) {
            // Card exists — advance ref pointer if it matches
            if (ref?.dataset?.path === img.path) {
                ref = ref.nextElementSibling;
                while (ref && !ref.classList?.contains('wallpaper-card')) ref = ref.nextElementSibling;
            }
        } else {
            // New image — insert at this position
            const card = createCard(img);
            if (ref) {
                els.wallpaperGrid.insertBefore(card, ref);
            } else {
                els.wallpaperGrid.appendChild(card);
            }
        }
    }

    appState.currentBatchIndex = renderUpTo;

    if (appState.currentBatchIndex < appState.images.length || (!appState.searchMatches && !appState.imagesComplete)) {
        els.wallpaperGrid.appendChild(sentinel);
        observer.observe(sentinel);
    } else {
        observer.unobserve(sentinel);
    }

    if (!document.querySelector('.wallpaper-card.current')) markCurrentWallpaper();
    setTimeout(updateGridMetrics, 100);
}

async function enterTagReview(tags) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    appState.reviewingTag = { tag: tagList.join(' + '), count: 0 };
    appState.comboContext = tagList;
    await Promise.all([searchByTags(tagList), fetchComboRefinements(tagList)]);
    appState.reviewingTag.count = appState.images.length;
    renderBlocklistView();
}

async function enterUploaderReview(name) {
    appState.reviewingUploader = name;
    await searchByUploader(name);
    renderBlocklistView();
}

function selectSearchTag(tag, type) {
    if (type === 'uploader') {
        if (appState.mode === 'trash') {
            enterUploaderReview(tag);
        } else {
            searchByUploader(tag);
        }
    } else if (appState.mode === 'trash') {
        enterTagReview(tag);
    } else {
        els.searchInput.value = tag;
        performSearch(tag);
    }
}

function renderSearchSuggestions(suggestions, uploaderSuggestions = []) {
    searchHighlightIndex = -1;
    if (!suggestions.length && !uploaderSuggestions.length) {
        els.searchDropdown.classList.add('hidden');
        return;
    }

    let idx = 0;
    let html = '';
    html += uploaderSuggestions.map(u =>
        `<div class="search-dropdown-item" data-index="${idx++}" data-type="uploader" data-value="${esc(u)}"><span class="search-type-badge uploader">uploader</span>${esc(u)}</div>`
    ).join('');
    html += suggestions.map(tag =>
        `<div class="search-dropdown-item" data-index="${idx++}" data-value="${esc(tag)}"><span class="search-type-badge tag">tag</span>${esc(tag)}</div>`
    ).join('');
    els.searchDropdown.innerHTML = html;
    els.searchDropdown.classList.remove('hidden');

    els.searchDropdown.querySelectorAll('.search-dropdown-item').forEach(item => {
        item.onmousedown = (e) => {
            e.preventDefault(); // Prevent blur
            els.searchDropdown.classList.add('hidden');
            const text = item.dataset.value;
            selectSearchTag(text, item.dataset.type);
        };
    });
}

function handleSearchKeydown(e) {
    const items = els.searchDropdown.querySelectorAll('.search-dropdown-item');

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        appState.reviewingTag = null;
        clearSearch();
        els.searchInput.blur();
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length) {
            searchHighlightIndex = Math.min(searchHighlightIndex + 1, items.length - 1);
            updateDropdownHighlight(items);
        }
        return;
    }

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
            searchHighlightIndex = Math.max(searchHighlightIndex - 1, -1);
            updateDropdownHighlight(items);
        }
        return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        let tag = null;
        let type;
        if (searchHighlightIndex >= 0 && items[searchHighlightIndex]) {
            tag = items[searchHighlightIndex].dataset.value;
            type = items[searchHighlightIndex].dataset.type;
        } else {
            tag = els.searchInput.value.trim() || null;
        }
        els.searchDropdown.classList.add('hidden');
        if (tag) selectSearchTag(tag, type);
        return;
    }
}

function updateDropdownHighlight(items) {
    items.forEach((item, i) => {
        item.classList.toggle('highlighted', i === searchHighlightIndex);
    });
}

async function fetchBlocklist() {
    try {
        const res = await fetch(`${API_URL}/api/blocklist`);
        appState.blocklistData = await res.json();
        return appState.blocklistData;
    } catch (e) {
        console.error("Failed to fetch blocklist", e);
        appState.blocklistData = { entries: [], total: 0, recoverable_count: 0, images: [] };
        return appState.blocklistData;
    }
}

async function unblockImage(filename) {
    invalidateBlocklistSuggestions();
    try {
        await fetch(`${API_URL}/api/blocklist/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        // Remove from local state
        if (appState.blocklistData) {
            appState.blocklistData.entries = appState.blocklistData.entries.filter(e => e.filename !== filename);
            appState.blocklistData.total--;
        }
        renderBlocklistView();
        if (appState.status) {
            appState.status.blocklist_count--;
            updateStatusUI();
        }
    } catch (e) {
        console.error("Unblock failed", e);
    }
}

async function restoreImage(path) {
    invalidateBlocklistSuggestions();
    removeImageFromState(path);
    // Update local counts so fetchStatus won't detect a "change" and trigger full refresh
    if (appState.status) {
        appState.status.pool_count++;
        appState.status.blocklist_count--;
        updateStatusUI();
    }
    try {
        await fetch(`${API_URL}/api/image/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: path })
        });
    } catch (e) {
        console.error("Restore failed", e);
        refreshImages();
    }
}

function removeImageFromState(path) {
    // Also remove from allImages (unfiltered list)
    const allIdx = appState.allImages.findIndex(img => img.path === path);
    if (allIdx !== -1) appState.allImages.splice(allIdx, 1);

    const idx = appState.images.findIndex(img => img.path === path);
    if (idx !== -1) {
        appState.images.splice(idx, 1);
        // If we removed an item before the current batch index, shift the index back
        if (idx < appState.currentBatchIndex) {
            appState.currentBatchIndex--;
        }
    }

    const card = document.querySelector(`.wallpaper-card[data-path="${path}"]`);
    if (card) {
        // Preserve focus — preventScroll avoids the browser jumping to make the
        // newly focused card fully visible (especially noticeable with tall portrait cards)
        if (document.activeElement === card) {
            const next = card.nextElementSibling;
            const prev = card.previousElementSibling;
            if (next && next.classList.contains('wallpaper-card')) {
                next.focus({ preventScroll: true });
            } else if (prev && prev.classList.contains('wallpaper-card')) {
                prev.focus({ preventScroll: true });
            }
        }
        card.remove();
    }

    if (appState.images.length === 0) {
        renderImages(); // Show empty state
    }
}

// --- Data Fetching ---

async function fetchConfig() {
    try {
        const data = await WayperApi.config();
        appState.config = data;
        appState.hasApiKey = !!data.has_api_key;
        appState.safeMode = !!data.safe_mode;

        // data.mode is now an array of purities
        appState.purity = Array.isArray(data.mode) ? data.mode : [data.mode];

        if (appState.safeMode) {
            appState.purity = ['sfw'];
            els.btnPuritySketchy.classList.add('purity-disabled');
            els.btnPurityNsfw.classList.add('purity-disabled');
        } else {
            els.btnPuritySketchy.classList.remove('purity-disabled');
            els.btnPurityNsfw.classList.toggle('purity-disabled', !appState.hasApiKey);
        }

        syncAISuggestionAppliedState();
        updateUI();
    } catch (e) { console.error(e); }
}

function activePurityParam(purities = appState.purity) {
    return encodeURIComponent(purities.join(','));
}

function imagePageUrl(offset = 0, { mode = appState.mode, purities = appState.purity, orient = appState.currentOrient } = {}) {
    return `${API_URL}/api/images/page?mode=${mode}&purity=${activePurityParam(purities)}&orient=${orient}&offset=${offset}&limit=${appState.pageSize}`;
}

function resetImagePaging() {
    appState.allImages = [];
    appState.images = [];
    appState.totalImages = 0;
    appState.nextOffset = null;
    appState.imagesComplete = false;
    appState.loadingMoreImages = false;
    appState.currentBatchIndex = 0;
}

async function loadMoreImages({ render = true } = {}) {
    if (appState.loadingMoreImages || appState.imagesComplete) {
        return false;
    }

    appState.loadingMoreImages = true;
    const requestId = appState.imageRequestId;
    const offset = appState.nextOffset ?? appState.allImages.length;
    const mode = appState.mode;
    const purities = [...appState.purity];
    const orient = appState.currentOrient;

    try {
        const res = await fetch(imagePageUrl(offset, { mode, purities, orient }));
        if (!res.ok || requestId !== appState.imageRequestId) return false;
        const data = await res.json();
        const items = data.items || [];
        appState.totalImages = data.total ?? (offset + items.length);
        appState.nextOffset = data.next_offset;
        appState.imagesComplete = data.next_offset === null
            || data.next_offset === undefined
            || items.length === 0;
        appState.allImages.push(...items);

        if (!appState.searchMatches) {
            appState.images.push(...items);
            if (render) renderNextBatch();
        }
        return items.length > 0;
    } catch (e) {
        console.error('Load more images failed:', e);
        return false;
    } finally {
        if (requestId === appState.imageRequestId) {
            appState.loadingMoreImages = false;
        }
    }
}

function connectSSE() {
    const es = new EventSource(`${API_URL}/api/events`);
    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'mode' && data.purities) {
                const newPurities = data.purities;
                if (JSON.stringify(newPurities.sort()) !== JSON.stringify([...appState.purity].sort())) {
                    console.log(`SSE purity change: ${appState.purity} -> ${newPurities}`);
                    appState.purity = newPurities;
                    updateUI();
                    refreshImages();
                    fetchStatus();
                }
            } else if (data.type === 'wallpaper') {
                fetchMonitors();
            }
        } catch (err) {
            console.error('SSE parse error', err);
        }
    };
    es.onerror = () => {};
}

async function fetchStatus() {
    try {
        const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
        const orient = monitor ? monitor.orientation : '';
        const res = await fetch(`${API_URL}/api/status?orient=${orient}&include_recoverable=false`);
        if (!res.ok) return;
        const data = await res.json();

        // Check for external mode change (e.g. via CLI)
        const newMode = Array.isArray(data.mode) ? data.mode : [data.mode];
        if (JSON.stringify(newMode.sort()) !== JSON.stringify([...appState.purity].sort())) {
            console.log(`Mode changed externally: ${appState.purity} -> ${newMode}`);
            appState.purity = newMode;
            updateUI();
            refreshImages();
        }

        // Only update DOM if data actually changed
        const prev = appState.status;
        const changed = !prev
            || data.running !== prev.running
            || data.pool_count !== prev.pool_count
            || data.favorites_count !== prev.favorites_count
            || data.blocklist_count !== prev.blocklist_count;

        appState.status = data;
        if (appState.mode === 'trash' && appState.blocklistData) {
            appState.status.recoverable_count = appState.blocklistData.recoverable_count || 0;
        }
        updateStatusUI();
        if (changed) {
            console.log('[status] counts changed pool:', prev?.pool_count, '→', data.pool_count,
                'fav:', prev?.favorites_count, '→', data.favorites_count);
            // Refresh grid when current mode's count changes externally
            if (prev && !appState.refreshing) {
                const countKey = appState.mode === 'favorites' ? 'favorites_count'
                    : appState.mode === 'trash' ? 'blocklist_count' : 'pool_count';
                if (data[countKey] !== prev[countKey]) {
                    console.log('[status] triggering refreshImages for', countKey);
                    refreshImages(true);
                }
            }
        }
    } catch (e) {
        if (appState.status.running !== false) {
            appState.status = { running: false };
            updateStatusUI();
        }
    }
}

async function fetchDiskUsage() {
    try {
        const res = await fetch(`${API_URL}/api/disk`);
        const data = await res.json();
        const text = `${data.used_mb} / ${data.quota_mb} MB`;
        if (els.diskUsage.innerText !== text) {
            els.diskUsage.innerText = text;
        }
    } catch (e) { }
}

async function fetchMonitors() {
    try {
        const res = await fetch(`${API_URL}/api/monitors`);
        appState.monitors = await res.json();

        // Select first monitor if none selected
        if (!appState.selectedMonitor && appState.monitors.length > 0) {
            appState.selectedMonitor = appState.monitors[0].name;
        }

        renderMonitors();
        markCurrentWallpaper();
    } catch (e) { console.error(e); }
}

async function refreshImages(preserveFocus = false) {
    if (!appState.selectedMonitor) return;

    appState.refreshing = true;
    const requestId = ++appState.imageRequestId;
    const renderedTarget = preserveFocus ? appState.currentBatchIndex : 0;
    const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
    const orient = monitor ? monitor.orientation : 'landscape';
    appState.currentOrient = orient;
    console.log('[refresh] start', appState.mode, orient);

    if (appState.mode === 'trash') {
        const suggestionsPromise = fetchTagSuggestions({ render: true, requestId });
        try {
            resetImagePaging();
            const [statusData, blocklistData, pageData] = await Promise.all([
                fetch(`${API_URL}/api/status?orient=${orient}&include_recoverable=false`).then(r => r.json()),
                fetchBlocklist(),
                fetch(imagePageUrl(0)).then(r => r.json()),
            ]);
            if (requestId === appState.imageRequestId) {
                appState.allImages = pageData.items || [];
                appState.totalImages = pageData.total ?? appState.allImages.length;
                appState.nextOffset = pageData.next_offset;
                appState.imagesComplete = pageData.next_offset === null || pageData.next_offset === undefined;
                statusData.recoverable_count = blocklistData.recoverable_count || 0;
                appState.status = statusData;
                updateStatusUI();
                await applySearchFilter(preserveFocus);
                renderBlocklistSuggestionsBar();
                suggestionsPromise.catch(() => {});
            }
        } catch (e) { console.error(e); }
    } else {
        try {
            resetImagePaging();
            const [statusData, pageData] = await Promise.all([
                fetch(`${API_URL}/api/status?orient=${orient}&include_recoverable=false`)
                    .then(r => r.json()),
                fetch(imagePageUrl(0)).then(r => r.json()),
            ]);
            if (requestId === appState.imageRequestId) {
                appState.allImages = pageData.items || [];
                appState.totalImages = pageData.total ?? appState.allImages.length;
                appState.nextOffset = pageData.next_offset;
                appState.imagesComplete = pageData.next_offset === null || pageData.next_offset === undefined;
                appState.status = statusData;
                while (
                    preserveFocus
                    && appState.allImages.length < renderedTarget
                    && !appState.imagesComplete
                ) {
                    const loaded = await loadMoreImages({ render: false });
                    if (!loaded || requestId !== appState.imageRequestId) break;
                }
                console.log('[refresh] done', appState.mode, orient,
                    'pool:', statusData.pool_count, 'fav:', statusData.favorites_count);
                updateStatusUI();
                await applySearchFilter(preserveFocus);
            }
        } catch (e) { console.error(e); }
    }
    if (requestId === appState.imageRequestId) {
        appState.refreshing = false;
    }
}

// --- Rendering ---

function updateUI() {
    // Mode
    els.btnPool.classList.remove('active');
    els.btnFavorites.classList.remove('active');
    els.btnBlocklist.classList.remove('active');

    if (appState.mode === 'pool') {
        els.btnPool.classList.add('active');
    } else if (appState.mode === 'favorites') {
        els.btnFavorites.classList.add('active');
    } else if (appState.mode === 'trash') {
        els.btnBlocklist.classList.add('active');
    }

    // Purity toggles
    els.btnPuritySfw.classList.toggle('active', appState.purity.includes('sfw'));
    els.btnPuritySketchy.classList.toggle('active', appState.purity.includes('sketchy'));
    els.btnPurityNsfw.classList.toggle('active', appState.purity.includes('nsfw'));
}

function updateStatusUI() {
    const running = appState.status.running;

    // Update counts
    if (appState.status.pool_count !== undefined) {
        els.countPool.innerText = appState.status.pool_count;
    }
    if (appState.status.favorites_count !== undefined) {
        els.countFavorites.innerText = appState.status.favorites_count;
    }
    if (appState.status.blocklist_count !== undefined) {
        els.countBlocklist.innerText = appState.status.blocklist_count;
    }

    if (running) {
        els.daemonDot.classList.add('running');
        els.daemonStatus.innerText = 'Daemon Active';
        els.daemonStatus.classList.add('daemon-active');
        els.daemonStatus.classList.remove('daemon-stopped');
        els.btnDaemon.innerText = 'Stop Daemon';
        els.btnDaemon.classList.add('danger');
        els.btnDaemon.classList.remove('primary');
    } else {
        els.daemonDot.classList.remove('running');
        els.daemonStatus.innerText = 'Daemon Stopped';
        els.daemonStatus.classList.add('daemon-stopped');
        els.daemonStatus.classList.remove('daemon-active');
        els.btnDaemon.innerText = 'Start Daemon';
        els.btnDaemon.classList.remove('danger');
        els.btnDaemon.classList.add('primary'); // Encourage starting
    }
}

function markCurrentWallpaper() {
    const prev = document.querySelector('.wallpaper-card.current');
    if (prev) prev.classList.remove('current');
    const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
    if (!monitor?.current_image) return;
    const card = document.querySelector(`.wallpaper-card[data-path="${CSS.escape(monitor.current_image)}"]`);
    if (card) card.classList.add('current');
}

function scrollToFirst() {
    const cards = document.getElementsByClassName('wallpaper-card');
    if (cards.length === 0) return;
    cards[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
    cards[0].focus({ preventScroll: true });
}

function scrollToLast() {
    if (appState.images.length === 0) return;
    // Render all currently loaded cards. More pages stay lazy-loaded to avoid
    // turning a keyboard shortcut into a full-library DOM build.
    if (appState.currentBatchIndex < appState.images.length) {
        if (sentinel.parentNode) sentinel.remove();
        const fragment = document.createDocumentFragment();
        while (appState.currentBatchIndex < appState.images.length) {
            fragment.appendChild(createCard(appState.images[appState.currentBatchIndex]));
            appState.currentBatchIndex++;
        }
        els.wallpaperGrid.appendChild(fragment);
    }
    if (!sentinel.parentNode && !appState.searchMatches && !appState.imagesComplete) {
        els.wallpaperGrid.appendChild(sentinel);
        observer.observe(sentinel);
    }
    const cards = document.getElementsByClassName('wallpaper-card');
    const last = cards[cards.length - 1];
    if (last) {
        last.scrollIntoView({ block: 'end', behavior: 'smooth' });
        last.focus({ preventScroll: true });
    }
}

async function scrollToCurrentWallpaper() {
    let card = document.querySelector('.wallpaper-card.current');
    if (!card) {
        // Card not rendered yet — find its index and render up to that batch
        const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
        if (!monitor?.current_image) return;
        while (!appState.imagesComplete && !appState.images.some(img => img.path === monitor.current_image)) {
            const loaded = await loadMoreImages({ render: false });
            if (!loaded) break;
        }
        const targetIdx = appState.images.findIndex(img => img.path === monitor.current_image);
        if (targetIdx < 0) return;
        const targetEnd = Math.min(targetIdx + appState.batchSize, appState.images.length);
        if (sentinel.parentNode) sentinel.remove();
        const fragment = document.createDocumentFragment();
        while (appState.currentBatchIndex < targetEnd && appState.currentBatchIndex < appState.images.length) {
            fragment.appendChild(createCard(appState.images[appState.currentBatchIndex]));
            appState.currentBatchIndex++;
        }
        els.wallpaperGrid.appendChild(fragment);
        if (appState.currentBatchIndex < appState.images.length || (!appState.searchMatches && !appState.imagesComplete)) {
            els.wallpaperGrid.appendChild(sentinel);
            observer.observe(sentinel);
        }
        markCurrentWallpaper();
        card = document.querySelector('.wallpaper-card.current');
    }
    if (card) {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.focus({ preventScroll: true });
    }
}

function setupInfiniteScroll() {
    sentinel = document.createElement('div');
    sentinel.className = 'scroll-sentinel';
    sentinel.style.width = '100%';
    sentinel.style.height = '100px';

    observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            renderNextBatch();
        }
    }, {
        root: null, // viewport
        rootMargin: '600px', // Load more well before reaching bottom
        threshold: 0.01
    });
}

function renderMonitors() {
    els.monitorsList.innerHTML = '';

    appState.monitors.forEach((m, index) => {
        const el = document.createElement('div');
        el.className = `monitor-item ${m.name === appState.selectedMonitor ? 'active' : ''}`;

        const isLandscape = m.orientation === 'landscape';
        const monitorIcon = isLandscape
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
        const key = index + 4;
        const shortcut = key <= 9 ? `<kbd>${key}</kbd>` : '';

        el.innerHTML = `
            <h4>${monitorIcon} ${esc(m.name)} ${shortcut}</h4>
            <p>${esc(m.orientation)} • ${m.current_image ? 'Active' : 'Empty'}</p>
        `;

        el.onclick = () => {
            console.log('[monitor] switch to', m.name, m.orientation);
            appState.selectedMonitor = m.name;
            renderMonitors();
            refreshImages();
        };

        els.monitorsList.appendChild(el);
    });
}

function renderImages() {
    console.log('[render]', appState.mode, 'images:', appState.images.length, 'search:', appState.searchQuery || '(none)');

    if (appState.mode === 'trash') {
        _trashBannerShown = false;
        renderBlocklistView();
        return;
    }

    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;
    _trashBannerShown = false;

    if (appState.images.length === 0) {
        const msg = appState.searchQuery
            ? `No matches for "${esc(appState.searchQuery)}"`
            : `No wallpapers in ${esc(appState.mode)} / ${esc(appState.purity)}`;
        els.wallpaperGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
                <p>${msg}</p>
            </div>
        `;
        return;
    }

    renderNextBatch();
    setTimeout(updateGridMetrics, 100);
}

function createBlocklistSuggestionsBar() {
    const tagSuggestions = appState.tagSuggestions || [];
    const comboSuggestions = appState.comboSuggestions || [];
    const hasSuggestions = tagSuggestions.length > 0 || comboSuggestions.length > 0;
    if (
        appState.searchQuery
        || appState.reviewingTag
        || appState.reviewingUploader
        || !blocklistSuggestionsAreCurrent()
        || !hasSuggestions
    ) {
        return null;
    }

    const bar = document.createElement('div');
    bar.className = 'tag-suggestions-bar blocklist-suggestions';
    const header = document.createElement('div');
    header.className = 'suggestion-bar-header';
    const label = document.createElement('span');
    label.className = 'suggestion-bar-label';
    label.textContent = 'Suggested exclusions';
    header.appendChild(label);

    const aiBtn = document.createElement('button');
    aiBtn.className = 'agent-analyze-btn';
    aiBtn.onclick = () => { if (!appState.aiLoading) fetchAISuggestions(); };
    if (appState.aiLoading) {
        aiBtn.disabled = true;
        aiBtn.classList.add('agent-loading');
        const elapsed = appState.aiStartTime ? Math.floor((Date.now() - appState.aiStartTime) / 1000) : 0;
        const spinner = document.createElement('span');
        spinner.className = 'agent-spinner';
        aiBtn.appendChild(spinner);
        const txt = document.createElement('span');
        txt.className = 'agent-btn-text';
        txt.textContent = `Analyzing ${elapsed}s`;
        aiBtn.appendChild(txt);
    } else {
        const icon = document.createElement('span');
        icon.className = 'agent-icon';
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M16 14H8a5 5 0 0 0-5 5v1h18v-1a5 5 0 0 0-5-5z"/></svg>';
        aiBtn.appendChild(icon);
        const btnLabel = document.createElement('span');
        btnLabel.textContent = 'Agent';
        aiBtn.appendChild(btnLabel);
        if (appState.aiSuggestions && appState.aiSuggestions.error) {
            aiBtn.classList.add('agent-error');
            aiBtn.title = appState.aiSuggestions.error;
        } else {
            const kbd = document.createElement('kbd');
            kbd.textContent = 'A';
            aiBtn.appendChild(kbd);
        }
    }
    header.appendChild(aiBtn);
    bar.appendChild(header);

    for (const s of tagSuggestions) {
        const chip = document.createElement('span');
        chip.className = 'suggestion-chip';
        chip.title = `Review "${s.tag}" in blocklist`;
        chip.onclick = () => enterTagReview(s.tag);
        chip.appendChild(createTypeBadge('tag'));
        const tagLabel = document.createElement('span');
        tagLabel.className = 'suggestion-chip-name';
        tagLabel.textContent = s.tag;
        const count = document.createElement('span');
        count.className = 'suggestion-chip-count';
        count.textContent = `${s.count}`;
        chip.appendChild(tagLabel);
        chip.appendChild(count);
        bar.appendChild(chip);
    }

    for (const c of comboSuggestions) {
        const chip = document.createElement('span');
        chip.className = 'suggestion-chip combo-chip';
        chip.title = `Review combo "${c.tags.join(' + ')}" — ${Math.round(c.precision * 100)}% precision`;
        chip.onclick = () => enterTagReview([...c.tags]);
        chip.appendChild(createTypeBadge('combo'));
        const tagLabel = document.createElement('span');
        tagLabel.className = 'suggestion-chip-name';
        tagLabel.textContent = c.tags.join(' + ');
        const count = document.createElement('span');
        count.className = 'suggestion-chip-count';
        count.textContent = `${c.count}`;
        chip.appendChild(tagLabel);
        chip.appendChild(count);
        bar.appendChild(chip);
    }

    return bar;
}

function renderBlocklistSuggestionsBar() {
    const existing = els.wallpaperGrid.querySelector('.blocklist-suggestions');
    existing?.remove();

    if (appState.mode !== 'trash') return;
    const tabs = els.wallpaperGrid.querySelector('.blocklist-tabs');
    if (!tabs) return;

    const bar = createBlocklistSuggestionsBar();
    if (bar) tabs.after(bar);
}

function renderBlocklistView() {
    if (appState.mode !== 'trash') return;

    syncAISuggestionAppliedState();
    if (sentinel.parentNode) sentinel.remove();
    observer?.unobserve(sentinel);
    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;

    const bl = appState.blocklistData || { entries: [], total: 0, recoverable_count: 0, images: [] };
    const filteredEntries = appState.searchMatches
        ? bl.entries.filter(e => appState.searchMatches.has(e.filename))
        : bl.entries;
    const recoverableCount = appState.images.length;
    const blockedCount = filteredEntries.length;

    // Auto-switch tab when search has results only in the other tab.
    // Skip during tag/uploader review (user clicked an agent suggestion to explore
    // a category — switching tabs would be jarring and unrelated to their intent).
    if (appState.searchMatches && !appState.reviewingTag && !appState.reviewingUploader) {
        if (appState.blocklistTab === 'recoverable' && recoverableCount === 0 && blockedCount > 0) {
            appState.blocklistTab = 'blocked';
        } else if (appState.blocklistTab === 'blocked' && blockedCount === 0 && recoverableCount > 0) {
            appState.blocklistTab = 'recoverable';
        }
    }

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'blocklist-tabs';

    const tabRecoverable = document.createElement('button');
    tabRecoverable.className = `blocklist-tab ${appState.blocklistTab === 'recoverable' ? 'active' : ''}`;
    tabRecoverable.innerHTML = `Recoverable <span class="tab-count">${recoverableCount}</span><kbd>[</kbd>`;
    tabRecoverable.onclick = () => { appState.blocklistTab = 'recoverable'; renderBlocklistView(); };

    const tabBlocked = document.createElement('button');
    tabBlocked.className = `blocklist-tab ${appState.blocklistTab === 'blocked' ? 'active' : ''}`;
    tabBlocked.innerHTML = `All Blocked <span class="tab-count">${blockedCount}</span><kbd>]</kbd>`;
    tabBlocked.onclick = () => { appState.blocklistTab = 'blocked'; renderBlocklistView(); };

    tabs.appendChild(tabRecoverable);
    tabs.appendChild(tabBlocked);
    els.wallpaperGrid.appendChild(tabs);

    // Tag suggestions / review bar
    if (appState.reviewingTag) {
        // Review mode: show context bar for the tag being reviewed
        const s = appState.reviewingTag;
        const ctx = appState.comboContext;
        const isCombo = ctx.length > 1;
        const bar = document.createElement('div');
        bar.className = 'tag-review-bar';

        // Show breadcrumb for combo context — each tag is clickable to remove it
        const textSpan = document.createElement('span');
        textSpan.className = 'review-bar-text';
        ctx.forEach((t, i) => {
            if (i > 0) textSpan.appendChild(document.createTextNode(' + '));
            const tagEl = document.createElement('strong');
            tagEl.className = 'breadcrumb-tag';
            tagEl.textContent = t;
            if (ctx.length > 1) {
                tagEl.title = `Remove "${t}" from combo`;
                tagEl.onclick = async () => {
                    const newCtx = ctx.filter((_, j) => j !== i);
                    appState.comboContext = newCtx;
                    if (newCtx.length === 1) {
                        const original = appState.tagSuggestions?.find(sg => sg.tag === newCtx[0]);
                        if (original) appState.reviewingTag = original;
                    }
                    await navigateCombo(newCtx);
                };
            } else {
                tagEl.title = 'Exit review';
                tagEl.onclick = () => exitComboLevel();
            }
            textSpan.appendChild(tagEl);
        });
        const countEl = document.createElement('span');
        countEl.className = 'review-bar-count';
        countEl.textContent = `${s.count} banned`;
        textSpan.appendChild(countEl);
        bar.appendChild(textSpan);
        const actions = document.createElement('div');
        actions.className = 'review-bar-actions';

        const excludeBtn = document.createElement('button');
        excludeBtn.className = 'review-btn-exclude';
        if (isCombo) {
            excludeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Exclude combo';
            excludeBtn.onclick = async () => {
                await applyExclusionUpdate({
                    type: 'combo',
                    tags: ctx,
                    refreshSuggestions: true,
                    render: false,
                    dropComboSupersets: true,
                });
                appState.reviewingTag = null;
                appState.comboContext = [];
                appState.comboRefinements = [];
                await clearSearch();
            };
        } else {
            excludeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Exclude';
            excludeBtn.onclick = async () => {
                await applyExclusionUpdate({
                    type: 'tag',
                    tags: [s.tag],
                    refreshSuggestions: true,
                    render: false,
                });
                appState.reviewingTag = null;
                appState.comboContext = [];
                appState.comboRefinements = [];
                await clearSearch();
            };
        }

        const backBtn = document.createElement('button');
        backBtn.className = 'review-btn-back';
        backBtn.textContent = 'Back';
        backBtn.onclick = () => {
            exitComboLevel();
        };

        actions.appendChild(excludeBtn);
        actions.appendChild(backBtn);
        bar.appendChild(actions);
        els.wallpaperGrid.appendChild(bar);

        // Combo refinement chips
        if (appState.comboRefinements.length > 0) {
            const refBar = document.createElement('div');
            refBar.className = 'tag-suggestions-bar combo-refinements';
            const label = document.createElement('span');
            label.className = 'suggestion-bar-label';
            label.textContent = 'Refine with';
            refBar.appendChild(label);
            for (const r of appState.comboRefinements) {
                const chip = document.createElement('span');
                chip.className = 'suggestion-chip';
                chip.title = `Add "${r.tag}" to combo`;
                chip.onclick = async () => {
                    appState.comboContext = [...ctx, r.tag];
                    appState.reviewingTag = r;
                    await navigateCombo(appState.comboContext);
                };
                const tagLabel = document.createElement('span');
                tagLabel.className = 'suggestion-chip-name';
                tagLabel.textContent = r.tag;
                const count = document.createElement('span');
                count.className = 'suggestion-chip-count';
                count.textContent = `${r.count}`;
                chip.appendChild(tagLabel);
                chip.appendChild(count);
                refBar.appendChild(chip);
            }
            els.wallpaperGrid.appendChild(refBar);
        }
    } else if (appState.reviewingUploader) {
        const uploaderName = appState.reviewingUploader;
        const bar = document.createElement('div');
        bar.className = 'tag-review-bar';

        const textSpan = document.createElement('span');
        textSpan.className = 'review-bar-text';
        const nameEl = document.createElement('strong');
        nameEl.className = 'breadcrumb-tag';
        nameEl.textContent = uploaderName;
        nameEl.title = 'Exit review';
        nameEl.onclick = async () => { appState.reviewingUploader = null; await clearSearch(); };
        textSpan.appendChild(nameEl);
        const countEl = document.createElement('span');
        countEl.className = 'review-bar-count';
        countEl.textContent = `${appState.images.length} in pool`;
        textSpan.appendChild(countEl);
        textSpan.insertBefore(createTypeBadge('uploader'), nameEl);
        bar.appendChild(textSpan);

        const actions = document.createElement('div');
        actions.className = 'review-bar-actions';
        const excludeBtn = document.createElement('button');
        excludeBtn.className = 'review-btn-exclude';
        excludeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Exclude';
        excludeBtn.onclick = async () => {
            const config = appState.config;
            const uploaders = [...(config.wallhaven.exclude_uploaders || [])];
            if (!uploaders.some(u => u.toLowerCase() === uploaderName.toLowerCase())) {
                await applyExclusionUpdate({
                    type: 'uploader',
                    tags: [uploaderName],
                    refreshSuggestions: true,
                    render: false,
                });
            }
            appState.reviewingUploader = null;
            await clearSearch();
        };
        const backBtn = document.createElement('button');
        backBtn.className = 'review-btn-back';
        backBtn.textContent = 'Back';
        backBtn.onclick = async () => { appState.reviewingUploader = null; await clearSearch(); };
        actions.appendChild(excludeBtn);
        actions.appendChild(backBtn);
        bar.appendChild(actions);
        els.wallpaperGrid.appendChild(bar);
    } else {
        const suggestionsBar = createBlocklistSuggestionsBar();
        if (suggestionsBar) els.wallpaperGrid.appendChild(suggestionsBar);
    }

    // AI analysis results panel
    if (appState.aiSuggestions && !appState.aiSuggestions.error
        && !appState.reviewingTag && !appState.reviewingUploader && !appState.searchQuery) {
        const ai = appState.aiSuggestions;
        const aiPanel = document.createElement('div');
        aiPanel.className = 'ai-results-panel';

        if (ai.analysis) {
            const analysisDiv = document.createElement('div');
            analysisDiv.className = 'ai-analysis-text';
            analysisDiv.textContent = ai.analysis;
            const copyBtn = document.createElement('button');
            copyBtn.className = 'ai-copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = () => {
                const lines = [ai.analysis, ''];
                for (const s of (ai.add_suggestions || [])) {
                    lines.push(`+ [${s.confidence || ''}] ${s.tags.join(' + ')}: ${s.reason}`);
                }
                for (const s of (ai.remove_suggestions || [])) {
                    lines.push(`- ${s.tags.join(' + ')}: ${s.reason}`);
                }
                const text = lines.join('\n');
                if (window.electronAPI?.copyToClipboard) {
                    window.electronAPI.copyToClipboard(text);
                } else {
                    navigator.clipboard.writeText(text).catch(() => {});
                }
                copyBtn.textContent = 'Copied';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            };
            analysisDiv.appendChild(copyBtn);
            aiPanel.appendChild(analysisDiv);
        }

        const renderSection = (items, label, action, btnClass, btnLabel, appliedLabel) => {
            if (!items || items.length === 0) return;
            const section = document.createElement('div');
            section.className = 'ai-section';
            const sectionLabel = document.createElement('div');
            sectionLabel.className = 'ai-section-label';
            sectionLabel.textContent = label;
            section.appendChild(sectionLabel);
            for (const s of items) {
                const row = document.createElement('div');
                row.className = 'ai-suggestion-row' + (s._applied ? ' applied' : '');
                const info = document.createElement('div');
                info.className = 'ai-suggestion-info';
                info.appendChild(createTypeBadge(s.type || 'tag'));
                const tagsSpan = document.createElement('span');
                tagsSpan.className = 'ai-suggestion-tags clickable';
                tagsSpan.textContent = s.tags.join(' + ');
                tagsSpan.title = 'Click to preview matching images';
                tagsSpan.onclick = (e) => {
                    e.stopPropagation();
                    if (s.type === 'uploader') {
                        enterUploaderReview(s.tags[0]);
                    } else {
                        enterTagReview(s.tags);
                    }
                };
                info.appendChild(tagsSpan);
                if (s.confidence) {
                    const confSpan = document.createElement('span');
                    const validConf = ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : 'low';
                    confSpan.className = `ai-confidence ai-confidence-${validConf}`;
                    confSpan.textContent = s.confidence;
                    info.appendChild(confSpan);
                }
                const reasonSpan = document.createElement('span');
                reasonSpan.className = 'ai-suggestion-reason';
                reasonSpan.textContent = s.reason;
                info.appendChild(reasonSpan);
                row.appendChild(info);
                if (!s._applied) {
                    const btn = document.createElement('button');
                    btn.className = btnClass;
                    btn.textContent = btnLabel;
                    btn.onclick = () => applyAISuggestion(s, action);
                    row.appendChild(btn);
                } else {
                    const badge = document.createElement('span');
                    badge.className = 'ai-applied-badge';
                    badge.textContent = appliedLabel;
                    row.appendChild(badge);
                }
                section.appendChild(row);
            }
            aiPanel.appendChild(section);
        };

        renderSection(ai.add_suggestions, 'Suggested Additions', 'add', 'ai-btn-accept', 'Exclude', 'Applied');
        renderSection(ai.remove_suggestions, 'Suggested Removals', 'remove', 'ai-btn-remove', 'Remove', 'Removed');

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ai-close-btn';
        closeBtn.textContent = 'Dismiss';
        closeBtn.onclick = () => { appState.aiSuggestions = null; renderBlocklistView(); };
        aiPanel.appendChild(closeBtn);

        els.wallpaperGrid.appendChild(aiPanel);
    }

    if (appState.blocklistTab === 'recoverable') {
        if (appState.images.length === 0) {
            const msg = appState.searchQuery
                ? `No matches for "${esc(appState.searchQuery)}"`
                : 'No recoverable images in trash';
            els.wallpaperGrid.insertAdjacentHTML('beforeend', `
                <div class="empty-state">
                    <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div>
                    <p>${msg}</p>
                </div>
            `);
            return;
        }
        renderNextBatch();
        setTimeout(updateGridMetrics, 100);
    } else {
        renderBlockedList(filteredEntries);
    }
}

function renderBlockedList(entries) {
    if (entries.length === 0) {
        els.wallpaperGrid.insertAdjacentHTML('beforeend', `
            <div class="empty-state">
                <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
                <p>No blocked images</p>
            </div>
        `);
        return;
    }

    const list = document.createElement('div');
    list.className = 'blocklist-list';

    entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'blocklist-entry';

        const date = new Date(entry.timestamp * 1000);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const statusClass = entry.recoverable ? 'recoverable' : 'permanent';
        const statusText = entry.recoverable ? 'In Trash' : 'Deleted';

        row.innerHTML = `
            <span class="entry-name" title="${esc(entry.filename)}">${esc(entry.filename)}</span>
            <span class="entry-status ${statusClass}">${statusText}</span>
            <span class="entry-date">${esc(dateStr)}</span>
            <button class="entry-action">Unblock</button>
        `;

        row.querySelector('.entry-action').onclick = (e) => {
            e.stopPropagation();
            unblockImage(entry.filename);
        };

        list.appendChild(row);
    });

    els.wallpaperGrid.appendChild(list);
}

function renderNextBatch() {
    if (appState.currentBatchIndex >= appState.images.length) {
        if (!appState.searchMatches && !appState.imagesComplete) {
            loadMoreImages();
        }
        return;
    }

    const start = appState.currentBatchIndex;
    const end = Math.min(start + appState.batchSize, appState.images.length);
    const batch = appState.images.slice(start, end);

    if (sentinel.parentNode) sentinel.remove();

    const fragment = document.createDocumentFragment();
    batch.forEach((img, i) => {
        const card = createCard(img);
        // Stagger entrance animation for visible cards
        if (i < 20) card.style.animationDelay = `${i * 30}ms`;
        fragment.appendChild(card);
    });

    els.wallpaperGrid.appendChild(fragment);
    appState.currentBatchIndex = end;
    if (!document.querySelector('.wallpaper-card.current')) markCurrentWallpaper();

    if (appState.currentBatchIndex < appState.images.length || (!appState.searchMatches && !appState.imagesComplete)) {
        els.wallpaperGrid.appendChild(sentinel);
        observer.observe(sentinel);
    } else {
        observer.unobserve(sentinel);
    }
}

let _trashBannerShown = false;
function showTrashPermissionBanner() {
    if (_trashBannerShown) return;
    _trashBannerShown = true;

    const banner = document.createElement('div');
    banner.className = 'permission-banner';
    banner.innerHTML = `
        <span>Cannot read images from Trash — grant <strong>Full Disk Access</strong> to your terminal in System Settings &gt; Privacy &amp; Security.</span>
        <button class="banner-open" title="Open System Settings">Open Settings</button>
        <button class="banner-close" title="Dismiss">&times;</button>
    `;
    banner.querySelector('.banner-open').onclick = () => {
        window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    };
    banner.querySelector('.banner-close').onclick = () => banner.remove();
    els.wallpaperGrid.prepend(banner);
}

function imageUrl(path) {
    if (path.startsWith('__trash/')) {
        return `${API_URL}/trash/${encodeURIComponent(path.slice(8))}`;
    }
    return `${API_URL}/images/${encodeURI(path)}`;
}

function thumbnailUrl(path) {
    if (path.startsWith('__trash/')) {
        return `${API_URL}/trash-thumbnails/${encodeURIComponent(path.slice(8))}`;
    }
    return `${API_URL}/thumbnails/${encodeURI(path)}`;
}

function createCard(img) {
    const card = document.createElement('div');
    card.className = 'wallpaper-card';
    card.dataset.path = img.path;
    card.tabIndex = 0; // Make focusable

    if (img.path.includes('/portrait/')) {
        card.classList.add('portrait');
    }

    const thumbUrl = thumbnailUrl(img.path);

    if (appState.mode === 'trash') {
        card.innerHTML = `
            <img class="loading" src="${thumbUrl}" loading="lazy" decoding="async" alt="${esc(img.name)}">
            <div class="overlay">
                <button class="action-btn restore" title="Restore to Pool">${ICONS.restore()}</button>
                <button class="action-btn url" title="Open on Wallhaven">${ICONS.externalLink()}</button>
            </div>
        `;
        const cardImg = card.querySelector('img');
        cardImg.onload = () => cardImg.classList.remove('loading');
        cardImg.onerror = () => {
            fetch(thumbUrl, { method: 'HEAD' }).then(r => {
                if (r.status === 403) showTrashPermissionBanner();
            }).catch(() => {});
        };
        const btns = card.querySelectorAll('.action-btn');
        btns[0].onclick = (e) => { e.stopPropagation(); restoreImage(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); openWallhavenUrl(img.name); };
        card.onclick = () => showLightbox(img);
    } else {
        card.innerHTML = `
            <img class="loading" src="${thumbUrl}" loading="lazy" decoding="async" alt="${esc(img.name)}">
            <div class="overlay">
                <button class="action-btn" title="Set Wallpaper">${ICONS.setWallpaper()}</button>
                <button class="action-btn fav ${img.is_favorite ? 'active' : ''}" title="Favorite">${ICONS.favorite(16, img.is_favorite)}</button>
                <button class="action-btn ban" title="Ban">${ICONS.ban()}</button>
                <button class="action-btn url" title="Open on Wallhaven">${ICONS.externalLink()}</button>
            </div>
        `;
        const cardImg = card.querySelector('img');
        cardImg.onload = () => cardImg.classList.remove('loading');
        card.onclick = () => showLightbox(img);
        const btns = card.querySelectorAll('.action-btn');
        btns[0].onclick = (e) => { e.stopPropagation(); setWallpaper(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); toggleFavoriteImage(img.path); };
        btns[2].onclick = (e) => { e.stopPropagation(); banImage(img.path); };
        btns[3].onclick = (e) => { e.stopPropagation(); openWallhavenUrl(img.name); };
    }

    return card;
}

// --- Lightbox ---

let lightboxEl = null;
let lightboxImg = null;
let _imgEl = null;
let _stageEl = null;
let zoom = { scale: 1, x: 0, y: 0 };
let dragState = null;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
const ZOOM_RATE = 0.0015;
const ZOOM_STEP_FACTOR = 1.15;
const DRAG_THRESHOLD_PX = 5;
const ARROW_PAN_PX = 50;

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function applyZoom() {
    if (!_imgEl) return;
    _imgEl.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function clampPan() {
    if (!_stageEl) return;
    const rect = _stageEl.getBoundingClientRect();
    const overflowX = Math.max(0, (rect.width * zoom.scale - rect.width) / 2);
    const overflowY = Math.max(0, (rect.height * zoom.scale - rect.height) / 2);
    zoom.x = clamp(zoom.x, -overflowX, overflowX);
    zoom.y = clamp(zoom.y, -overflowY, overflowY);
}

function resetZoom() {
    zoom = { scale: 1, x: 0, y: 0 };
    applyZoom();
}

// Anchor the zoom so the image-pixel under (clientX, clientY) stays fixed across the scale change.
// Pass null for clientX/clientY to anchor at stage center (cursor offset = 0 → translate just scales by r).
function zoomAt(targetScale, clientX, clientY) {
    if (!_stageEl) return;
    const oldScale = zoom.scale;
    const newScale = clamp(targetScale, ZOOM_MIN, ZOOM_MAX);
    if (newScale === oldScale) return;
    const rect = _stageEl.getBoundingClientRect();
    const cX = rect.left + rect.width / 2;
    const cY = rect.top + rect.height / 2;
    const ax = clientX ?? cX;
    const ay = clientY ?? cY;
    const r = newScale / oldScale;
    zoom.x = (ax - cX) * (1 - r) + r * zoom.x;
    zoom.y = (ay - cY) * (1 - r) + r * zoom.y;
    zoom.scale = newScale;
    clampPan();
    applyZoom();
}

function handleWheel(e) {
    e.preventDefault();
    zoomAt(zoom.scale * Math.exp(-e.deltaY * ZOOM_RATE), e.clientX, e.clientY);
}

function handleMouseDown(e) {
    if (e.button !== 0 || !_imgEl) return;
    e.preventDefault();
    dragState = {
        startX: e.clientX,
        startY: e.clientY,
        startTx: zoom.x,
        startTy: zoom.y,
        moved: false,
    };
    _imgEl.classList.add('dragging');
    // Attach window listeners only for the duration of the drag
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp, { once: true });
}

function handleMouseMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
        dragState.moved = true;
    }
    if (!dragState.moved) return;
    zoom.x = dragState.startTx + dx;
    zoom.y = dragState.startTy + dy;
    clampPan();
    applyZoom();
}

function handleMouseUp() {
    window.removeEventListener('mousemove', handleMouseMove);
    if (!dragState) return;
    _imgEl?.classList.remove('dragging');
    dragState = null;
}

function zoomAtCenter(factor) {
    zoomAt(zoom.scale * factor, null, null);
}

function arrowPanOrNavigate(direction) {
    // direction: -1 = ArrowLeft, +1 = ArrowRight
    if (!_stageEl) return;
    if (zoom.scale <= 1) {
        navigateLightbox(direction);
        return;
    }
    const rect = _stageEl.getBoundingClientRect();
    const overflowX = Math.max(0, (rect.width * zoom.scale - rect.width) / 2);
    // ArrowRight (+1): pan image left (decrease zoom.x toward -overflowX). At -overflowX → next.
    // ArrowLeft (-1):  pan image right (increase zoom.x toward +overflowX). At +overflowX → prev.
    if (direction > 0) {
        if (zoom.x <= -overflowX + 0.5) {
            navigateLightbox(1);
            return;
        }
        zoom.x = Math.max(-overflowX, zoom.x - ARROW_PAN_PX);
    } else {
        if (zoom.x >= overflowX - 0.5) {
            navigateLightbox(-1);
            return;
        }
        zoom.x = Math.min(overflowX, zoom.x + ARROW_PAN_PX);
    }
    applyZoom();
}

function handleDoubleClick(e) {
    if (!_stageEl || !_imgEl) return;
    e.preventDefault();
    if (zoom.scale > 1.01) {
        resetZoom();
        return;
    }
    // Zoom to 100% original pixels, anchored at click position.
    // Skip when image is already at or above natural size (small image).
    const naturalRatio = _imgEl.naturalWidth / _stageEl.getBoundingClientRect().width;
    if (!isFinite(naturalRatio) || naturalRatio <= zoom.scale + 0.01) return;
    zoomAt(naturalRatio, e.clientX, e.clientY);
}

function syncGalleryToLightbox(path) {
    const card = document.querySelector(`.wallpaper-card[data-path="${CSS.escape(path)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    card.focus({ preventScroll: true });
}

function showLightbox(img) {
    lightboxImg = img;
    syncGalleryToLightbox(img.path);
    const isTrash = appState.mode === 'trash';

    // If lightbox already exists, just swap the image (avoids DOM thrashing)
    if (lightboxEl) {
        _imgEl.src = imageUrl(img.path);
        resetZoom();
        return;
    }

    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.innerHTML = `
        <div class="lightbox-backdrop"></div>
        <div class="lightbox-stage">
            <img class="lightbox-image" src="${imageUrl(img.path)}" alt="">
        </div>
        <div class="lightbox-toolbar">
            ${isTrash ? `
                <button class="lb-btn" data-action="restore" title="Restore to Pool">
                    ${ICONS.restore(18)}<span>Restore</span>
                </button>
            ` : `
                <button class="lb-btn" data-action="set" title="Set Wallpaper (Enter)">
                    ${ICONS.setWallpaper(18)}<span>Set</span><kbd>Enter</kbd>
                </button>
                <button class="lb-btn" data-action="fav" title="Favorite (F)">
                    ${ICONS.favorite(18)}<span>Fav</span><kbd>F</kbd>
                </button>
                <button class="lb-btn" data-action="ban" title="Ban (X)">
                    ${ICONS.ban(18)}<span>Ban</span><kbd>X</kbd>
                </button>
            `}
            <div class="lb-spacer"></div>
            <button class="lb-btn" data-action="url" title="Open on Wallhaven (O)">
                ${ICONS.externalLink(18)}<span>Wallhaven</span><kbd>O</kbd>
            </button>
        </div>
        <button class="lightbox-close" title="Close (Esc)">${ICONS.ban(20)}</button>
        <button class="lightbox-nav prev" title="Previous image">${ICONS.chevronLeft()}</button>
        <button class="lightbox-nav next" title="Next image">${ICONS.chevronRight()}</button>
    `;

    document.body.appendChild(lightboxEl);
    _stageEl = lightboxEl.querySelector('.lightbox-stage');
    _imgEl = lightboxEl.querySelector('.lightbox-image');
    resetZoom();
    requestAnimationFrame(() => lightboxEl.classList.add('visible'));

    // Wheel zoom on the stage (anchored at cursor)
    _stageEl.addEventListener('wheel', handleWheel, { passive: false });
    // Drag to pan: mousedown on image; window mousemove/up are attached on demand in handleMouseDown
    // so dragging continues outside the image bounds without firing on every idle mouse move.
    _imgEl.addEventListener('mousedown', handleMouseDown);
    _imgEl.addEventListener('dblclick', handleDoubleClick);

    // All button actions read from lightboxImg (not closure) to stay current after navigation
    lightboxEl.querySelector('.lightbox-backdrop').onclick = closeLightbox;
    lightboxEl.querySelector('.lightbox-close').onclick = closeLightbox;
    lightboxEl.querySelector('.lightbox-nav.prev').onclick = () => navigateLightbox(-1);
    lightboxEl.querySelector('.lightbox-nav.next').onclick = () => navigateLightbox(1);

    lightboxEl.querySelectorAll('.lb-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (!lightboxImg) return;
            const action = btn.dataset.action;
            if (action === 'set') { setWallpaper(lightboxImg.path); closeLightbox(); }
            else if (action === 'fav') { toggleFavoriteImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'ban') { banImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'restore') { restoreImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'url') { openWallhavenUrl(lightboxImg.name); }
        };
    });
}

function closeLightbox() {
    if (!lightboxEl) return;
    // Safety net: if a drag is in flight when closing, tear down its window listeners
    if (dragState) {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        dragState = null;
    }
    lightboxEl.classList.remove('visible');
    setTimeout(() => {
        if (lightboxEl) {
            lightboxEl.remove();
            lightboxEl = null;
            lightboxImg = null;
            _imgEl = null;
            _stageEl = null;
        }
    }, 200);
}

function navigateLightbox(direction) {
    if (!lightboxImg) return;
    const idx = appState.images.findIndex(i => i.path === lightboxImg.path);
    if (idx === -1) return;
    const next = idx + direction;
    if (next >= 0 && next < appState.images.length) {
        showLightbox(appState.images[next]);
    }
}
