const API_URL = 'http://127.0.0.1:8080';

const _escDiv = document.createElement('div');
function esc(str) {
    _escDiv.textContent = str;
    return _escDiv.innerHTML;
}

// SVG icon templates
const ICONS = {
    setWallpaper: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
    favorite: (s = 16, filled = false) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    dislike: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
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
    images: [],
    config: null, // Full config object
    view: 'grid', // grid, settings
    blocklistTab: 'recoverable', // recoverable, blocked
    blocklistData: null, // cached blocklist data

    // Pagination
    batchSize: 50,
    currentBatchIndex: 0,

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

// DOM Elements
const els = {
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnUndo: document.getElementById('btn-undo'),
    btnFav: document.getElementById('btn-fav-current'),
    btnDislike: document.getElementById('btn-dislike-current'),

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
};

// Init
document.addEventListener('DOMContentLoaded', init);

async function init() {
    // Platform detection for UI adjustments
    if (typeof process !== 'undefined' && process.platform === 'darwin') {
        document.body.classList.add('is-macos');
    }

    setupEventListeners();
    setupInfiniteScroll();

    // Resize listener for grid layout
    window.addEventListener('resize', debounce(() => {
        updateGridMetrics();
    }, 200));

    await fetchConfig(); // to get initial mode & settings
    await fetchMonitors();
    await fetchStatus();
    await fetchDiskUsage();
    await refreshImages();

    // Initial metrics update after images loaded (or attempted)
    setTimeout(updateGridMetrics, 500);

    // SSE for real-time mode changes
    connectSSE();

    // Poll status (counts, daemon state)
    setInterval(fetchStatus, 3000);
    setInterval(fetchDiskUsage, 30000);
}

function setupEventListeners() {
    // Top Controls
    els.btnPrev.onclick = () => controlAction('prev');
    els.btnNext.onclick = () => controlAction('next');
    els.btnUndo.onclick = () => undoDislike();
    els.btnFav.onclick = () => controlAction('fav');
    els.btnDislike.onclick = () => controlAction('dislike');

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

    // Keyboard Shortcuts
    document.addEventListener('keydown', handleGlobalKeydown);
}

function handleGlobalKeydown(e) {
    // Ignore if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    // Lightbox-specific shortcuts
    if (lightboxEl) {
        switch(e.key) {
            case 'Escape':
                closeLightbox();
                return;
            case 'ArrowLeft':
                e.preventDefault();
                navigateLightbox(-1);
                return;
            case 'ArrowRight':
                e.preventDefault();
                navigateLightbox(1);
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
                if (lightboxImg) { dislikeImage(lightboxImg.path); closeLightbox(); }
                return;
            case 'o':
                if (lightboxImg) openWallhavenUrl(lightboxImg.name);
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
            // Unfocus card
            if (focusedCard) document.activeElement.blur();
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
                dislikeImage(focusedCard.dataset.path);
            } else {
                controlAction('dislike');
            }
            break;
        case 'o':
            { const img = focusedCardImage(); if (img) openWallhavenUrl(img.name); }
            break;
        case 'z':
            undoDislike();
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

    const cols = appState.gridColumns || 1;
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
    document.getElementById('input-interval').value = Math.round(c.interval_min || 5);
    document.getElementById('input-quota').value = c.quota_mb;
    document.getElementById('input-pool-target').value = c.pool_target;

    // Wallhaven
    document.getElementById('input-categories').value = w.categories;
    document.getElementById('input-top-range').value = w.top_range;
    document.getElementById('input-sorting').value = w.sorting;
    document.getElementById('input-ai-art').value = w.ai_art_filter;
}

async function saveSettings() {
    const updates = {
        interval_min: parseInt(document.getElementById('input-interval').value) || 5,
        quota_mb: parseInt(document.getElementById('input-quota').value) || 4000,
        pool_target: parseInt(document.getElementById('input-pool-target').value) || 30,
        wallhaven: {
            categories: document.getElementById('input-categories').value,
            top_range: document.getElementById('input-top-range').value,
            sorting: document.getElementById('input-sorting').value,
            ai_art_filter: parseInt(document.getElementById('input-ai-art').value)
        }
    };

    // Calculate interval in seconds for backend if needed
    updates.interval = updates.interval_min * 60;

    els.btnSaveSettings.innerText = 'Saving...';
    try {
        await fetch(`${API_URL}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });

        await fetchConfig(); // Reload config
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
        await fetch(`${API_URL}/api/control/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monitor_name: appState.selectedMonitor })
        });
        // Wait a bit then refresh monitors to show new current image
        setTimeout(fetchMonitors, 500);
    } catch (e) {
        console.error(`Action ${action} failed:`, e);
    }
}

async function setViewMode(mode) {
    appState.mode = mode;
    switchView('grid'); // Ensure we are in grid view
    updateUI();
    refreshImages();
}

function toggleSinglePurity(purity) {
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
    refreshImages();
    fetchStatus();
}

async function toggleDaemon() {
    const action = appState.status.running ? 'stop' : 'start';
    els.btnDaemon.innerText = action === 'start' ? 'Starting...' : 'Stopping...';

    try {
        await fetch(`${API_URL}/api/daemon/${action}`, { method: 'POST' });
        setTimeout(fetchStatus, 1000);
    } catch (e) {
        console.error("Daemon toggle failed", e);
    }
}

async function setWallpaper(path) {
    if (!appState.selectedMonitor) return;

    showLoader();

    // Optimistic UI update
    const card = document.querySelector(`[data-path="${path}"]`);
    if (card) {
        card.style.opacity = '0.5';
    }

    try {
        await fetch(`${API_URL}/api/wallpaper/set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                monitor: appState.selectedMonitor,
                image_path: path
            })
        });

        // Refresh monitor status to show new current
        setTimeout(fetchMonitors, 500);

        if (card) card.style.opacity = '1';
    } catch (e) {
        console.error("Set wallpaper failed", e);
        if (card) card.style.opacity = '1';
    } finally {
        hideLoader();
    }
}

async function toggleFavoriteImage(path) {
    removeImageFromState(path);
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

async function dislikeImage(path) {
    removeImageFromState(path);
    try {
        await fetch(`${API_URL}/api/image/dislike`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: path })
        });
        setTimeout(fetchMonitors, 500);
    } catch (e) {
        console.error("Dislike failed", e);
        refreshImages();
    }
}

async function undoDislike() {
    try {
        await controlAction('undislike');
        // Refresh grid to show restored image
        refreshImages();
    } catch (e) {
        console.error("Undo failed", e);
    }
}

async function fetchBlocklist() {
    try {
        const res = await fetch(`${API_URL}/api/blocklist`);
        appState.blocklistData = await res.json();
    } catch (e) {
        console.error("Failed to fetch blocklist", e);
        appState.blocklistData = { entries: [], total: 0, recoverable_count: 0 };
    }
}

async function unblockImage(filename) {
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
    } catch (e) {
        console.error("Unblock failed", e);
    }
}

async function restoreImage(path) {
    removeImageFromState(path);
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
        // Preserve focus
        if (document.activeElement === card) {
            const next = card.nextElementSibling;
            const prev = card.previousElementSibling;
            if (next && next.classList.contains('wallpaper-card')) {
                next.focus();
            } else if (prev && prev.classList.contains('wallpaper-card')) {
                prev.focus();
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
        const res = await fetch(`${API_URL}/api/config`);
        const data = await res.json();
        appState.config = data;

        // data.mode is now an array of purities
        appState.purity = Array.isArray(data.mode) ? data.mode : [data.mode];

        updateUI();
    } catch (e) { console.error(e); }
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
            }
        } catch (err) {
            console.error('SSE parse error', err);
        }
    };
    es.onerror = () => {};
}

async function fetchStatus() {
    try {
        const res = await fetch(`${API_URL}/api/status`);
        const data = await res.json();

        // Check for external mode change (e.g. via CLI)
        const newMode = Array.isArray(data.mode) ? data.mode : [data.mode];
        if (JSON.stringify(newMode.sort()) !== JSON.stringify([...appState.purity].sort())) {
            console.log(`Mode changed externally: ${appState.purity} -> ${newMode}`);
            appState.purity = newMode;
            updateUI();
            refreshImages();
        }

        if (data.running !== appState.status.running) {
            appState.status = data;
            updateStatusUI();
        } else {
            // Update counts even if running state hasn't changed
            appState.status = data;
            updateStatusUI();
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
    } catch (e) { console.error(e); }
}

async function refreshImages() {
    if (!appState.selectedMonitor) return;

    const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
    const orient = monitor ? monitor.orientation : 'landscape';

    if (appState.mode === 'trash') {
        const url = `${API_URL}/api/images?mode=trash&purity=sfw&orient=${orient}`;
        try {
            const [imgRes] = await Promise.all([
                fetch(url),
                fetchBlocklist(),
            ]);
            appState.images = await imgRes.json();
            renderImages();
        } catch (e) { console.error(e); }
    } else {
        try {
            const fetches = appState.purity.map(p =>
                fetch(`${API_URL}/api/images?mode=${appState.mode}&purity=${p}&orient=${orient}`)
                    .then(r => r.json())
            );
            const results = await Promise.all(fetches);
            appState.images = results.flat();
            renderImages();
        } catch (e) { console.error(e); }
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
        els.daemonStatus.style.color = 'var(--text)';
        els.btnDaemon.innerText = 'Stop Daemon';
        els.btnDaemon.classList.add('danger');
        els.btnDaemon.classList.remove('primary');
    } else {
        els.daemonDot.classList.remove('running');
        els.daemonStatus.innerText = 'Daemon Stopped';
        els.daemonStatus.style.color = 'var(--overlay1)';
        els.btnDaemon.innerText = 'Start Daemon';
        els.btnDaemon.classList.remove('danger');
        els.btnDaemon.classList.add('primary'); // Encourage starting
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
            appState.selectedMonitor = m.name;
            renderMonitors(); // update active state
            refreshImages(); // fetch images for this monitor's orientation
        };

        els.monitorsList.appendChild(el);
    });
}

function renderImages() {
    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;

    if (appState.mode === 'trash') {
        renderBlocklistView();
        return;
    }

    if (appState.images.length === 0) {
        els.wallpaperGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
                <p>No wallpapers in ${esc(appState.mode)} / ${esc(appState.purity)}</p>
            </div>
        `;
        return;
    }

    renderNextBatch();
    setTimeout(updateGridMetrics, 100);
}

function renderBlocklistView() {
    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;

    const bl = appState.blocklistData || { entries: [], total: 0, recoverable_count: 0 };
    const recoverableCount = appState.images.length;
    const blockedCount = bl.total;

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

    if (appState.blocklistTab === 'recoverable') {
        if (appState.images.length === 0) {
            els.wallpaperGrid.innerHTML += `
                <div class="empty-state">
                    <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div>
                    <p>No recoverable images in trash</p>
                </div>
            `;
            return;
        }
        renderNextBatch();
        setTimeout(updateGridMetrics, 100);
    } else {
        renderBlockedList(bl.entries);
    }
}

function renderBlockedList(entries) {
    if (entries.length === 0) {
        els.wallpaperGrid.innerHTML += `
            <div class="empty-state">
                <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
                <p>No blocked images</p>
            </div>
        `;
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
    if (appState.currentBatchIndex >= appState.images.length) return;

    const start = appState.currentBatchIndex;
    const end = Math.min(start + appState.batchSize, appState.images.length);
    const batch = appState.images.slice(start, end);

    if (sentinel.parentNode) sentinel.remove();

    const fragment = document.createDocumentFragment();
    batch.forEach(img => {
        fragment.appendChild(createCard(img));
    });

    els.wallpaperGrid.appendChild(fragment);
    appState.currentBatchIndex = end;

    if (appState.currentBatchIndex < appState.images.length) {
        els.wallpaperGrid.appendChild(sentinel);
        observer.observe(sentinel);
    } else {
        observer.unobserve(sentinel);
    }
}

function imageUrl(path) {
    if (path.startsWith('__trash/')) {
        return `${API_URL}/trash/${encodeURIComponent(path.slice(8))}`;
    }
    return `${API_URL}/images/${encodeURI(path)}`;
}

function createCard(img) {
    const card = document.createElement('div');
    card.className = 'wallpaper-card';
    card.dataset.path = img.path;
    card.tabIndex = 0; // Make focusable

    if (img.path.includes('/portrait/')) {
        card.classList.add('portrait');
    }

    const imgUrl = imageUrl(img.path);

    if (appState.mode === 'trash') {
        card.innerHTML = `
            <img class="loading" src="${imgUrl}" loading="lazy" alt="${esc(img.name)}">
            <div class="overlay">
                <button class="action-btn restore" title="Restore to Pool">${ICONS.restore()}</button>
                <button class="action-btn url" title="Open on Wallhaven">${ICONS.externalLink()}</button>
            </div>
        `;
        const cardImg = card.querySelector('img');
        cardImg.onload = () => cardImg.classList.remove('loading');
        const btns = card.querySelectorAll('button');
        btns[0].onclick = (e) => { e.stopPropagation(); restoreImage(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); openWallhavenUrl(img.name); };
        card.onclick = () => showLightbox(img);
    } else {
        card.innerHTML = `
            <img class="loading" src="${imgUrl}" loading="lazy" alt="${esc(img.name)}">
            <div class="overlay">
                <button class="action-btn" title="Set Wallpaper">${ICONS.setWallpaper()}</button>
                <button class="action-btn fav ${img.is_favorite ? 'active' : ''}" title="Favorite">${ICONS.favorite(16, img.is_favorite)}</button>
                <button class="action-btn dislike" title="Dislike">${ICONS.dislike()}</button>
                <button class="action-btn url" title="Open on Wallhaven">${ICONS.externalLink()}</button>
            </div>
        `;
        const cardImg = card.querySelector('img');
        cardImg.onload = () => cardImg.classList.remove('loading');
        card.onclick = () => showLightbox(img);
        const btns = card.querySelectorAll('button');
        btns[0].onclick = (e) => { e.stopPropagation(); setWallpaper(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); toggleFavoriteImage(img.path); };
        btns[2].onclick = (e) => { e.stopPropagation(); dislikeImage(img.path); };
        btns[3].onclick = (e) => { e.stopPropagation(); openWallhavenUrl(img.name); };
    }

    return card;
}

// --- Lightbox ---

let lightboxEl = null;
let lightboxImg = null;

function showLightbox(img) {
    lightboxImg = img;
    const isTrash = appState.mode === 'trash';

    // If lightbox already exists, just swap the image (avoids DOM thrashing)
    if (lightboxEl) {
        lightboxEl.querySelector('.lightbox-image').src = imageUrl(img.path);
        return;
    }

    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.innerHTML = `
        <div class="lightbox-backdrop"></div>
        <img class="lightbox-image" src="${imageUrl(img.path)}" alt="">
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
                <button class="lb-btn" data-action="dislike" title="Dislike (X)">
                    ${ICONS.dislike(18)}<span>Dislike</span><kbd>X</kbd>
                </button>
            `}
            <div class="lb-spacer"></div>
            <button class="lb-btn" data-action="url" title="Open on Wallhaven (O)">
                ${ICONS.externalLink(18)}<span>Wallhaven</span><kbd>O</kbd>
            </button>
        </div>
        <button class="lightbox-close" title="Close (Esc)">${ICONS.dislike(20)}</button>
        <button class="lightbox-nav prev" title="Previous image">${ICONS.chevronLeft()}</button>
        <button class="lightbox-nav next" title="Next image">${ICONS.chevronRight()}</button>
    `;

    document.body.appendChild(lightboxEl);
    requestAnimationFrame(() => lightboxEl.classList.add('visible'));

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
            else if (action === 'dislike') { dislikeImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'restore') { restoreImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'url') { openWallhavenUrl(lightboxImg.name); }
        };
    });
}

function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('visible');
    setTimeout(() => {
        if (lightboxEl) { lightboxEl.remove(); lightboxEl = null; lightboxImg = null; }
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
