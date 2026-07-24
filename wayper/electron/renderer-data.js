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
    document.getElementById('input-download-dir').value = c.download_dir || '';

    // Wallhaven
    document.getElementById('input-categories').value = w.categories;
    document.getElementById('input-top-range').value = w.top_range;
    document.getElementById('input-sorting').value = w.sorting;
    document.getElementById('input-ai-art').value = w.ai_art_filter;
    document.getElementById('input-batch-size').value = w.batch_size ?? 5;
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

function invalidateBlocklistSuggestions({ keepVisible = false } = {}) {
    const canKeepVisible = keepVisible && blocklistSuggestionsAreCurrent();
    appState.tagSuggestionsGeneration++;
    if (canKeepVisible) return;
    appState.tagSuggestionsKey = null;
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

async function fetchPreferenceSuggestions({ orient = appState.currentOrient, requestId = null } = {}) {
    const preferenceRequestId = ++appState.preferenceSuggestionRequestId;
    const purities = [...appState.purity];
    try {
        const data = await WayperApi.preferenceSuggestions(
            purities,
            orient,
            PREFERENCE_REVIEW_LIMIT,
        );
        if (
            preferenceRequestId !== appState.preferenceSuggestionRequestId
            || appState.mode !== 'trash'
            || (requestId !== null && requestId !== appState.imageRequestId)
        ) {
            return false;
        }
        appState.preferenceSuggestions = data;
        return true;
    } catch (e) {
        if (
            preferenceRequestId === appState.preferenceSuggestionRequestId
            && appState.mode === 'trash'
            && (requestId === null || requestId === appState.imageRequestId)
        ) {
            appState.preferenceSuggestions = null;
        }
        console.error('Failed to fetch model review suggestions:', e);
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
        download_dir: document.getElementById('input-download-dir').value.trim(),
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
        batch_size: Math.max(1, parseInt(document.getElementById('input-batch-size').value) || 5),
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
        await Promise.all([fetchStatus(), fetchDiskUsage(), refreshImages()]);
    } catch (e) {
        console.error("Failed to save settings", e);
        alert(`Failed to save settings: ${e.message}`);
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

async function banImage(
    path,
    {
        preserveView = false,
        preferenceContext = null,
        refreshSuggestionsInPlace = false,
    } = {},
) {
    // Model-review bans change the exclusion evidence, but removing the existing
    // bar while the request is in flight causes a large, unnecessary layout jump.
    // Keep the current bar visible and replace it only after fresh data arrives.
    invalidateBlocklistSuggestions({ keepVisible: refreshSuggestionsInPlace });
    removeImageFromState(path, { renderEmpty: !preserveView });
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
            body: JSON.stringify({
                image_path: path,
                ...(preferenceContext ? { preference_context: preferenceContext } : {}),
            })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        applyMonitorCurrentImages(data.replacement_images);
        if (refreshSuggestionsInPlace && appState.mode === 'trash') {
            // Supersede any refresh started by an earlier concurrent review action.
            invalidateBlocklistSuggestions({ keepVisible: true });
            void fetchTagSuggestions({ render: true });
        }
        return true;
    } catch (e) {
        console.error("Ban failed", e);
        refreshImages();
        return false;
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
const pendingUnblocks = new Set();

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
    const previousEntries = appState.blocklistData?.entries;
    const preservePager = appState.blocklistPager.tab === 'blocked'
        && appState.blocklistPager.sourceEntries === previousEntries
        && appState.blocklistPager.searchMatches === appState.searchMatches
        && appState.blocklistTab === 'blocked';
    try {
        const res = await fetch(`${API_URL}/api/blocklist`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        data.entries = Array.isArray(data.entries) ? data.entries : [];
        appState.blocklistData = data;
        if (preservePager) {
            WayperBlocklistPager.replaceSource(
                appState.blocklistPager,
                data.entries,
                data.entries.length,
            );
        }
        return appState.blocklistData;
    } catch (e) {
        console.error("Failed to fetch blocklist", e);
        appState.blocklistData = { entries: [], total: 0, recoverable_count: 0, images: [] };
        return appState.blocklistData;
    }
}

async function unblockImage(filename) {
    if (pendingUnblocks.has(filename)) return;
    pendingUnblocks.add(filename);
    try {
        const res = await fetch(`${API_URL}/api/blocklist/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (!result.removed) return;

        invalidateBlocklistSuggestions();
        // Remove from local state
        if (appState.blocklistData) {
            const previousEntries = appState.blocklistData.entries;
            const entries = previousEntries.filter(e => e.filename !== filename);
            appState.blocklistData.entries = entries;
            appState.blocklistData.total = entries.length;
            // Keep the user's place in a paged All Blocked list and let the next
            // hidden entry fill the removed row.
            if (appState.blocklistPager.sourceEntries === previousEntries) {
                WayperBlocklistPager.replaceSource(
                    appState.blocklistPager,
                    entries,
                    entries.length,
                );
            }
        }
        renderBlocklistView();
        if (appState.searchMatches) updateSearchCount();
        if (appState.status?.blocklist_count !== undefined) {
            appState.status.blocklist_count = appState.blocklistData?.total
                ?? Math.max(0, appState.status.blocklist_count - 1);
            updateStatusUI();
        }
    } catch (e) {
        console.error("Unblock failed", e);
    } finally {
        pendingUnblocks.delete(filename);
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

function removeImageFromState(path, { renderEmpty = true } = {}) {
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

    const card = [...document.querySelectorAll('.wallpaper-card')]
        .find(el => el.dataset.path === path);
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

    if (renderEmpty && appState.images.length === 0) {
        renderImages(); // Show empty state
    }
}

// --- Data Fetching ---

function dismissedUpdateVersion() {
    try {
        return window.localStorage.getItem('wayper.dismissedUpdateVersion');
    } catch {
        return null;
    }
}

function dismissUpdateBanner(version) {
    if (version) {
        try {
            window.localStorage.setItem('wayper.dismissedUpdateVersion', version);
        } catch { }
    }
    els.updateBannerRoot.classList.add('hidden');
    els.updateBannerRoot.innerHTML = '';
}

function renderUpdateBanner(info) {
    if (!els.updateBannerRoot) return;
    if (!info?.update_available || !info.latest_version) {
        els.updateBannerRoot.classList.add('hidden');
        els.updateBannerRoot.innerHTML = '';
        return;
    }
    if (dismissedUpdateVersion() === info.latest_version) return;

    els.updateBannerRoot.innerHTML = `
        <div class="update-banner">
            <span class="update-banner-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </span>
            <span class="update-banner-text">
                <strong>Wayper ${esc(info.latest_version)}</strong> is available. Current version: ${esc(info.current_version)}.
            </span>
            <span class="update-banner-actions">
                <button class="update-banner-open" type="button">Get Update</button>
                <button class="update-banner-close" type="button" title="Dismiss">&times;</button>
            </span>
        </div>
    `;
    els.updateBannerRoot.classList.remove('hidden');
    els.updateBannerRoot.querySelector('.update-banner-open').onclick = () => {
        window.open(info.release_url || 'https://github.com/yuukidach/wayper/releases/latest', '_blank');
    };
    els.updateBannerRoot.querySelector('.update-banner-close').onclick = () => {
        dismissUpdateBanner(info.latest_version);
    };
}

async function checkForAppUpdates(force = false) {
    try {
        const data = await WayperApi.updateCheck(force);
        appState.updateInfo = data;
        renderUpdateBanner(data);
    } catch (e) {
        console.error('Update check failed:', e);
    }
}

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
        // Never leave candidates from a previous monitor/purity filter actionable while
        // the matching model-review request is in flight.
        appState.preferenceSuggestions = null;
        els.wallpaperGrid.querySelector('.model-review-panel')?.remove();
        const suggestionsPromise = fetchTagSuggestions({ render: true, requestId });
        const preferenceSuggestionsPromise = fetchPreferenceSuggestions({ orient, requestId });
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
                preferenceSuggestionsPromise.then(updated => {
                    if (updated && requestId === appState.imageRequestId && appState.mode === 'trash') {
                        renderBlocklistView();
                    }
                });
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
