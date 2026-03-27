const API_URL = 'http://127.0.0.1:8080';

// State
let appState = {
    mode: 'pool', // pool, favorites
    purity: 'sfw', // sfw, nsfw
    monitors: [],
    selectedMonitor: null, // monitor name
    status: { running: false, pid: null },
    images: [],
    config: null, // Full config object
    view: 'grid', // grid, settings

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

    btnSfw: document.getElementById('btn-sfw'),
    btnNsfw: document.getElementById('btn-nsfw'),

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

    // Poll status
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

    // Sidebar: Mode
    els.btnSfw.onclick = () => setPurity('sfw');
    els.btnNsfw.onclick = () => setPurity('nsfw');

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

    // Check if a card is focused
    const focusedCard = document.activeElement && document.activeElement.classList.contains('wallpaper-card') ? document.activeElement : null;

    switch(e.key) {
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
        case 'z':
            undoDislike();
            break;
        case 'm':
            const nextMode = appState.purity === 'sfw' ? 'nsfw' : 'sfw';
            setPurity(nextMode);
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
        case 'Enter':
            if (focusedCard) {
                setWallpaper(focusedCard.dataset.path);
            } else {
                controlAction('next'); // Space/Enter usually means next
            }
            break;
        case ' ':
            e.preventDefault();
            if (focusedCard) {
                setWallpaper(focusedCard.dataset.path);
            } else {
                controlAction('next');
            }
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
        cards[nextIndex].focus();
        cards[nextIndex].scrollIntoView({ block: 'nearest' });
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
            method: 'POST'
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

async function setPurity(purity) {
    appState.purity = purity;

    // Also update server config
    try {
        await fetch(`${API_URL}/api/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: purity })
        });
    } catch (e) {
        console.error("Failed to set mode", e);
    }

    updateUI();
    refreshImages();
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

        // data.mode is 'sfw' or 'nsfw' (purity)
        appState.purity = data.mode;
        // interval_min is in data, used for settings

        updateUI();
    } catch (e) { console.error(e); }
}

async function fetchStatus() {
    try {
        const res = await fetch(`${API_URL}/api/status`);
        const data = await res.json();
        appState.status = data;

        // Check for external mode change (e.g. via CLI)
        if (data.mode && data.mode !== appState.purity) {
             console.log(`Mode changed externally: ${appState.purity} -> ${data.mode}`);
             appState.purity = data.mode;
             updateUI();
             refreshImages();
        }

        updateStatusUI();
    } catch (e) {
        appState.status = { running: false };
        updateStatusUI();
        console.error("Fetch status failed:", e);
        // Show error in tooltip or status text
        els.daemonStatus.title = e.message;
    }
}

async function fetchDiskUsage() {
    try {
        const res = await fetch(`${API_URL}/api/disk`);
        const data = await res.json();
        els.diskUsage.innerText = `${data.used_mb} / ${data.quota_mb} MB`;
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

    try {
        const url = `${API_URL}/api/images?mode=${appState.mode}&purity=${appState.purity}&orient=${orient}`;
        const res = await fetch(url);
        appState.images = await res.json();
        renderImages();
    } catch (e) { console.error(e); }
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

    // Purity
    if (appState.purity === 'sfw') {
        els.btnSfw.classList.add('primary');
        els.btnNsfw.classList.remove('primary');
    } else {
        els.btnSfw.classList.remove('primary');
        els.btnNsfw.classList.add('primary');
    }
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
        const icon = isLandscape ? '🖥️' : '📱';
        const key = index + 4;
        const shortcut = key <= 9 ? `<kbd>${key}</kbd>` : '';

        el.innerHTML = `
            <h4>${icon} ${m.name} ${shortcut}</h4>
            <p>${m.orientation} • ${m.current_image ? 'Has Wallpaper' : 'Empty'}</p>
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

    if (appState.images.length === 0) {
        els.wallpaperGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🏜️</div>
                <p>No wallpapers found in ${appState.mode} / ${appState.purity}.</p>
            </div>
        `;
        return;
    }

    renderNextBatch();
    setTimeout(updateGridMetrics, 100);
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

function createCard(img) {
    const card = document.createElement('div');
    card.className = 'wallpaper-card';
    card.dataset.path = img.path;
    card.tabIndex = 0; // Make focusable

    if (img.path.includes('/portrait/')) {
        card.classList.add('portrait');
    }

    const imgUrl = `${API_URL}/images/${img.path}`;

    if (appState.mode === 'trash') {
        card.innerHTML = `
            <img src="${imgUrl}" loading="lazy" alt="${img.name}">
            <div class="overlay">
                <button class="action-btn restore" title="Restore to Pool">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                         <path d="M3 7v6h6"></path>
                         <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
                    </svg>
                </button>
            </div>
        `;
        const btn = card.querySelector('button');
        btn.onclick = (e) => { e.stopPropagation(); restoreImage(img.path); };
    } else {
        card.innerHTML = `
            <img src="${imgUrl}" loading="lazy" alt="${img.name}">
            <div class="overlay">
                <button class="action-btn" title="Set Wallpaper">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                </button>
                <button class="action-btn fav ${img.is_favorite ? 'active' : ''}" title="Favorite">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${img.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
                <button class="action-btn dislike" title="Dislike">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        // Click on card -> Set wallpaper
        card.onclick = () => setWallpaper(img.path);

        // Buttons
        const btns = card.querySelectorAll('button');
        btns[0].onclick = (e) => { e.stopPropagation(); setWallpaper(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); toggleFavoriteImage(img.path); };
        btns[2].onclick = (e) => { e.stopPropagation(); dislikeImage(img.path); };
    }

    return card;
}
