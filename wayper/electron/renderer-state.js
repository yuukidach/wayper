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
    dislike: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/><path d="m12 6-2 5 4 2-2 5"/></svg>`,
    ban: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>`,
    close: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
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
    mode: 'pool', // pool, favorites, trash, model-review
    purity: ['sfw'], // active purities: subset of ['sfw', 'sketchy', 'nsfw']
    monitors: [],
    selectedMonitor: null, // monitor name
    status: { auto_rotation: false, rotation_paused: false },
    statusRequestId: 0, // Invalidates status responses for a previous monitor
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
    modelReviewData: null,          // Auto-filter quarantine queue
    modelReviewContextKey: null,    // Purity/orientation represented by modelReviewData
    // Review is scoped by purity/orientation, not by the physical monitor.
    // Keep the last response for each scope so moving between monitors can
    // paint synchronously and refresh in the background.
    modelReviewContextCache: new Map(),
    modelReviewRecommendationCache: new Map(), // Makes repeat entry immediate
    modelReviewRecommendationRequests: new Map(), // Coalesces background ranking work
    modelReviewSelectedPath: null,  // Item currently inspected in the review workspace
    modelReviewSource: null,        // Visible review lane: held or recommended
    modelReviewActionInFlight: new Set(), // Paths being resolved from the workspace
    modelReviewStrategySaving: false, // Prevent concurrent strategy toggles
    modelReviewResolvedPaths: new Set(), // Decisions made during the current queue view
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
    loadedImageMode: null,          // Library mode represented by images/allImages
    loadedImageContextKey: null,    // Purity/orientation represented by the cached library

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
let blocklistDateFormatter = new Intl.DateTimeFormat();
let blocklistTimeFormatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

function updateBlocklistDateLocale(locale) {
    const localeTag = locale === 'zh' ? 'zh-CN' : 'en-US';
    try {
        blocklistDateFormatter = new Intl.DateTimeFormat(localeTag);
        blocklistTimeFormatter = new Intl.DateTimeFormat(localeTag, {
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (_) {
        // Keep the host default if a runtime ships without the requested
        // locale data.
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('wayper-language-changed', event => {
        updateBlocklistDateLocale(event.detail?.locale);
        if (appState.mode === 'trash' && typeof renderBlocklistView === 'function') {
            renderBlocklistView();
        }
    });
}

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
    btnLocate: document.getElementById('btn-locate-current'),

    btnPool: document.getElementById('btn-pool'),
    btnFavorites: document.getElementById('btn-favorites'),
    btnBlocklist: document.getElementById('btn-blocklist'),
    btnModelReview: document.getElementById('btn-model-review'),
    btnFilterRules: document.getElementById('btn-filter-rules'),
    btnFilterModel: document.getElementById('btn-filter-model'),
    btnFilterBoth: document.getElementById('btn-filter-both'),
    filterStrategySummary: document.getElementById('filter-strategy-summary'),

    btnPuritySfw: document.getElementById('btn-purity-sfw'),
    btnPuritySketchy: document.getElementById('btn-purity-sketchy'),
    btnPurityNsfw: document.getElementById('btn-purity-nsfw'),

    btnAutoRotation: document.getElementById('btn-auto-rotation'),
    btnSettings: document.getElementById('btn-settings'),
    updateIndicator: document.getElementById('update-indicator'),

    monitorsList: document.getElementById('monitors-list'),

    // Views
    mainContent: document.getElementById('main-content'),
    wallpaperGrid: document.getElementById('wallpaper-grid'),
    settingsView: document.getElementById('settings-view'),

    // Settings
    btnSaveSettings: document.getElementById('btn-save-settings'),
    btnCancelSettings: document.getElementById('btn-cancel-settings'),

    // Footer
    rotationDot: document.getElementById('rotation-dot'),
    rotationStatus: document.getElementById('rotation-status'),
    diskUsage: document.getElementById('disk-usage'),
    countPool: document.getElementById('count-pool'),
    countFavorites: document.getElementById('count-favorites'),
    countBlocklist: document.getElementById('count-blocklist'),
    countModelReview: document.getElementById('count-model-review'),

    // Search
    searchInput: document.getElementById('search-input'),
    searchCount: document.getElementById('search-count'),
    searchClear: document.getElementById('search-clear'),
    searchDropdown: document.getElementById('search-dropdown'),
};

function isModelReviewMode() {
    return appState.mode === 'model-review';
}

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

    // Phase 1: config and monitors are independent. The backend owns rotation startup.
    await Promise.all([fetchConfig(), fetchMonitors()]);
    // Phase 2: all depend on config/monitors being ready
    await Promise.all([fetchStatus(), fetchDiskUsage(), refreshImages()]);
    if (typeof scheduleModelReviewPrefetch === 'function') {
        scheduleModelReviewPrefetch();
    }

    // Initial metrics update after images loaded (or attempted)
    setTimeout(updateGridMetrics, 500);

    // SSE for real-time mode changes
    connectSSE();

    // Poll counts and automatic rotation state.
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
    els.btnLocate.onclick = () => scrollToCurrentWallpaper();

    // Sidebar: Library
    els.btnPool.onclick = () => setViewMode('pool');
    els.btnFavorites.onclick = () => setViewMode('favorites');
    els.btnBlocklist.onclick = () => setViewMode('trash');
    if (els.btnModelReview) els.btnModelReview.onclick = () => setViewMode('model-review');

    // The filtering strategy is a first-class workflow control rather than a
    // buried setting.  It is persisted immediately so the sidebar always
    // reflects the boundary used by automatic downloads.
    for (const button of [els.btnFilterRules, els.btnFilterModel, els.btnFilterBoth]) {
        if (!button) continue;
        button.onclick = () => setFilterStrategy(button.dataset.strategy);
        button.onkeydown = event => {
            if (typeof handleFilterStrategyKeydown === 'function') {
                handleFilterStrategyKeydown(event);
            }
        };
    }

    // Sidebar: Purity toggles
    els.btnPuritySfw.onclick = () => toggleSinglePurity('sfw');
    els.btnPuritySketchy.onclick = () => toggleSinglePurity('sketchy');
    els.btnPurityNsfw.onclick = () => toggleSinglePurity('nsfw');

    // Sidebar: automatic rotation
    els.btnAutoRotation.onclick = toggleAutoRotation;

    // Sidebar: Settings
    els.btnSettings.onclick = () => switchView('settings');

    // Settings Form
    els.btnSaveSettings.onclick = saveSettings;
    els.btnCancelSettings.onclick = () => {
        // A language dropdown change is previewed immediately.  Cancel must
        // restore the persisted preference so an unsaved choice is not left
        // active for the rest of this session.
        window.WayperI18n?.setPreference?.(appState.config?.language || 'auto');
        switchView('grid');
    };
    document.getElementById('input-language')?.addEventListener('change', event => {
        window.WayperI18n?.setPreference?.(event.target?.value);
    });
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

    // Settings hides the gallery toolbar, so its shortcuts must not mutate a
    // wallpaper behind the form. Escape/S is the only global action here.
    if (appState.view === 'settings') {
        if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
            e.preventDefault();
            switchView('grid');
        }
        return;
    }

    // Model-review rows have their own keyboard actions.  Keep this guard
    // before the gallery shortcuts: otherwise D/X/Delete would remove the current
    // wallpaper and Enter/Space would open an unrelated focused card.
    if (!lightboxEl) {
        const modelReviewTarget = e.target?.closest?.('.model-review-row');
        if (modelReviewTarget) {
            const handled = typeof handleModelReviewRowKeyboard === 'function'
                && handleModelReviewRowKeyboard(e);
            const reviewKeys = [
                'Enter', ' ', 'Escape', 'a', 'A', 'd', 'D', 'x', 'X', 'Delete',
                'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            ];
            // Even if a stale row is between data refreshes, never let a
            // review key fall through to a destructive gallery shortcut.
            if (handled || reviewKeys.includes(e.key)) return;
        }

        // The whole card deck owns the same shortcuts as the full preview.
        // Consume review keys even when the deck is empty so X/Delete can
        // never fall through to the unrelated current-wallpaper action.
        if (isModelReviewMode() && appState.view === 'grid') {
            const selected = typeof selectedModelReviewItem === 'function'
                ? selectedModelReviewItem()
                : null;
            const focusedButton = e.target?.closest?.('button');
            if ((e.key === 'Enter' || e.key === ' ') && focusedButton) return;
            if (['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                const direction = ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1;
                if (typeof moveModelReviewSelection === 'function') {
                    moveModelReviewSelection(direction);
                }
                return;
            }
            if ((e.key === 'Enter' || e.key === ' ') && selected) {
                e.preventDefault();
                if (typeof previewPreferenceSuggestion === 'function') {
                    previewPreferenceSuggestion(selected, e);
                }
                return;
            }
            if ((e.key === 'a' || e.key === 'A') && selected) {
                e.preventDefault();
                void resolveModelReviewDecision(selected, 'keep');
                return;
            }
            if (['d', 'D', 'x', 'X', 'Delete'].includes(e.key) && selected) {
                e.preventDefault();
                void resolveModelReviewDecision(selected, 'ban');
                return;
            }
            if (['Enter', ' ', 'a', 'A', 'd', 'D', 'x', 'X', 'Delete'].includes(e.key)) return;
            if (['/', 'h', 'l', 'f', 'o', 'u', 'g', 'G'].includes(e.key)) {
                e.preventDefault();
                return;
            }
        }
    }

    // Lightbox-specific shortcuts
    if (lightboxEl) {
        // A focused toolbar/close/navigation button should receive native
        // Enter/Space activation.  The lightbox listener normally stops these
        // events before they reach this document listener; keep the check here
        // as a defensive fallback for dynamically focused controls.
        if (
            (e.key === 'Enter' || e.key === ' ')
            && lightboxEl.contains?.(e.target)
            && e.target?.closest?.('button')
        ) {
            return;
        }
        switch(e.key) {
            case 'Escape':
                closeLightbox(e);
                return;
            case 'ArrowLeft':
                e.preventDefault();
                if (lightboxImg?.reviewOnly) {
                    navigateReviewLightbox(-1);
                } else {
                    arrowPanOrNavigate(-1);
                }
                return;
            case 'ArrowRight':
                e.preventDefault();
                if (lightboxImg?.reviewOnly) {
                    navigateReviewLightbox(1);
                } else {
                    arrowPanOrNavigate(1);
                }
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
            case 'a':
            case 'A':
                if (lightboxImg?.reviewOnly) {
                    e.preventDefault();
                    void keepLightboxReviewSuggestion();
                }
                return;
            case 'd':
            case 'D':
                if (lightboxImg) {
                    e.preventDefault();
                    if (lightboxImg.reviewOnly) {
                        void banLightboxReviewSuggestion();
                    } else {
                        dislikeImage(lightboxImg.path);
                        closeLightbox();
                    }
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

    // Number keys select monitors in their rendered order (1 = first monitor,
    // 2 = second monitor, etc.).  Keep this ahead of the view shortcuts so
    // monitor navigation remains predictable as the sidebar evolves.
    if (/^[1-9]$/.test(e.key)) {
        const monitor = appState.monitors[Number(e.key) - 1];
        if (monitor) {
            e.preventDefault();
            switchMonitor(monitor.name);
        }
        return;
    }

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
        case 'd':
        case 'D':
            if (focusedCard) {
                dislikeImage(focusedCard.dataset.path);
            } else {
                controlAction('dislike');
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
        case 'p':
        case 'P':
            setViewMode('pool');
            break;
        case 'v':
        case 'V':
            setViewMode('favorites');
            break;
        case 'b':
        case 'B':
            setViewMode('trash');
            break;
        case 'm':
        case 'M':
            setViewMode('model-review');
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

function modelReviewNavigationRows() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
        return [];
    }
    return [...document.querySelectorAll('.model-review-row')].filter(row => (
        row
        && !row.hidden
        && row.getAttribute?.('aria-hidden') !== 'true'
    ));
}

function focusNavigationTarget(target) {
    if (!target || typeof target.focus !== 'function') return false;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    return true;
}

function focusFirstModelReviewCandidate() {
    return focusNavigationTarget(modelReviewNavigationRows()[0]);
}

function focusFirstGalleryCard(
    cards = typeof document !== 'undefined'
        ? document.getElementsByClassName('wallpaper-card')
        : [],
) {
    return focusNavigationTarget(cards?.[0]);
}

function gridColumnCount(
    cards = typeof document !== 'undefined'
        ? document.getElementsByClassName('wallpaper-card')
        : [],
) {
    const firstRect = cards[0]?.getBoundingClientRect?.();
    const firstTop = firstRect?.top;
    if (Number.isFinite(firstTop)) {
        for (let i = 1; i < cards.length; i++) {
            const rect = cards[i]?.getBoundingClientRect?.();
            const top = rect?.top;
            if (Number.isFinite(top) && top > firstTop + 1) return i;
        }
        if (cards.length > 0) return cards.length;
    }
    const grid = typeof els !== 'undefined' ? els.wallpaperGrid : null;
    const template = grid && typeof getComputedStyle === 'function'
        ? getComputedStyle(grid).gridTemplateColumns
        : '';
    const columns = String(template || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, columns || Number(appState.gridColumns) || 1);
}

function galleryCardIsInFirstRow(card, index, cards, columns) {
    const firstRect = cards[0]?.getBoundingClientRect?.();
    const cardRect = card?.getBoundingClientRect?.();
    if (firstRect && cardRect && Number.isFinite(firstRect.top) && Number.isFinite(cardRect.top)) {
        return cardRect.top <= firstRect.top + 1;
    }
    return index < columns;
}

function navigateGrid(direction) {
    const cards = document.getElementsByClassName('wallpaper-card'); // Live collection
    const reviewRows = modelReviewNavigationRows();

    const focused = document.activeElement;
    const focusedReviewRow = focused?.closest?.('.model-review-row');

    // Model-review rows are laid out before the gallery cards, so bridge the
    // two focus regions when an arrow event reaches the document-level handler
    // (the row's own handler normally handles this first).
    if (focusedReviewRow) {
        if (typeof moveModelReviewFocus === 'function') {
            moveModelReviewFocus(focusedReviewRow, direction);
            return;
        }
        const reviewIndex = reviewRows.indexOf(focusedReviewRow);
        if (reviewIndex >= 0) {
            const step = direction === 'ArrowUp' || direction === 'ArrowLeft' ? -1 : 1;
            const nextRow = reviewRows[reviewIndex + step];
            if (nextRow) {
                focusNavigationTarget(nextRow);
            } else if (step > 0) {
                focusFirstGalleryCard(cards);
            }
            return;
        }
    }

    if (cards.length === 0) {
        // A review queue can exist even when the recoverable gallery is empty.
        // Keep arrow navigation useful in that state as well.
        focusFirstModelReviewCandidate();
        return;
    }

    // Check if focused element is actually a card
    let index = -1;
    if (focused?.classList?.contains?.('wallpaper-card')) {
        index = Array.prototype.indexOf.call(cards, focused);
    }

    // On entering the grid, expose the review queue first when it exists.  A
    // user can then continue with ArrowDown/ArrowRight until the gallery;
    // without a queue this preserves the original first-card behavior.
    if (index === -1) {
        if (reviewRows.length && focusFirstModelReviewCandidate()) return;
        focusFirstGalleryCard(cards);
        return;
    }

    // Read actual column count from CSS grid computed style.
    const cols = gridColumnCount(cards);
    let nextIndex = index;

    switch(direction) {
        case 'ArrowRight': nextIndex = index + 1; break;
        case 'ArrowLeft': nextIndex = index - 1; break;
        case 'ArrowDown': nextIndex = index + cols; break;
        case 'ArrowUp': nextIndex = index - cols; break;
    }

    // The review panel occupies the row immediately above the first gallery
    // row.  ArrowUp at that boundary should enter its first candidate instead
    // of becoming a no-op.
    if (
        direction === 'ArrowUp'
        && galleryCardIsInFirstRow(focused, index, cards, cols)
        && reviewRows.length
    ) {
        if (focusFirstModelReviewCandidate()) return;
    }

    if (nextIndex >= 0 && nextIndex < cards.length) {
        focusNavigationTarget(cards[nextIndex]);
    }
}

// --- Navigation ---
