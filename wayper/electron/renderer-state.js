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
    blocklistPager: WayperBlocklistPager.createState(),
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
    preferenceSuggestions: null,   // Local metadata-model image review candidates
    preferenceSuggestionRequestId: 0, // Invalidates stale model-review responses
    preferenceReviewContextKey: null, // Purity/orientation context for the candidate queue
    preferenceReviewResolvedPaths: new Set(), // Candidates already acted on in this view
    preferenceReviewRefillPromise: null, // Coalesces concurrent candidate refills
    updateInfo: null,              // Latest app update check payload

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
let blocklistObserver = null;
let blocklistSentinel = null;
// Keep a small ranked queue in memory so removing a visible candidate can be
// filled immediately without waiting for another round-trip.  The renderer
// only shows the number that forms complete rows and refills when needed.
const PREFERENCE_REVIEW_LIMIT = 24;
const PREFERENCE_REVIEW_BASE_COUNT = 8;
const PREFERENCE_REVIEW_CARD_MIN_WIDTH = 285;
const PREFERENCE_REVIEW_GAP = 8;
const BLOCKLIST_PAGE_SIZE = WayperBlocklistPager.DEFAULT_PAGE_SIZE;
const blocklistDateFormatter = new Intl.DateTimeFormat();
const blocklistTimeFormatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

// Global Loader
const loader = document.createElement('div');
loader.className = 'global-loader';
loader.innerHTML = '<div class="spinner"></div>';
document.body.appendChild(loader);

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
    updateBannerRoot: document.getElementById('update-banner-root'),

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
    setupBlocklistInfiniteScroll();

    // Resize listener for grid layout
    window.addEventListener('resize', debounce(() => {
        updateGridMetrics();
        // The review list has its own responsive grid.  Keep its visible window
        // aligned to complete rows when the app/sidebar is resized.
        if (typeof syncPreferenceReviewLayout === 'function') {
            syncPreferenceReviewLayout();
        }
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
    checkForAppUpdates();
    setInterval(() => {
        if (!document.hidden) checkForAppUpdates();
    }, 12 * 60 * 60 * 1000);
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
    const browseDownloadDir = document.getElementById('btn-browse-download-dir');
    browseDownloadDir.onclick = async () => {
        if (!window.electronAPI?.selectDownloadDir) return;
        const selected = await window.electronAPI.selectDownloadDir();
        if (selected) document.getElementById('input-download-dir').value = selected;
    };

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
    if (lightboxEl) { closeLightbox(e); return; }
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
                closeLightbox(e);
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
                if (lightboxImg && !lightboxImg.reviewOnly) {
                    setWallpaper(lightboxImg.path);
                    closeLightbox();
                }
                return;
            case ' ':
                e.preventDefault();
                closeLightbox(e);
                return;
            case 'f':
                if (lightboxImg && !lightboxImg.reviewOnly) {
                    toggleFavoriteImage(lightboxImg.path);
                    closeLightbox();
                }
                return;
            case 'k':
            case 'K':
                if (lightboxImg?.reviewOnly) {
                    e.preventDefault();
                    void keepLightboxReviewSuggestion();
                }
                return;
            case 'x':
            case 'X':
            case 'Delete':
                if (lightboxImg) {
                    e.preventDefault();
                    if (lightboxImg.reviewOnly) {
                        void banLightboxReviewSuggestion();
                    } else {
                        banImage(lightboxImg.path);
                        closeLightbox();
                    }
                }
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
                selectBlocklistTab('recoverable');
            }
            break;
        case ']':
            if (appState.mode === 'trash') {
                selectBlocklistTab('blocked');
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
