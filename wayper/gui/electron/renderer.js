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
    view: 'grid' // grid, settings
};

// DOM Elements
const els = {
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnFav: document.getElementById('btn-fav-current'),
    btnDislike: document.getElementById('btn-dislike-current'),

    btnPool: document.getElementById('btn-pool'),
    btnFavorites: document.getElementById('btn-favorites'),

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
};

// Init
document.addEventListener('DOMContentLoaded', init);

async function init() {
    setupEventListeners();
    await fetchConfig(); // to get initial mode & settings
    await fetchMonitors();
    await fetchStatus();
    await fetchDiskUsage();
    await refreshImages();

    // Poll status
    setInterval(fetchStatus, 3000);
    setInterval(fetchDiskUsage, 30000);
}

function setupEventListeners() {
    // Top Controls
    els.btnPrev.onclick = () => controlAction('prev');
    els.btnNext.onclick = () => controlAction('next');
    els.btnFav.onclick = () => controlAction('fav');
    els.btnDislike.onclick = () => controlAction('dislike');

    // Sidebar: Library
    els.btnPool.onclick = () => setViewMode('pool');
    els.btnFavorites.onclick = () => setViewMode('favorites');

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

    switch(e.key) {
        case 'ArrowRight':
        case 'l':
            controlAction('next');
            break;
        case 'ArrowLeft':
        case 'h':
            controlAction('prev');
            break;
        case 'f':
            controlAction('fav');
            break;
        case 'd':
            controlAction('dislike');
            break;
        case '1':
            setViewMode('pool');
            break;
        case '2':
            setViewMode('favorites');
            break;
        case ' ':
            e.preventDefault();
            controlAction('next');
            break;
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
    }
}

async function toggleFavoriteImage(path) {
    try {
        await fetch(`${API_URL}/api/image/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: path })
        });
        refreshImages();
    } catch (e) {
        console.error("Favorite toggle failed", e);
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
        updateStatusUI();
    } catch (e) {
        appState.status = { running: false };
        updateStatusUI();
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
    if (appState.mode === 'pool') {
        els.btnPool.classList.add('active');
        els.btnFavorites.classList.remove('active');
    } else {
        els.btnPool.classList.remove('active');
        els.btnFavorites.classList.add('active');
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

function renderMonitors() {
    els.monitorsList.innerHTML = '';

    appState.monitors.forEach(m => {
        const el = document.createElement('div');
        el.className = `monitor-item ${m.name === appState.selectedMonitor ? 'active' : ''}`;

        const isLandscape = m.orientation === 'landscape';
        const icon = isLandscape ? '🖥️' : '📱';

        el.innerHTML = `
            <h4>${icon} ${m.name}</h4>
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

    if (appState.images.length === 0) {
        els.wallpaperGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🏜️</div>
                <p>No wallpapers found in ${appState.mode} / ${appState.purity}.</p>
            </div>
        `;
        return;
    }

    appState.images.forEach(img => {
        const card = document.createElement('div');
        card.className = 'wallpaper-card';
        card.dataset.path = img.path;

        if (img.path.includes('/portrait/')) {
            card.classList.add('portrait');
        }

        const imgUrl = `${API_URL}/images/${img.path}`;

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
            </div>
        `;

        // Click on card -> Set wallpaper
        card.onclick = () => setWallpaper(img.path);

        // Buttons
        const btns = card.querySelectorAll('button');
        btns[0].onclick = (e) => { e.stopPropagation(); setWallpaper(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); toggleFavoriteImage(img.path); };

        els.wallpaperGrid.appendChild(card);
    });
}
