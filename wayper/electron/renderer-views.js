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

function setupBlocklistInfiniteScroll() {
    blocklistSentinel = document.createElement('div');
    blocklistSentinel.className = 'blocklist-scroll-sentinel';
    blocklistSentinel.setAttribute('aria-hidden', 'true');

    blocklistObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            loadMoreBlockedEntries();
        }
    }, {
        root: null,
        rootMargin: '600px',
        threshold: 0.01,
    });
}

function removeBlocklistSentinel() {
    if (!blocklistSentinel) return;
    blocklistObserver?.unobserve(blocklistSentinel);
    blocklistSentinel.remove();
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

    removeBlocklistSentinel();
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

function suggestionEvidence(item) {
    const stats = item?.stats || item || {};
    const banned = stats.banned ?? stats.ban_count ?? item?.count ?? 0;
    const kept = stats.kept ?? stats.kept_count ?? 0;
    const favorites = stats.favorites ?? stats.fav_count ?? 0;
    return `${banned}/${kept}/${favorites}`;
}

function createSuggestionChip({ type, label, title, onClick, evidence }) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `suggestion-chip${type === 'combo' ? ' combo-chip' : ''}`;
    chip.title = title;
    chip.setAttribute('aria-label', title);
    chip.onclick = onClick;
    chip.appendChild(createTypeBadge(type));

    const name = document.createElement('span');
    name.className = 'suggestion-chip-name';
    name.textContent = label;
    chip.appendChild(name);

    const count = document.createElement('span');
    count.className = 'suggestion-chip-count';
    count.textContent = evidence;
    count.title = 'Banned / kept / favorites';
    chip.appendChild(count);
    return chip;
}

function createSuggestionGroup({ type, label, items, createChip }) {
    if (!items.length) return null;

    const group = document.createElement('section');
    group.className = `suggestion-group suggestion-group-${type}`;

    const heading = document.createElement('div');
    heading.className = 'suggestion-group-heading';
    const groupLabel = document.createElement('span');
    groupLabel.className = 'suggestion-group-label';
    groupLabel.textContent = label;
    heading.appendChild(groupLabel);
    const groupCount = document.createElement('span');
    groupCount.className = 'suggestion-group-count';
    groupCount.textContent = `${items.length} ${type}${items.length === 1 ? '' : 's'}`;
    heading.appendChild(groupCount);
    group.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'suggestion-chip-grid';
    for (const item of items) grid.appendChild(createChip(item));
    group.appendChild(grid);
    return group;
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
    const title = document.createElement('div');
    title.className = 'suggestion-bar-title';
    const label = document.createElement('span');
    label.className = 'suggestion-bar-label';
    label.textContent = 'Suggested exclusions';
    title.appendChild(label);
    const subtitle = document.createElement('span');
    subtitle.className = 'suggestion-bar-subtitle';
    subtitle.textContent = 'Click a signal to review matching wallpapers';
    title.appendChild(subtitle);
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'suggestion-bar-meta';
    const legend = document.createElement('span');
    legend.className = 'suggestion-evidence-legend';
    legend.textContent = 'B/K/F';
    legend.title = 'Counts are Banned / Kept / Favorites';
    meta.appendChild(legend);

    const aiBtn = document.createElement('button');
    aiBtn.className = 'agent-analyze-btn';
    aiBtn.type = 'button';
    aiBtn.setAttribute('aria-label', 'Analyze exclusions with Codex');
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
        btnLabel.textContent = 'Codex';
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
    meta.appendChild(aiBtn);
    header.appendChild(meta);
    bar.appendChild(header);

    const tagGroup = createSuggestionGroup({
        type: 'tag',
        label: 'Tags',
        items: tagSuggestions,
        createChip: suggestion => createSuggestionChip({
            type: 'tag',
            label: suggestion.tag,
            title: `Review "${suggestion.tag}" in blocklist — banned / kept / favorites`,
            onClick: () => enterTagReview(suggestion.tag),
            evidence: suggestionEvidence(suggestion),
        }),
    });
    if (tagGroup) bar.appendChild(tagGroup);

    const comboGroup = createSuggestionGroup({
        type: 'combo',
        label: 'Combos',
        items: comboSuggestions,
        createChip: suggestion => {
            const label = suggestion.tags.join(' + ');
            return createSuggestionChip({
                type: 'combo',
                label,
                title: `Review combo "${label}" — ${Math.round(suggestion.precision * 100)}% precision — banned / kept / favorites`,
                onClick: () => enterTagReview([...suggestion.tags]),
                evidence: suggestionEvidence(suggestion),
            });
        },
    });
    if (comboGroup) bar.appendChild(comboGroup);

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

function preferenceReviewItems() {
    const items = appState.preferenceSuggestions?.items;
    if (!Array.isArray(items)) return [];
    return items.filter(item => item && typeof item.path === 'string' && item.path);
}

function preferenceEvidence(contributions, direction) {
    if (!Array.isArray(contributions)) return [];
    const evidence = [];
    const seen = new Set();
    for (const contribution of contributions) {
        const feature = typeof contribution === 'string'
            ? contribution
            : String(contribution?.feature || '');
        if (!feature || seen.has(feature)) continue;
        const weight = Number(contribution?.weight);
        const actualDirection = typeof contribution === 'string'
            ? 'dislike'
            : (
                contribution?.direction === 'dislike'
                || (Number.isFinite(weight) && weight > 0)
                    ? 'dislike'
                    : 'keep'
            );
        if (actualDirection !== direction) continue;
        seen.add(feature);
        evidence.push({ feature, contribution });
    }
    return evidence;
}

function formatPreferenceScore(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return '—';
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatPreferenceRank(item) {
    const rank = Number(item?.rank);
    const percentile = Number(item?.percentile);
    if (Number.isFinite(rank) && Number.isFinite(percentile)) {
        return `#${Math.max(1, Math.round(rank))} · ${percentile.toFixed(1)}% pool`;
    }
    if (Number.isFinite(rank)) return `#${Math.max(1, Math.round(rank))}`;
    return 'Ranked candidate';
}

function preferenceLearningText(learning) {
    if (!learning || typeof learning !== 'object') return '';
    const pending = Number(learning.pending_feedback);
    const minimum = Number(learning.minimum_feedback);
    const messages = [];
    if (Number.isFinite(pending) && pending > 0) {
        if (Number.isFinite(minimum) && minimum > 0) {
            messages.push(`${pending}/${minimum} feedback pending`);
        } else {
            messages.push(`${pending} feedback pending`);
        }
    }
    if (learning.stale) {
        messages.push('model update pending');
    } else if (learning.due) {
        messages.push('model refresh due');
    }
    return messages.join(' · ');
}

function removePreferenceSuggestion(path) {
    const data = appState.preferenceSuggestions;
    if (!data || !Array.isArray(data.items)) return;
    appState.preferenceSuggestions = {
        ...data,
        items: data.items.filter(item => item?.path !== path),
    };
}

function preferenceReviewRow(path) {
    return [...document.querySelectorAll('.model-review-row')]
        .find(row => row.dataset.path === path) || null;
}

function preferenceReviewCountText(count) {
    return `${count} candidate${count === 1 ? '' : 's'}`;
}

function refreshPreferenceSuggestionDiagnostics() {
    const data = appState.preferenceSuggestions;
    if (!data || typeof data !== 'object') return;
    const items = preferenceReviewItems();
    const diagnostics = data.diagnostics && typeof data.diagnostics === 'object'
        ? data.diagnostics
        : {};
    const bestFeatureScore = items.reduce((best, item) => {
        const score = Number(item?.feature_score);
        return Number.isFinite(score) ? Math.max(best, score) : best;
    }, 0);
    appState.preferenceSuggestions = {
        ...data,
        diagnostics: {
            ...diagnostics,
            candidate_count: items.length,
            best_feature_score: items.length ? bestFeatureScore : null,
        },
    };
}

function preferenceReviewEmptyText(data) {
    const diagnostics = data?.diagnostics || {};
    const bestFeatureScore = Number(diagnostics.best_feature_score);
    const bestLabel = Number.isFinite(bestFeatureScore)
        ? formatPreferenceScore(bestFeatureScore)
        : null;
    if (data?.status === 'untrained') {
        return 'Train a local preference model to start reviewing candidates.';
    }
    if (data?.status === 'upgrade_pending') {
        return 'Updating the local ranking model; review will appear shortly.';
    }
    if (bestLabel) {
        return `No net dislike-evidence candidates; strongest feature score ${bestLabel}.`;
    }
    return 'No net dislike-evidence candidates for this monitor and purity.';
}

function updatePreferenceReviewPanelAfterRemoval(path) {
    const row = preferenceReviewRow(path);
    const panel = row?.closest('.model-review-panel');
    if (!row || !panel) return;

    row.remove();
    const remaining = preferenceReviewItems().length;
    const count = panel.querySelector('.model-review-count');
    if (count) count.textContent = preferenceReviewCountText(remaining);

    if (remaining > 0) return;
    panel.querySelector('.model-review-list')?.remove();
    panel.querySelector('.model-review-empty')?.remove();
    const empty = document.createElement('p');
    empty.className = 'model-review-empty';
    empty.textContent = preferenceReviewEmptyText(appState.preferenceSuggestions || {});
    panel.appendChild(empty);
}

function updateBlocklistTabCounts() {
    const tabs = els.wallpaperGrid.querySelector('.blocklist-tabs');
    if (!tabs) return;
    const counts = tabs.querySelectorAll('.tab-count');
    if (counts.length < 2) return;

    const matchesSearch = filename => (
        !appState.searchMatches || appState.searchMatches.has(filename)
    );
    const blocklist = appState.blocklistData || {};
    const recoverableCount = appState.searchMatches
        ? appState.images.length
        : Number.isFinite(Number(blocklist.recoverable_count))
            ? Number(blocklist.recoverable_count)
            : appState.images.length;
    const blockedCount = (Array.isArray(blocklist.entries) ? blocklist.entries : [])
        .filter(entry => matchesSearch(entry.filename)).length;
    counts[0].textContent = recoverableCount;
    counts[1].textContent = blockedCount;
}

function updateBlocklistStateAfterBan(item) {
    const filename = String(item?.name || item?.path || '').split('/').pop();
    if (!filename || !appState.blocklistData) return;

    const entries = Array.isArray(appState.blocklistData.entries)
        ? appState.blocklistData.entries
        : [];
    if (!entries.some(entry => entry.filename === filename)) {
        appState.blocklistData.entries = [
            {
                filename,
                timestamp: Math.floor(Date.now() / 1000),
                recoverable: true,
            },
            ...entries,
        ];
        appState.blocklistData.total = appState.blocklistData.entries.length;
        appState.blocklistData.recoverable_count = (
            Number(appState.blocklistData.recoverable_count) || 0
        ) + 1;
    }
    updateBlocklistTabCounts();
    updateSearchCount();
}

function setPreferenceReviewActionBusy(row, busy) {
    if (!row) return;
    row.classList.toggle('is-busy', busy);
    for (const button of row.querySelectorAll('button')) {
        button.disabled = busy;
    }
}

function previewPreferenceSuggestion(item, event) {
    event?.preventDefault();
    event?.stopPropagation();
    // Model candidates are live pool images even while the surrounding view is Trash.
    // Review mode exposes deliberate Keep/K and Ban/X actions plus the Wallhaven link;
    // it never exposes Set, Favorite, Restore, or gallery navigation.
    showLightbox({ ...item, isTrash: false, reviewOnly: true });
}

function preserveModelReviewButtonKeyboard(event) {
    if (event.key === 'Enter' || event.key === ' ') {
        // The gallery's global shortcuts must not consume native button activation.
        event.stopPropagation();
    }
}

async function keepPreferenceSuggestion(item, row) {
    setPreferenceReviewActionBusy(row, true);
    try {
        const result = await WayperApi.preferenceFeedback(item.path, 'keep');
        if (result?.learning && appState.preferenceSuggestions) {
            appState.preferenceSuggestions.learning = result.learning;
        }
        removePreferenceSuggestion(item.path);
        refreshPreferenceSuggestionDiagnostics();
        // Keeping a model-review candidate only changes the local preference
        // ledger.  It is still a live pool image, so the blocklist image list,
        // counts, and pagination do not need a full refresh.
        updatePreferenceReviewPanelAfterRemoval(item.path);
        return true;
    } catch (e) {
        console.error('Failed to record model review feedback:', e);
        alert(`Could not keep ${item.name || 'this wallpaper'}: ${e.message}`);
        return false;
    } finally {
        setPreferenceReviewActionBusy(row, false);
    }
}

const preferenceKeepInFlight = new Set();
const preferenceBanInFlight = new Set();

async function keepLightboxReviewSuggestion() {
    const image = lightboxImg;
    if (!image?.reviewOnly || preferenceKeepInFlight.has(image.path)) return false;
    preferenceKeepInFlight.add(image.path);
    const item = preferenceReviewItems().find(candidate => candidate.path === image.path) || image;
    const row = preferenceReviewRow(item.path);
    try {
        const kept = await keepPreferenceSuggestion(item, row);
        if (kept && lightboxImg === image) closeLightbox();
        return kept;
    } finally {
        preferenceKeepInFlight.delete(image.path);
    }
}

async function banPreferenceSuggestion(item, row) {
    if (!item?.path || preferenceBanInFlight.has(item.path)) return false;
    preferenceBanInFlight.add(item.path);
    setPreferenceReviewActionBusy(row, true);
    try {
        // Keep all ban behavior (including trash and replacement wallpaper handling) in one path.
        // Suppress the empty-grid fallback here: the review panel is a separate live
        // surface and should lose one row, not rebuild the entire Blocklist view.
        const banned = await banImage(item.path, {
            preserveView: true,
            preferenceContext: 'model_review',
            refreshSuggestionsInPlace: true,
        });
        if (!banned) return false;
        removePreferenceSuggestion(item.path);
        refreshPreferenceSuggestionDiagnostics();
        updateBlocklistStateAfterBan(item);
        updatePreferenceReviewPanelAfterRemoval(item.path);
        return true;
    } catch (e) {
        console.error('Failed to ban model review suggestion:', e);
        return false;
    } finally {
        setPreferenceReviewActionBusy(row, false);
        preferenceBanInFlight.delete(item.path);
    }
}

async function banLightboxReviewSuggestion() {
    const image = lightboxImg;
    if (!image?.reviewOnly || preferenceBanInFlight.has(image.path)) return false;
    const item = preferenceReviewItems().find(candidate => candidate.path === image.path) || image;
    const row = preferenceReviewRow(item.path);
    // Closing the preview is immediate UI feedback; the underlying review row
    // stays busy until the filesystem/API transaction finishes.
    const pendingBan = banPreferenceSuggestion(item, row);
    closeLightbox();
    return pendingBan;
}

function createPreferenceReviewPanel() {
    const data = appState.preferenceSuggestions;
    if (!data || typeof data !== 'object') return null;

    const panel = document.createElement('section');
    panel.className = 'model-review-panel';
    panel.setAttribute('aria-label', 'Model review');

    const header = document.createElement('div');
    header.className = 'model-review-header';
    const heading = document.createElement('div');
    heading.className = 'model-review-heading';
    const title = document.createElement('span');
    title.className = 'model-review-title';
    title.textContent = 'Model review';
    heading.appendChild(title);
    const subtitle = document.createElement('span');
    subtitle.className = 'model-review-subtitle';
    subtitle.textContent = 'Ranked by local tag/context evidence';
    heading.appendChild(subtitle);
    const count = document.createElement('span');
    count.className = 'model-review-count';
    count.textContent = preferenceReviewCountText(preferenceReviewItems().length);
    heading.appendChild(count);
    header.appendChild(heading);

    const learningText = preferenceLearningText(data.learning);
    if (learningText) {
        const learning = document.createElement('span');
        learning.className = 'model-review-learning';
        learning.textContent = learningText;
        header.appendChild(learning);
    }
    panel.appendChild(header);

    const items = preferenceReviewItems();
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'model-review-empty';
        empty.textContent = preferenceReviewEmptyText(data);
        panel.appendChild(empty);
        return panel;
    }

    const list = document.createElement('div');
    list.className = 'model-review-list';
    for (const item of items) {
        const row = document.createElement('article');
        row.className = 'model-review-row';
        row.dataset.path = item.path;

        const thumbnailButton = document.createElement('button');
        thumbnailButton.className = 'model-review-thumbnail-button';
        thumbnailButton.type = 'button';
        thumbnailButton.title = `Preview ${item.name || 'wallpaper'}`;
        thumbnailButton.setAttribute(
            'aria-label',
            `Preview ${item.name || 'wallpaper'} full image`,
        );
        thumbnailButton.onclick = event => previewPreferenceSuggestion(item, event);
        thumbnailButton.onkeydown = preserveModelReviewButtonKeyboard;

        const thumbnail = document.createElement('img');
        thumbnail.className = 'model-review-thumbnail';
        thumbnail.src = thumbnailUrl(item.path);
        thumbnail.loading = 'lazy';
        thumbnail.decoding = 'async';
        thumbnail.alt = '';
        thumbnail.onerror = () => thumbnail.classList.add('missing');
        thumbnailButton.appendChild(thumbnail);
        row.appendChild(thumbnailButton);

        const body = document.createElement('div');
        body.className = 'model-review-body';
        const itemHeader = document.createElement('div');
        itemHeader.className = 'model-review-item-header';
        const name = document.createElement('span');
        name.className = 'model-review-name';
        name.textContent = item.name || item.path;
        name.title = item.path;
        itemHeader.appendChild(name);
        const rank = document.createElement('span');
        rank.className = 'model-review-rank';
        rank.textContent = formatPreferenceRank(item);
        rank.title = `Net feature score ${formatPreferenceScore(item.feature_score)}`;
        itemHeader.appendChild(rank);
        body.appendChild(itemHeader);

        const explanation = document.createElement('div');
        explanation.className = 'model-review-explanation';
        const dislikeSource = Array.isArray(item.dislike_evidence) && item.dislike_evidence.length
            ? item.dislike_evidence
            : item.contributions;
        const keepSource = Array.isArray(item.keep_evidence) && item.keep_evidence.length
            ? item.keep_evidence
            : item.contributions;
        const dislikeEvidence = preferenceEvidence(
            dislikeSource,
            'dislike',
        );
        const keepEvidence = preferenceEvidence(
            keepSource,
            'keep',
        );
        const appendEvidence = (label, entries, className) => {
            if (!entries.length) return;
            const prefix = document.createElement('span');
            prefix.className = `model-review-explanation-label ${className}`;
            prefix.textContent = label;
            explanation.appendChild(prefix);
            for (const entry of entries.slice(0, 3)) {
                const chip = document.createElement('span');
                const feature = entry.feature;
                chip.className = [
                    'model-review-feature',
                    className,
                    feature.includes(' + ') ? 'combo' : '',
                ].filter(Boolean).join(' ');
                chip.textContent = feature;
                chip.title = `${label}: ${feature}`;
                explanation.appendChild(chip);
            }
        };
        appendEvidence('Dislike', dislikeEvidence, 'dislike');
        appendEvidence('Counter', keepEvidence, 'counter');
        if (!dislikeEvidence.length && !keepEvidence.length) {
            explanation.textContent = 'No individual feature explanation available';
        }
        body.appendChild(explanation);

        const actions = document.createElement('div');
        actions.className = 'model-review-actions';
        const preview = document.createElement('button');
        preview.className = 'model-review-preview';
        preview.type = 'button';
        preview.textContent = 'Preview';
        preview.setAttribute('aria-label', `Preview ${item.name || 'wallpaper'} full image`);
        preview.onclick = event => previewPreferenceSuggestion(item, event);
        preview.onkeydown = preserveModelReviewButtonKeyboard;
        actions.appendChild(preview);
        const keep = document.createElement('button');
        keep.className = 'model-review-keep';
        keep.type = 'button';
        keep.textContent = 'Keep';
        keep.onclick = event => {
            event.stopPropagation();
            keepPreferenceSuggestion(item, row);
        };
        keep.onkeydown = preserveModelReviewButtonKeyboard;
        actions.appendChild(keep);
        const ban = document.createElement('button');
        ban.className = 'model-review-ban';
        ban.type = 'button';
        ban.textContent = 'Ban';
        ban.onclick = event => {
            event.stopPropagation();
            banPreferenceSuggestion(item, row);
        };
        ban.onkeydown = preserveModelReviewButtonKeyboard;
        actions.appendChild(ban);
        body.appendChild(actions);

        row.appendChild(body);
        list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
}

function selectBlocklistTab(tab) {
    if (appState.blocklistTab === tab) return;
    appState.blocklistTab = tab;
    renderBlocklistView();
}

function filteredBlocklistEntries() {
    const entries = appState.blocklistData?.entries || [];
    return appState.searchMatches
        ? entries.filter(entry => appState.searchMatches.has(entry.filename))
        : entries;
}

function renderBlocklistView() {
    if (appState.mode !== 'trash') return;

    syncAISuggestionAppliedState();
    removeBlocklistSentinel();
    if (sentinel.parentNode) sentinel.remove();
    observer?.unobserve(sentinel);
    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;

    const bl = appState.blocklistData || { entries: [], total: 0, recoverable_count: 0, images: [] };
    const sourceEntries = bl.entries || [];
    const filteredEntries = filteredBlocklistEntries();
    const recoverableCount = appState.searchMatches
        ? appState.images.length
        : Number.isFinite(Number(bl.recoverable_count))
            ? Number(bl.recoverable_count)
            : appState.images.length;
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

    WayperBlocklistPager.sync(appState.blocklistPager, {
        sourceEntries,
        searchMatches: appState.searchMatches,
        tab: appState.blocklistTab,
    });

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'blocklist-tabs';

    const tabRecoverable = document.createElement('button');
    tabRecoverable.className = `blocklist-tab ${appState.blocklistTab === 'recoverable' ? 'active' : ''}`;
    tabRecoverable.innerHTML = `Recoverable <span class="tab-count">${recoverableCount}</span><kbd>[</kbd>`;
    tabRecoverable.onclick = () => selectBlocklistTab('recoverable');

    const tabBlocked = document.createElement('button');
    tabBlocked.className = `blocklist-tab ${appState.blocklistTab === 'blocked' ? 'active' : ''}`;
    tabBlocked.innerHTML = `All Blocked <span class="tab-count">${blockedCount}</span><kbd>]</kbd>`;
    tabBlocked.onclick = () => selectBlocklistTab('blocked');

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
                chip.title = `Add "${r.tag}" to combo — banned / kept / favorites`;
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
                count.textContent = suggestionEvidence(r);
                count.title = 'Banned / kept / favorites';
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

    if (!appState.reviewingTag && !appState.reviewingUploader && !appState.searchQuery) {
        const modelReview = createPreferenceReviewPanel();
        if (modelReview) els.wallpaperGrid.appendChild(modelReview);
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
                if (s.stats) {
                    const statsSpan = document.createElement('span');
                    statsSpan.className = 'ai-suggestion-stats';
                    statsSpan.textContent = suggestionEvidence(s.stats);
                    statsSpan.title = 'Banned / kept / favorites';
                    info.appendChild(statsSpan);
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
    list.onclick = event => {
        const button = event.target.closest('.entry-action');
        if (!button || !list.contains(button)) return;
        event.stopPropagation();
        button.disabled = true;
        unblockImage(button.dataset.filename).finally(() => {
            if (button.isConnected) button.disabled = false;
        });
    };

    const visibleCount = WayperBlocklistPager.visibleCount(
        appState.blocklistPager,
        entries.length,
        BLOCKLIST_PAGE_SIZE,
    );
    appendBlockedListEntries(list, entries.slice(0, visibleCount));

    els.wallpaperGrid.appendChild(list);
    updateBlockedListSentinel(entries);
}

function appendBlockedListEntries(list, entries) {
    const fragment = document.createDocumentFragment();

    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'blocklist-entry';

        const date = new Date(entry.timestamp * 1000);
        const dateStr = `${blocklistDateFormatter.format(date)} ${blocklistTimeFormatter.format(date)}`;

        const statusClass = entry.recoverable ? 'recoverable' : 'permanent';
        const statusText = entry.recoverable ? 'In Trash' : 'Deleted';

        row.innerHTML = `
            <span class="entry-name" title="${esc(entry.filename)}">${esc(entry.filename)}</span>
            <span class="entry-status ${statusClass}">${statusText}</span>
            <span class="entry-date">${esc(dateStr)}</span>
            <button class="entry-action" type="button">Unblock</button>
        `;
        row.querySelector('.entry-action').dataset.filename = entry.filename;
        fragment.appendChild(row);
    }

    list.appendChild(fragment);
}

function updateBlockedListSentinel(entries) {
    removeBlocklistSentinel();
    const visibleCount = Math.min(appState.blocklistPager.visibleCount, entries.length);
    if (visibleCount >= entries.length) return;

    if (!blocklistObserver) setupBlocklistInfiniteScroll();
    els.wallpaperGrid.appendChild(blocklistSentinel);
    blocklistObserver.observe(blocklistSentinel);
}

function loadMoreBlockedEntries() {
    if (appState.mode !== 'trash' || appState.blocklistTab !== 'blocked') return;

    const list = els.wallpaperGrid.querySelector('.blocklist-list');
    const entries = filteredBlocklistEntries();
    const sourceEntries = appState.blocklistData?.entries;
    if (
        !list
        || appState.blocklistPager.sourceEntries !== sourceEntries
        || appState.blocklistPager.searchMatches !== appState.searchMatches
        || appState.blocklistPager.tab !== appState.blocklistTab
    ) {
        renderBlocklistView();
        return;
    }

    const { start, end } = WayperBlocklistPager.loadMore(
        appState.blocklistPager,
        entries.length,
        BLOCKLIST_PAGE_SIZE,
    );
    if (end <= start) return;

    appendBlockedListEntries(list, entries.slice(start, end));
    updateBlockedListSentinel(entries);
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
    return `${API_URL}/images?path=${encodeURIComponent(path)}`;
}

function thumbnailUrl(path) {
    if (path.startsWith('__trash/')) {
        return `${API_URL}/trash-thumbnails/${encodeURIComponent(path.slice(8))}`;
    }
    return `${API_URL}/thumbnails?path=${encodeURIComponent(path)}`;
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
