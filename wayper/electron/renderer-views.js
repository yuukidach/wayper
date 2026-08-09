// --- Rendering ---

function modelReviewModeActive() {
    return typeof isModelReviewMode === 'function'
        ? isModelReviewMode()
        : appState?.mode === 'model-review';
}

function updateUI() {
    els.wallpaperGrid?.classList.toggle('model-review-grid', modelReviewModeActive());
    document.body?.setAttribute?.('data-mode', appState.mode);
    document.body?.setAttribute?.('data-view', appState.view || 'grid');

    // Mode
    els.btnPool.classList.remove('active');
    els.btnFavorites.classList.remove('active');
    els.btnBlocklist.classList.remove('active');
    els.btnModelReview?.classList.remove('active');

    if (appState.mode === 'pool') {
        els.btnPool.classList.add('active');
    } else if (appState.mode === 'favorites') {
        els.btnFavorites.classList.add('active');
    } else if (appState.mode === 'trash') {
        els.btnBlocklist.classList.add('active');
    } else if (modelReviewModeActive()) {
        els.btnModelReview?.classList.add('active');
    }

    // Purity toggles
    els.btnPuritySfw.classList.toggle('active', appState.purity.includes('sfw'));
    els.btnPuritySketchy.classList.toggle('active', appState.purity.includes('sketchy'));
    els.btnPurityNsfw.classList.toggle('active', appState.purity.includes('nsfw'));

    if (typeof updateFilterStrategyUI === 'function') {
        updateFilterStrategyUI();
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
    if (els.countModelReview && appState.status.model_review_count !== undefined) {
        const reviewData = modelReviewModeActive() ? appState.modelReviewData : null;
        const held = Number(
            reviewData?.pending_count ?? appState.status.model_review_count,
        );
        const recommended = Number(reviewData?.recommendation_count);
        const heldCount = Number.isFinite(held) ? Math.max(0, held) : 0;
        const recommendationCount = Number.isFinite(recommended)
            ? Math.max(0, recommended)
            : 0;
        els.countModelReview.innerText = heldCount + recommendationCount;
        els.countModelReview.title = reviewData
            ? `${heldCount} auto-held · ${recommendationCount} recommended`
            : `${heldCount} auto-held`;
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
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `monitor-item ${m.name === appState.selectedMonitor ? 'active' : ''}`;
        el.setAttribute('aria-pressed', String(m.name === appState.selectedMonitor));
        el.setAttribute(
            'aria-label',
            `${m.name}, ${m.orientation}, ${m.current_image ? 'active wallpaper' : 'empty'}`,
        );

        const isLandscape = m.orientation === 'landscape';
        const monitorIcon = isLandscape
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
        // Number keys belong to monitors so the first two displays are easy
        // to reach without competing with gallery actions.
        const key = index + 1;
        const shortcut = key <= 9 ? `<kbd>${key}</kbd>` : '';
        if (key <= 9) el.setAttribute('aria-keyshortcuts', String(key));

        el.innerHTML = `
            <span class="monitor-item-title">${monitorIcon}<span class="monitor-name">${esc(m.name)}</span>${shortcut}</span>
            <span class="monitor-item-meta">${esc(m.orientation)} · ${m.current_image ? 'Active' : 'Empty'}</span>
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
    if (modelReviewModeActive()) {
        renderModelReviewView();
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
    const data = modelReviewModeActive() ? appState.modelReviewData : appState.preferenceSuggestions;
    if (!data || !Array.isArray(data.items)) return [];
    if (modelReviewModeActive() && typeof modelReviewVisibleItems === 'function') {
        return modelReviewVisibleItems(data);
    }
    // renderer-data.js normally provides the queue sanitizer.  Keep a small
    // local fallback so this view remains independently testable.
    if (typeof preferenceSuggestionItems === 'function') {
        return preferenceSuggestionItems(data);
    }
    const resolved = appState.preferenceReviewResolvedPaths instanceof Set
        ? appState.preferenceReviewResolvedPaths
        : new Set();
    const seen = new Set();
    return data.items.filter(item => {
        const path = typeof item?.path === 'string' ? item.path : '';
        if (!path || resolved.has(path) || seen.has(path)) return false;
        seen.add(path);
        return true;
    });
}

function preferenceReviewListWidth(list = null) {
    const measured = Number(list?.clientWidth);
    if (Number.isFinite(measured) && measured > 0) return measured;

    // Before the list is mounted, estimate its content width from the outer
    // grid.  The outer grid has 16px padding and the review panel has 14px
    // horizontal padding on each side (plus its border).
    const gridWidth = Number(
        typeof els !== 'undefined' ? els.wallpaperGrid?.clientWidth : 0,
    );
    if (Number.isFinite(gridWidth) && gridWidth > 0) {
        return Math.max(0, gridWidth - 32 - 28 - 2);
    }
    return 0;
}

function preferenceReviewColumnCount(list = null) {
    const width = preferenceReviewListWidth(list);
    if (width > 0) {
        return Math.max(
            1,
            Math.floor((width + PREFERENCE_REVIEW_GAP)
                / (PREFERENCE_REVIEW_CARD_MIN_WIDTH + PREFERENCE_REVIEW_GAP)),
        );
    }
    const fallback = Number(appState.gridColumns);
    return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 1;
}

function preferenceReviewDisplayLimit(list = null) {
    const columns = preferenceReviewColumnCount(list);
    // Keep the original eight-card density as a floor, then round up to a
    // complete row for the current responsive column count.
    return Math.max(
        PREFERENCE_REVIEW_BASE_COUNT,
        Math.ceil(PREFERENCE_REVIEW_BASE_COUNT / columns) * columns,
    );
}

function preferenceReviewVisibleItems(list = null) {
    if (modelReviewModeActive()) return preferenceReviewItems();
    return preferenceReviewItems().slice(0, preferenceReviewDisplayLimit(list));
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
    if (item?.auto_filtered) return 'Auto-held';
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
    if (!(appState.preferenceReviewResolvedPaths instanceof Set)) {
        appState.preferenceReviewResolvedPaths = new Set();
    }
    appState.preferenceReviewResolvedPaths.add(path);
    const items = data.items.filter(item => item?.path !== path);
    const diagnostics = data.diagnostics && typeof data.diagnostics === 'object'
        ? data.diagnostics
        : {};
    const previousTotal = Number(diagnostics.candidate_count);
    const previousPending = Number(data.pending_count);
    const removed = items.length < data.items.length;
    appState.preferenceSuggestions = {
        ...data,
        items,
        pending_count: removed && Number.isFinite(previousPending)
            ? Math.max(0, previousPending - 1)
            : data.pending_count,
        diagnostics: {
            ...diagnostics,
            candidate_count: removed && Number.isFinite(previousTotal)
                ? Math.max(items.length, previousTotal - 1)
                : Number.isFinite(previousTotal) ? Math.max(items.length, previousTotal) : items.length,
            loaded_candidate_count: items.length,
        },
    };
}

function preferenceReviewRow(path) {
    const reviewElements = [
        ...document.querySelectorAll('.model-review-row'),
        ...document.querySelectorAll('.model-review-card'),
    ];
    return reviewElements
        .find(row => row.dataset.path === path) || null;
}

/**
 * Move focus back into the review queue after an action removes a candidate.
 *
 * Model-review actions are deliberately rendered as ordinary buttons so they
 * remain usable with a screen reader and with Tab.  The queue is refreshed in
 * place, though, which means the element that had focus can disappear while a
 * Keep/Dislike request is completing. Keeping this small helper here gives both
 * the row action and the lightbox a common, safe focus target.
 */
function focusPreferenceReviewCandidate(path, selector = '.model-review-preview') {
    if (!path || typeof document === 'undefined') return false;
    const row = preferenceReviewRow(path);
    if (!row) return false;
    const candidates = [
        row.matches?.('.model-review-card') ? row : null,
        row.querySelector?.(selector),
        ...(row.querySelectorAll ? [...row.querySelectorAll('button')] : []),
        row,
    ];
    const target = candidates.find(candidate => candidate && !candidate.disabled) || row;
    if (typeof target.focus !== 'function') return false;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    return true;
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
    const bestReviewScore = items.reduce((best, item) => {
        const score = Number(
            item?.neighbor_probability
            ?? item?.recommendation_score
            ?? item?.review_score
            ?? item?.feature_score,
        );
        return Number.isFinite(score) ? Math.max(best, score) : best;
    }, 0);
    const serverCandidateCount = Number(diagnostics.candidate_count);
    appState.preferenceSuggestions = {
        ...data,
        diagnostics: {
            ...diagnostics,
            // candidate_count is the server's total ranked pool, while
            // loaded_candidate_count tracks the bounded queue in the renderer.
            // Preserve the former so we know when a refill may still help.
            candidate_count: Number.isFinite(serverCandidateCount)
                ? Math.max(items.length, serverCandidateCount)
                : items.length,
            loaded_candidate_count: items.length,
            best_review_score: items.length ? bestReviewScore : null,
        },
    };
}

function preferenceReviewEmptyText(data) {
    if (modelReviewModeActive()) {
        if (data?.filter_strategy === 'rules') {
            return 'Automatic model filtering is off. Choose Model or Rules + model in Settings.';
        }
        const filterStatus = data?.model_filter;
        if (filterStatus && filterStatus.ready === false && filterStatus.reason) {
            return filterStatus.reason;
        }
        return 'No automatically filtered images are waiting for review.';
    }
    const diagnostics = data?.diagnostics || {};
    const bestReviewScore = Number(
        diagnostics.best_neighbor_probability
        ?? diagnostics.best_review_score
        ?? diagnostics.best_feature_score,
    );
    const bestLabel = Number.isFinite(bestReviewScore)
        ? formatPreferenceScore(bestReviewScore)
        : null;
    if (data?.status === 'untrained') {
        return 'Train a local preference model to start reviewing candidates.';
    }
    if (data?.status === 'upgrade_pending') {
        return 'Updating the local ranking model; review will appear shortly.';
    }
    if (bestLabel) {
        return `No learned dislike-evidence candidates; strongest review score ${bestLabel}.`;
    }
    return 'No learned dislike-evidence candidates for this monitor and purity.';
}

function updatePreferenceReviewPanelAfterRemoval(path, { restoreFocus: requestedFocus = null } = {}) {
    const row = preferenceReviewRow(path);
    const panel = row?.closest('.model-review-panel')
        || (typeof els !== 'undefined'
            ? els.wallpaperGrid?.querySelector('.model-review-panel')
            : null);
    if (!panel) return;

    // If the action was launched from a focused review control, remember the
    // nearest surviving row before replacing the list.  Without this, the
    // browser drops focus to <body> as soon as the active row is removed and
    // keyboard review appears to stop after the first decision.
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    const restoreFocus = requestedFocus ?? Boolean(row?.contains?.(activeElement));
    const rowsBefore = [...panel.querySelectorAll('.model-review-row')];
    const removedIndex = rowsBefore.indexOf(row);
    const fallbackPath = restoreFocus
        ? rowsBefore[removedIndex + 1]?.dataset.path
            || rowsBefore[removedIndex - 1]?.dataset.path
        : null;

    // Reconcile against the queued items.  Existing DOM rows are moved rather
    // than recreated, so focus and in-flight button state survive while the
    // next candidate takes the removed slot.
    syncPreferenceReviewRows(panel);
    if (restoreFocus) {
        const focused = fallbackPath
            ? focusPreferenceReviewCandidate(fallbackPath)
            : false;
        if (!focused && typeof panel.focus === 'function') {
            panel.tabIndex = -1;
            panel.focus({ preventScroll: true });
        }
    }
    void refillPreferenceReviewCandidates();
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
    // Quarantine candidates and legacy ranked candidates share the lightbox
    // preview, but the review surface exposes only deliberate Keep (A) and
    // Dislike (D) decisions plus the Wallhaven link.
    showLightbox({ ...item, isTrash: false, reviewOnly: true });
}

function preserveModelReviewButtonKeyboard(event) {
    if (event.key === 'Enter' || event.key === ' ') {
        // The gallery's global shortcuts must not consume native button activation.
        event.stopPropagation();
    }
}

function reviewRowRect(row) {
    const rect = row?.getBoundingClientRect?.();
    if (!rect) return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const width = Number(rect.width);
    const height = Number(rect.height);
    const right = Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width;
    const bottom = Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height;
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    if (right <= left && bottom <= top) return null;
    return {
        left,
        top,
        right,
        bottom,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2,
    };
}

function reviewAxisOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}

function directionalReviewNeighbor(row, key, rows) {
    const current = reviewRowRect(row);
    if (!current) return null;
    const measured = rows
        .map(candidate => ({ candidate, rect: reviewRowRect(candidate) }))
        .filter(entry => entry.rect && entry.candidate !== row);
    if (!measured.length) return null;

    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    const candidates = measured.filter(({ rect }) => {
        const sameAxis = vertical
            ? reviewAxisOverlap(current.top, current.bottom, rect.top, rect.bottom)
            : reviewAxisOverlap(current.left, current.right, rect.left, rect.right);
        // Do not mistake a differently-sized card in the same visual row or
        // column for a candidate in the requested direction.
        if (sameAxis > 0) return false;
        const delta = vertical
            ? rect.centerY - current.centerY
            : rect.centerX - current.centerX;
        return forward ? delta > 0.5 : delta < -0.5;
    });
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
        const aOverlap = vertical
            ? reviewAxisOverlap(current.left, current.right, a.rect.left, a.rect.right)
            : reviewAxisOverlap(current.top, current.bottom, a.rect.top, a.rect.bottom);
        const bOverlap = vertical
            ? reviewAxisOverlap(current.left, current.right, b.rect.left, b.rect.right)
            : reviewAxisOverlap(current.top, current.bottom, b.rect.top, b.rect.bottom);
        const aAligned = aOverlap > 0 ? 1 : 0;
        const bAligned = bOverlap > 0 ? 1 : 0;
        if (aAligned !== bAligned) return bAligned - aAligned;

        const aMain = vertical
            ? Math.abs(a.rect.centerY - current.centerY)
            : Math.abs(a.rect.centerX - current.centerX);
        const bMain = vertical
            ? Math.abs(b.rect.centerY - current.centerY)
            : Math.abs(b.rect.centerX - current.centerX);
        if (aMain !== bMain) return aMain - bMain;

        const aCross = vertical
            ? Math.abs(a.rect.centerX - current.centerX)
            : Math.abs(a.rect.centerY - current.centerY);
        const bCross = vertical
            ? Math.abs(b.rect.centerX - current.centerX)
            : Math.abs(b.rect.centerY - current.centerY);
        return aCross - bCross;
    });
    return candidates[0].candidate;
}

function modelReviewColumnCount(panel) {
    const list = panel?.querySelector?.('.model-review-list');
    if (typeof preferenceReviewColumnCount === 'function') {
        try {
            const measured = Number(preferenceReviewColumnCount(list));
            if (Number.isFinite(measured) && measured > 0) return Math.floor(measured);
        } catch {
            // The helper shares responsive constants with renderer-state.js;
            // use the CSS/outer-grid fallback while scripts are bootstrapping.
        }
    }
    const template = list && typeof getComputedStyle === 'function'
        ? getComputedStyle(list).gridTemplateColumns
        : '';
    const columns = String(template || '').trim().split(/\s+/).filter(Boolean).length;
    if (columns > 0) return columns;
    return Math.max(1, Number(appState.gridColumns) || 1);
}

function indexedReviewNeighbor(row, key, rows, panel) {
    const current = rows.indexOf(row);
    if (current < 0) return null;
    const columns = modelReviewColumnCount(panel);
    let nextIndex = -1;
    if (columns <= 1 && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        nextIndex = current + (key === 'ArrowRight' ? 1 : -1);
    } else {
        switch (key) {
            case 'ArrowLeft':
                nextIndex = current % columns > 0 ? current - 1 : -1;
                break;
            case 'ArrowRight':
                nextIndex = current % columns < columns - 1 ? current + 1 : -1;
                break;
            case 'ArrowUp':
                nextIndex = current - columns;
                break;
            case 'ArrowDown':
                nextIndex = current + columns;
                break;
        }
    }
    return nextIndex >= 0 && nextIndex < rows.length ? rows[nextIndex] : null;
}

function moveModelReviewFocus(row, direction) {
    const panel = row?.closest?.('.model-review-panel');
    if (!panel) return false;
    const rows = [...panel.querySelectorAll('.model-review-row')];
    const current = rows.indexOf(row);
    if (current < 0) return false;
    const key = direction === -1
        ? 'ArrowUp'
        : direction === 1 ? 'ArrowDown' : direction;
    const next = directionalReviewNeighbor(row, key, rows)
        || indexedReviewNeighbor(row, key, rows, panel);
    if (!next || typeof next.focus !== 'function') {
        // The review queue is the first keyboard surface above the gallery.
        // Once its final candidate is reached, continue into the first
        // wallpaper card so ArrowDown/ArrowRight never strand the user.
        const movingForward = key === 'ArrowDown' || key === 'ArrowRight';
        if (movingForward && current === rows.length - 1) {
            const firstCard = document.querySelector?.('.wallpaper-card')
                || document.getElementsByClassName?.('wallpaper-card')?.[0];
            if (firstCard?.focus) {
                firstCard.focus({ preventScroll: true });
                firstCard.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
                return true;
            }
        }
        return false;
    }
    next.focus({ preventScroll: true });
    next.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    return true;
}

/**
 * Keyboard behavior for a model-review row.
 *
 * Rows are focusable in addition to their individual controls.  This lets a
 * keyboard user review a queue efficiently (Enter/Space to preview, A to
 * keep, D (or legacy X/Delete) to dislike, and arrows to move between candidates) without
 * falling through to the gallery's global shortcuts, which otherwise operate
 * on the unrelated current wallpaper.
 */
function handleModelReviewRowKeyboard(event) {
    const row = event.currentTarget?.closest?.('.model-review-row')
        || event.target?.closest?.('.model-review-row');
    if (!row) return false;
    const item = preferenceReviewItems().find(candidate => candidate.path === row.dataset.path);
    if (!item) return false;

    const target = event.target;
    const button = target?.closest?.('button');
    const key = event.key;

    // Let native button activation generate its click.  We only stop the
    // event from reaching handleGlobalKeydown, whose Enter/Space shortcuts
    // belong to the gallery/lightbox rather than this review card.
    if (button && (key === 'Enter' || key === ' ')) {
        event.stopPropagation();
        return true;
    }

    if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        previewPreferenceSuggestion(item);
        return true;
    }

    if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        if (activeElement && row.contains?.(activeElement)) {
            activeElement.blur?.();
        } else {
            row.blur?.();
        }
        return true;
    }

    if (key === 'a' || key === 'A') {
        event.preventDefault();
        event.stopPropagation();
        if (!row.classList?.contains?.('is-busy')) {
            void keepPreferenceSuggestion(item, row);
        }
        return true;
    }

    if (['d', 'D', 'x', 'X', 'Delete'].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        if (!row.classList?.contains?.('is-busy')) {
            void banPreferenceSuggestion(item, row);
        }
        return true;
    }

    if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        moveModelReviewFocus(row, key);
        return true;
    }

    if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        moveModelReviewFocus(row, key);
        return true;
    }

    return false;
}

async function keepPreferenceSuggestion(item, row) {
    // The dedicated deck resolves both ranked pool recommendations and
    // automatically held files through its source-aware decision handler.
    if (modelReviewModeActive()) {
        return resolveModelReviewDecision(item, 'keep');
    }
    const restoreFocus = Boolean(
        row
        && typeof document !== 'undefined'
        && row.contains?.(document.activeElement),
    );
    setPreferenceReviewActionBusy(row, true);
    try {
        const result = await WayperApi.preferenceFeedback(item.path, 'keep');
        if (result?.learning && appState.preferenceSuggestions) {
            appState.preferenceSuggestions.learning = result.learning;
        }
        removePreferenceSuggestion(item.path);
        refreshPreferenceSuggestionDiagnostics();
        // A quarantine item is moved into the pool by the compatibility
        // endpoint; an old ranked candidate only changes the preference
        // ledger.  Both paths remove one review row in place.
        if (modelReviewModeActive() && result?.review?.new_path) {
            appState.status.pool_count = Number(appState.status.pool_count || 0) + 1;
        }
        updatePreferenceReviewPanelAfterRemoval(item.path, { restoreFocus });
        if (modelReviewModeActive()) {
            appState.status.model_review_count = Math.max(
                0,
                Number(appState.status.model_review_count || 0) - 1,
            );
            updateStatusUI();
        }
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

async function banPreferenceSuggestion(item, row, { restoreFocus: requestedFocus = null } = {}) {
    if (!item?.path || preferenceBanInFlight.has(item.path)) return false;
    if (modelReviewModeActive()) {
        return resolveModelReviewDecision(item, 'ban');
    }
    preferenceBanInFlight.add(item.path);
    const restoreFocus = requestedFocus ?? Boolean(
        row
        && typeof document !== 'undefined'
        && row.contains?.(document.activeElement),
    );
    setPreferenceReviewActionBusy(row, true);
    try {
        // Auto-filtered files have not entered the pool yet, so resolve them
        // through the dedicated queue endpoint. Legacy ranked candidates keep
        // the normal dislike/trash path.
        let banned;
        if (item.auto_filtered) {
            const result = await WayperApi.modelReviewAction(item.path, 'ban');
            banned = result?.status === 'ok';
        } else {
            banned = await banImage(item.path, {
                preserveView: true,
                preferenceContext: 'model_review',
                refreshSuggestionsInPlace: true,
            });
        }
        if (!banned) return false;
        removePreferenceSuggestion(item.path);
        refreshPreferenceSuggestionDiagnostics();
        if (!item.auto_filtered) updateBlocklistStateAfterBan(item);
        updatePreferenceReviewPanelAfterRemoval(item.path, { restoreFocus });
        if (item.auto_filtered) {
            appState.status.model_review_count = Math.max(
                0,
                Number(appState.status.model_review_count || 0) - 1,
            );
            appState.status.blocklist_count = Number(appState.status.blocklist_count || 0) + 1;
            updateStatusUI();
        }
        return true;
    } catch (e) {
        console.error('Failed to dislike model review suggestion:', e);
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
    // The lightbox closes immediately, so the active element is no longer in
    // the row when the asynchronous dislike resolves. Ask the row updater to
    // move focus to the next surviving candidate once the transaction ends.
    const pendingBan = banPreferenceSuggestion(item, row, { restoreFocus: true });
    closeLightbox();
    return pendingBan;
}

function createPreferenceReviewRow(item) {
    const row = document.createElement('article');
    row.className = 'model-review-row';
    row.dataset.path = item.path;
    row.tabIndex = 0;
    row.setAttribute?.('role', 'group');
    row.setAttribute?.(
        'aria-label',
        `${item.name || item.path}. Arrow keys move by row and column. `
            + 'Enter or Space to preview, A to keep, D to dislike',
    );
    row.setAttribute?.(
        'aria-keyshortcuts',
        'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space A D X Delete',
    );
    row.onkeydown = handleModelReviewRowKeyboard;

    const thumbnailButton = document.createElement('button');
    thumbnailButton.className = 'model-review-thumbnail-button';
    thumbnailButton.type = 'button';
    thumbnailButton.title = `Preview ${item.name || 'wallpaper'} (Enter/Space)`;
    thumbnailButton.setAttribute(
        'aria-label',
        `Preview ${item.name || 'wallpaper'} full image`,
    );
    thumbnailButton.setAttribute('aria-keyshortcuts', 'Enter Space');
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
    const neighborRank = item.ranking_source === 'content_knn';
    rank.title = item.auto_filtered
        ? `Auto-held score ${formatPreferenceScore(item.neighbor_probability ?? item.decision_score ?? item.review_score)}`
            + ` · boundary ${formatPreferenceScore(item.threshold)}`
        : neighborRank
            ? `Dislike-neighbour vote ${formatPreferenceScore(item.neighbor_probability)}`
                + ` · similarity ${formatPreferenceScore(item.neighbor_max_similarity)}`
                + ` · sparse explanation ${formatPreferenceScore(item.review_score ?? item.feature_score)}`
            : `Hybrid rank ${formatPreferenceScore(item.hybrid_score ?? item.review_score ?? item.feature_score)}`
                + ` · review score ${formatPreferenceScore(item.review_score ?? item.feature_score)}`
                + (item.semantic_available
                    ? ` · semantic ${formatPreferenceScore(item.semantic_score)}`
                    : '')
                + ` · net feature score ${formatPreferenceScore(item.feature_score)}`;
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
    const dislikeEvidence = preferenceEvidence(dislikeSource, 'dislike');
    const keepEvidence = preferenceEvidence(keepSource, 'keep');
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
    if (neighborRank && item.neighbor_nearest_dislike?.filename) {
        const neighbor = document.createElement('span');
        neighbor.className = 'model-review-neighbor-evidence';
        neighbor.textContent = `Similar to Dislike: ${item.neighbor_nearest_dislike.filename}`;
        neighbor.title = `Nearest explicit Dislike (${formatPreferenceScore(item.neighbor_nearest_dislike.similarity)} similarity)`;
        explanation.appendChild(neighbor);
    }
    if (
        !dislikeEvidence.length
        && !keepEvidence.length
        && !(neighborRank && item.neighbor_nearest_dislike?.filename)
    ) {
        explanation.textContent = 'No individual feature explanation available';
    }
    body.appendChild(explanation);

    const actions = document.createElement('div');
    actions.className = 'model-review-actions';
    const preview = document.createElement('button');
    preview.className = 'model-review-preview';
    preview.type = 'button';
    preview.textContent = 'Preview';
    preview.title = `Preview ${item.name || 'wallpaper'} (Enter/Space)`;
    preview.setAttribute('aria-label', `Preview ${item.name || 'wallpaper'} full image`);
    preview.setAttribute('aria-keyshortcuts', 'Enter Space');
    preview.onclick = event => previewPreferenceSuggestion(item, event);
    preview.onkeydown = preserveModelReviewButtonKeyboard;
    actions.appendChild(preview);
    const keep = document.createElement('button');
    keep.className = 'model-review-keep';
    keep.type = 'button';
    keep.textContent = 'Keep';
    keep.title = `Keep ${item.name || 'wallpaper'} (A)`;
    keep.setAttribute('aria-label', `Keep ${item.name || 'wallpaper'} (A)`);
    keep.setAttribute('aria-keyshortcuts', 'A');
    keep.onclick = event => {
        event.stopPropagation();
        keepPreferenceSuggestion(item, row);
    };
    keep.onkeydown = preserveModelReviewButtonKeyboard;
    actions.appendChild(keep);
    const ban = document.createElement('button');
    ban.className = 'model-review-ban';
    ban.type = 'button';
    ban.textContent = 'Dislike';
    ban.title = `Dislike ${item.name || 'wallpaper'} and teach the model (D)`;
    ban.setAttribute('aria-label', `Dislike ${item.name || 'wallpaper'} (D)`);
    ban.setAttribute('aria-keyshortcuts', 'D X Delete');
    ban.onclick = event => {
        event.stopPropagation();
        banPreferenceSuggestion(item, row);
    };
    ban.onkeydown = preserveModelReviewButtonKeyboard;
    actions.appendChild(ban);
    body.appendChild(actions);

    row.appendChild(body);
    return row;
}

function syncPreferenceReviewRows(panel) {
    if (!panel) return;
    let list = panel.querySelector('.model-review-list');
    const items = preferenceReviewVisibleItems(list);
    const count = panel.querySelector('.model-review-count');
    if (count) {
        const pending = Number(appState.preferenceSuggestions?.pending_count);
        count.textContent = preferenceReviewCountText(
            modelReviewModeActive() && Number.isFinite(pending) ? pending : items.length,
        );
    }
    panel.dataset.visibleLimit = String(preferenceReviewDisplayLimit(list));

    if (!items.length) {
        list?.remove();
        panel.querySelector('.model-review-empty')?.remove();
        const empty = document.createElement('p');
        empty.className = 'model-review-empty';
        empty.textContent = preferenceReviewEmptyText(appState.preferenceSuggestions || {});
        panel.appendChild(empty);
        return;
    }

    panel.querySelector('.model-review-empty')?.remove();
    if (!list) {
        list = document.createElement('div');
        list.className = 'model-review-list';
        panel.appendChild(list);
    }

    const existing = new Map(
        [...list.querySelectorAll('.model-review-row')].map(row => [row.dataset.path, row]),
    );
    const fragment = document.createDocumentFragment();
    for (const item of items) {
        const row = existing.get(item.path) || createPreferenceReviewRow(item);
        fragment.appendChild(row);
        const keepBusy = typeof preferenceKeepInFlight !== 'undefined'
            && preferenceKeepInFlight.has(item.path);
        const banBusy = typeof preferenceBanInFlight !== 'undefined'
            && preferenceBanInFlight.has(item.path);
        if (keepBusy || banBusy) setPreferenceReviewActionBusy(row, true);
    }
    list.replaceChildren(fragment);
}

function preferenceReviewCandidateTotal() {
    const diagnostics = appState.preferenceSuggestions?.diagnostics;
    const total = Number(diagnostics?.candidate_count);
    return Number.isFinite(total) ? Math.max(0, total) : null;
}

function refillPreferenceReviewCandidates() {
    const data = appState.preferenceSuggestions;
    if (
        modelReviewModeActive()
        || appState.mode !== 'trash'
        || !data
        || (data.status && data.status !== 'ready')
        || typeof fetchPreferenceSuggestions !== 'function'
    ) {
        return Promise.resolve(false);
    }
    const items = preferenceReviewItems();
    const target = preferenceReviewDisplayLimit(
        typeof els !== 'undefined' ? els.wallpaperGrid?.querySelector('.model-review-list') : null,
    );
    const total = preferenceReviewCandidateTotal();
    if (items.length >= target || (total !== null && items.length >= total)) {
        return Promise.resolve(false);
    }
    if (appState.preferenceReviewRefillPromise) {
        return appState.preferenceReviewRefillPromise;
    }

    const requestId = appState.imageRequestId;
    const promise = fetchPreferenceSuggestions({
        orient: appState.currentOrient,
        requestId,
        merge: true,
    }).then(updated => {
        if (!updated) return false;
        refreshPreferenceSuggestionDiagnostics();
        const panel = typeof els !== 'undefined'
            ? els.wallpaperGrid?.querySelector('.model-review-panel')
            : null;
        if (panel) syncPreferenceReviewRows(panel);
        return true;
    }).finally(() => {
        if (appState.preferenceReviewRefillPromise === promise) {
            appState.preferenceReviewRefillPromise = null;
        }
    });
    appState.preferenceReviewRefillPromise = promise;
    return promise;
}

function modelReviewStrategy(data = appState.modelReviewData) {
    const value = data?.filter_strategy
        || appState.config?.wallhaven?.filter_strategy
        || appState.config?.wallhaven?.filter_mode
        || 'rules';
    return ['rules', 'model', 'rules+model'].includes(value) ? value : 'rules';
}

function sanitizeModelReviewItems(source) {
    if (!Array.isArray(source)) return [];
    const resolved = appState.modelReviewResolvedPaths instanceof Set
        ? appState.modelReviewResolvedPaths
        : new Set();
    const seen = new Set();
    return source.filter(item => {
        const path = typeof item?.path === 'string' ? item.path : '';
        if (!path || resolved.has(path) || seen.has(path)) return false;
        seen.add(path);
        return true;
    });
}

function modelReviewHeldItems(data = appState.modelReviewData) {
    const source = typeof modelReviewItems === 'function'
        ? modelReviewItems(data)
        : data?.items;
    return sanitizeModelReviewItems(source);
}

function modelReviewRecommendationItems(data = appState.modelReviewData) {
    return sanitizeModelReviewItems(data?.recommendations);
}

function modelReviewQueueItems(data = appState.modelReviewData) {
    const seen = new Set();
    return [
        ...modelReviewRecommendationItems(data),
        ...modelReviewHeldItems(data),
    ].filter(item => {
        if (seen.has(item.path)) return false;
        seen.add(item.path);
        return true;
    });
}

function modelReviewSourceItems(source, data = appState.modelReviewData) {
    return source === 'held'
        ? modelReviewHeldItems(data)
        : modelReviewRecommendationItems(data);
}

function modelReviewSourceCount(source, data = appState.modelReviewData) {
    const reported = Number(
        source === 'held' ? data?.pending_count : data?.recommendation_count,
    );
    return Number.isFinite(reported)
        ? Math.max(modelReviewSourceItems(source, data).length, reported)
        : modelReviewSourceItems(source, data).length;
}

function activeModelReviewSource(data = appState.modelReviewData) {
    const current = appState.modelReviewSource;
    if (['held', 'recommended'].includes(current) && modelReviewSourceItems(current, data).length) {
        return current;
    }
    const selectedPath = appState.modelReviewSelectedPath;
    const selectedSource = modelReviewHeldItems(data).some(item => item.path === selectedPath)
        ? 'held'
        : modelReviewRecommendationItems(data).some(item => item.path === selectedPath)
            ? 'recommended'
            : null;
    const source = selectedSource
        || (modelReviewHeldItems(data).length ? 'held' : 'recommended');
    appState.modelReviewSource = source;
    return source;
}

function modelReviewVisibleItems(
    data = appState.modelReviewData,
    source = activeModelReviewSource(data),
) {
    return modelReviewSourceItems(source, data);
}

function modelReviewMakeButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.onclick = onClick;
    return button;
}

function decorateModelReviewDecisionButton(button, action) {
    const isKeep = action === 'keep';
    const label = document.createElement('span');
    label.className = 'model-review-decision-label';
    label.textContent = isKeep ? 'Keep' : 'Dislike';
    const key = document.createElement('kbd');
    key.className = 'review-keycap model-review-keycap';
    key.textContent = isKeep ? 'A' : 'D';
    button.textContent = '';
    button.append(label, key);
}

function decorateModelReviewNavButton(button, direction) {
    button.textContent = '';
    button.innerHTML = direction < 0
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
}

function selectedModelReviewItem(data = appState.modelReviewData) {
    const items = modelReviewVisibleItems(data);
    if (!items.length) return null;
    const selected = items.find(item => item.path === appState.modelReviewSelectedPath);
    if (selected) return selected;
    appState.modelReviewSelectedPath = items[0].path;
    return items[0];
}

function modelReviewCardSelector(path) {
    return '.model-review-card[data-path="' + CSS.escape(path) + '"]';
}

function markActiveModelReviewCard(carousel, path, { force = false } = {}) {
    if (!carousel) return;
    const deckBusy = carousel.classList?.contains?.('is-resolving-card') === true;
    if (carousel.dataset?.activePath === path && !deckBusy && !force) return;
    if (carousel.dataset) carousel.dataset.activePath = path;
    const cards = [...carousel.querySelectorAll('.model-review-card')];
    const activeIndex = cards.findIndex(card => card.dataset.path === path);
    cards.forEach((card, index) => {
        const active = card.dataset.path === path;
        card.classList.toggle('active', active);
        card.classList.toggle('before-active', activeIndex >= 0 && index < activeIndex);
        card.classList.toggle('after-active', activeIndex >= 0 && index > activeIndex);
        card.setAttribute('aria-current', String(active));
        card.tabIndex = active ? 0 : -1;
        const distance = activeIndex >= 0 ? Math.abs(index - activeIndex) : cards.length;
        if (card.style) {
            card.style.zIndex = String(Math.max(1, 20 - distance));
            card.style.setProperty?.('--review-card-depth', `${Math.min(distance, 4) * 4 + 10}px`);
            card.style.setProperty?.(
                '--review-card-scale',
                String(Math.max(0.88, 0.95 - Math.min(distance, 4) * 0.012)),
            );
        }
        if (distance <= 1) {
            hydrateModelReviewCardImages(card, { priority: active });
        }
        const busy = card.classList.contains('is-busy');
        for (const button of card.querySelectorAll('.model-review-card-decision')) {
            button.disabled = !active || busy || deckBusy;
        }
    });
    const deck = carousel.closest?.('.model-review-deck');
    const previous = deck?.querySelector?.('.model-review-deck-nav.previous');
    const next = deck?.querySelector?.('.model-review-deck-nav.next');
    if (previous) previous.disabled = cards.length < 2 || activeIndex <= 0;
    if (next) next.disabled = cards.length < 2 || activeIndex < 0 || activeIndex >= cards.length - 1;
}

function scrollModelReviewCardIntoView(carousel, card, behavior = 'smooth') {
    if (!carousel || !card) return false;
    const geometry = [card.offsetLeft, card.offsetWidth, carousel.clientWidth];
    if (geometry.every(Number.isFinite) && card.offsetWidth > 0 && carousel.clientWidth > 0) {
        const target = Math.max(
            0,
            card.offsetLeft - (carousel.clientWidth - card.offsetWidth) / 2,
        );
        if (Number.isFinite(carousel.scrollLeft) && Math.abs(carousel.scrollLeft - target) <= 2) {
            return false;
        }
        if (typeof carousel.scrollTo === 'function') {
            carousel.scrollTo({ left: target, behavior });
            return true;
        }
    }
    card.scrollIntoView?.({ behavior, block: 'nearest', inline: 'center' });
    return true;
}

function selectModelReviewItem(
    path,
    { focus = false, behavior = 'smooth' } = {},
) {
    const item = modelReviewVisibleItems().find(candidate => candidate.path === path);
    if (!item) return false;
    appState.modelReviewSelectedPath = path;
    const carousel = els.wallpaperGrid?.querySelector('.model-review-carousel');
    markActiveModelReviewCard(carousel, path);
    const card = carousel?.querySelector(modelReviewCardSelector(path));
    scrollModelReviewCardIntoView(carousel, card, behavior);
    if (focus && card) {
        card?.focus?.({ preventScroll: true });
    }
    return true;
}

function moveModelReviewSelection(direction, { focus = true } = {}) {
    const items = modelReviewVisibleItems();
    if (items.length < 2 || ![-1, 1].includes(direction)) return false;
    const current = items.findIndex(item => item.path === appState.modelReviewSelectedPath);
    const start = current >= 0 ? current : direction > 0 ? -1 : items.length;
    const nextIndex = start + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return false;
    return selectModelReviewItem(items[nextIndex].path, { focus });
}

function nearestModelReviewCard(carousel) {
    const cards = [...(carousel?.querySelectorAll('.model-review-card') || [])];
    if (!cards.length) return null;
    if (Number.isFinite(carousel.scrollLeft) && Number.isFinite(carousel.clientWidth)) {
        const center = carousel.scrollLeft + carousel.clientWidth / 2;
        const nearest = cards.reduce((match, card) => {
            if (!Number.isFinite(card.offsetLeft) || !Number.isFinite(card.offsetWidth)) {
                return match;
            }
            const distance = Math.abs(card.offsetLeft + card.offsetWidth / 2 - center);
            return !match || distance < match.distance ? { card, distance } : match;
        }, null);
        if (nearest) return nearest.card;
    }
    if (typeof carousel.getBoundingClientRect !== 'function') return null;
    const bounds = carousel.getBoundingClientRect();
    const center = bounds.left + bounds.width / 2;
    return cards.reduce((nearest, card) => {
        const cardBounds = card.getBoundingClientRect();
        const distance = Math.abs(cardBounds.left + cardBounds.width / 2 - center);
        return !nearest || distance < nearest.distance ? { card, distance } : nearest;
    }, null)?.card || null;
}

function syncModelReviewSelectionFromScroll(carousel) {
    const card = nearestModelReviewCard(carousel);
    if (!card?.dataset.path) return false;
    if (appState.modelReviewSelectedPath !== card.dataset.path) {
        appState.modelReviewSelectedPath = card.dataset.path;
    }
    markActiveModelReviewCard(carousel, card.dataset.path);
    return true;
}

function requestModelReviewFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 0);
}

function snapToNearestModelReviewCard(carousel) {
    const card = nearestModelReviewCard(carousel);
    if (!card) return false;
    appState.modelReviewSelectedPath = card.dataset.path;
    markActiveModelReviewCard(carousel, card.dataset.path);
    scrollModelReviewCardIntoView(carousel, card, 'smooth');
    return true;
}

function setupModelReviewCarousel(carousel) {
    let framePending = false;
    let pointerId = null;
    let startX = 0;
    let startScrollLeft = 0;
    let dragged = false;
    carousel.addEventListener('scroll', () => {
        if (carousel.classList.contains('is-resolving-card')) return;
        if (framePending) return;
        framePending = true;
        requestModelReviewFrame(() => {
            framePending = false;
            syncModelReviewSelectionFromScroll(carousel);
        });
    }, { passive: true });
    carousel.addEventListener('scrollend', () => {
        if (
            carousel.classList.contains('is-dragging')
            || carousel.classList.contains('is-wheel-scrolling')
            || carousel.classList.contains('is-resolving-card')
        ) return;
        snapToNearestModelReviewCard(carousel);
    });

    let wheelTarget = 0;
    let wheelFramePending = false;
    let lastWheelAt = 0;
    const animateWheel = () => {
        if (carousel.isConnected === false || pointerId !== null) {
            wheelFramePending = false;
            carousel.classList.remove('is-wheel-scrolling');
            return;
        }
        const maximum = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
        wheelTarget = Math.min(maximum, Math.max(0, wheelTarget));
        const distance = wheelTarget - carousel.scrollLeft;
        if (Math.abs(distance) > 0.45) {
            carousel.scrollLeft += distance * 0.22;
        } else {
            carousel.scrollLeft = wheelTarget;
        }
        if (Date.now() - lastWheelAt > 72 && Math.abs(distance) < 0.8) {
            wheelFramePending = false;
            carousel.classList.remove('is-wheel-scrolling');
            snapToNearestModelReviewCard(carousel);
            return;
        }
        requestModelReviewFrame(animateWheel);
    };
    carousel.addEventListener('wheel', event => {
        if (carousel.classList.contains('is-resolving-card')) return;
        if (event.ctrlKey) return;
        const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX)
            ? event.deltaY
            : event.deltaX;
        if (!delta) return;
        event.preventDefault();
        const unit = event.deltaMode === 1
            ? 28
            : event.deltaMode === 2 ? carousel.clientWidth : 1;
        if (!wheelFramePending) wheelTarget = carousel.scrollLeft;
        wheelTarget += delta * unit;
        lastWheelAt = Date.now();
        carousel.classList.add('is-wheel-scrolling');
        if (!wheelFramePending) {
            wheelFramePending = true;
            requestModelReviewFrame(animateWheel);
        }
    }, { passive: false });

    carousel.addEventListener('pointerdown', event => {
        if (carousel.classList.contains('is-resolving-card')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target?.closest?.('.model-review-card-decision')) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startScrollLeft = carousel.scrollLeft;
        dragged = false;
        wheelTarget = carousel.scrollLeft;
        carousel.classList.remove('is-wheel-scrolling');
        carousel.setPointerCapture?.(pointerId);
        carousel.classList.add('is-dragging');
    });
    carousel.addEventListener('pointermove', event => {
        if (pointerId !== event.pointerId) return;
        const distance = event.clientX - startX;
        if (Math.abs(distance) > 4) dragged = true;
        if (!dragged) return;
        event.preventDefault();
        carousel.scrollLeft = startScrollLeft - distance;
    });
    const finishPointer = event => {
        if (pointerId !== event.pointerId) return;
        carousel.releasePointerCapture?.(pointerId);
        pointerId = null;
        carousel.classList.remove('is-dragging');
        if (!dragged) return;
        carousel.dataset.suppressClick = 'true';
        setTimeout(() => { delete carousel.dataset.suppressClick; }, 120);
        snapToNearestModelReviewCard(carousel);
    };
    carousel.addEventListener('pointerup', finishPointer);
    carousel.addEventListener('pointercancel', finishPointer);
}

function setModelReviewCardBusy(path, busy, action = null) {
    if (!path || typeof els === 'undefined') return;
    const card = els.wallpaperGrid?.querySelector(modelReviewCardSelector(path));
    if (!card) return;
    card.classList.toggle('is-busy', busy);
    card.classList.toggle('is-submitting', busy);
    card.setAttribute('aria-busy', String(busy));
    if (busy && action) {
        card.dataset.pendingAction = action;
    } else if (!busy) {
        delete card.dataset.pendingAction;
    }
    const active = card.dataset.path === appState.modelReviewSelectedPath;
    for (const button of card.querySelectorAll('.model-review-card-decision')) {
        const isPendingAction = busy && action && button.classList.contains(
            action === 'keep' ? 'model-review-card-keep' : 'model-review-card-ban',
        );
        button.classList.toggle('is-pending', Boolean(isPendingAction));
        button.setAttribute('aria-busy', String(Boolean(isPendingAction)));
        button.disabled = busy || !active;
    }
}

function hydrateModelReviewCardImages(card, { priority = false } = {}) {
    for (const image of card?.querySelectorAll?.(
        '.model-review-card-backdrop, .model-review-card-image',
    ) || []) {
        image.loading = priority ? 'eager' : 'lazy';
        image.fetchPriority = priority ? 'high' : 'low';
        if (!image.src && image.dataset?.src) {
            image.src = image.dataset.src;
        }
    }
}

function createModelReviewCard(item, index, total) {
    const automaticallyHeld = item.auto_filtered === true;
    const selected = item.path === appState.modelReviewSelectedPath;
    const card = document.createElement('article');
    card.className = 'model-review-card' + (selected ? ' active' : '');
    card.dataset.path = item.path;
    card.tabIndex = selected ? 0 : -1;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-current', String(selected));
    card.setAttribute('aria-posinset', String(index + 1));
    card.setAttribute('aria-setsize', String(total));
    card.setAttribute(
        'aria-label',
        (automaticallyHeld ? 'Automatically held image. ' : 'Model recommendation. ')
            + (item.name || item.path) + '. Card ' + (index + 1) + ' of ' + total + '.',
    );
    card.setAttribute(
        'aria-keyshortcuts',
        'ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space A D X Delete',
    );

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'model-review-card-preview';
    preview.tabIndex = -1;
    preview.title = 'Open full preview (Enter / Space)';
    preview.setAttribute('aria-label', 'Open full preview of ' + (item.name || 'wallpaper'));
    preview.setAttribute('aria-keyshortcuts', 'Enter Space');
    preview.onclick = event => {
        const carousel = preview.closest('.model-review-carousel');
        if (carousel?.dataset.suppressClick === 'true') {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (appState.modelReviewSelectedPath !== item.path) {
            event.preventDefault();
            event.stopPropagation();
            selectModelReviewItem(item.path);
            return;
        }
        previewPreferenceSuggestion(item, event);
    };
    const sourceUrl = imageUrl(item.path);
    const backdrop = document.createElement('img');
    backdrop.className = 'model-review-card-backdrop';
    backdrop.dataset.src = sourceUrl;
    backdrop.loading = 'lazy';
    backdrop.decoding = 'async';
    backdrop.fetchPriority = 'low';
    backdrop.alt = '';
    backdrop.draggable = false;
    backdrop.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.className = 'model-review-card-image';
    image.dataset.src = sourceUrl;
    image.alt = item.name || 'Model review candidate';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.fetchPriority = 'low';
    image.draggable = false;
    image.onerror = () => image.classList.add('missing');
    preview.append(backdrop, image);
    card.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'model-review-card-actions';
    const busy = appState.modelReviewActionInFlight instanceof Set
        && appState.modelReviewActionInFlight.has(item.path);
    const ban = modelReviewMakeButton(
        'Dislike',
        'model-review-card-decision model-review-card-ban',
        () => { void resolveModelReviewDecision(item, 'ban'); },
    );
    ban.disabled = busy || !selected;
    ban.title = automaticallyHeld
        ? 'Confirm the dislike, teach the model, and send to trash (D)'
        : 'Dislike, teach the model, and move to Blocklist (D)';
    ban.setAttribute('aria-keyshortcuts', 'D X Delete');
    decorateModelReviewDecisionButton(ban, 'ban');
    actions.appendChild(ban);

    const keep = modelReviewMakeButton(
        'Keep',
        'model-review-card-decision model-review-card-keep',
        () => { void resolveModelReviewDecision(item, 'keep'); },
    );
    keep.disabled = busy || !selected;
    keep.title = automaticallyHeld
        ? 'Release into your pool (A)'
        : 'Keep in your pool and teach the model (A)';
    keep.setAttribute('aria-keyshortcuts', 'A');
    decorateModelReviewDecisionButton(keep, 'keep');
    actions.appendChild(keep);
    card.appendChild(actions);
    return card;
}

function createModelReviewCarousel(items, source) {
    const carousel = document.createElement('div');
    carousel.className = 'model-review-carousel';
    carousel.dataset.source = source;
    carousel.setAttribute('role', 'list');
    carousel.setAttribute(
        'aria-label',
        source === 'held'
            ? 'Automatically held model review cards'
            : 'Model recommendation cards',
    );
    items.forEach((item, index) => {
        carousel.appendChild(createModelReviewCard(item, index, items.length));
    });
    setupModelReviewCarousel(carousel);
    return carousel;
}

function syncModelReviewSourceControl(deck, data = appState.modelReviewData) {
    const active = activeModelReviewSource(data);
    for (const button of deck?.querySelectorAll?.('.model-review-source-btn') || []) {
        const source = button.dataset.source;
        const count = modelReviewSourceCount(source, data);
        const selected = source === active;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        button.disabled = modelReviewSourceItems(source, data).length === 0;
        const countElement = button.querySelector('.model-review-source-count');
        if (countElement) countElement.textContent = String(count);
    }
}

function createModelReviewSourceControl(data) {
    const control = document.createElement('div');
    control.className = 'model-review-source-control';
    control.setAttribute('role', 'tablist');
    control.setAttribute('aria-label', 'Review source');
    const active = activeModelReviewSource(data);
    const sources = [
        ['held', 'Auto-held'],
        ['recommended', 'Recommended'],
    ];
    sources.forEach(([source, label], index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'model-review-source-btn' + (source === active ? ' active' : '');
        button.dataset.source = source;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(source === active));
        button.tabIndex = source === active ? 0 : -1;
        const text = document.createElement('span');
        text.textContent = label;
        const count = document.createElement('span');
        count.className = 'model-review-source-count';
        count.textContent = String(modelReviewSourceCount(source, data));
        button.append(text, count);
        button.disabled = modelReviewSourceItems(source, data).length === 0;
        button.onclick = () => switchModelReviewSource(source);
        button.onkeydown = event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            const target = sources[(index + direction + sources.length) % sources.length][0];
            if (!modelReviewSourceItems(target).length) return;
            event.preventDefault();
            event.stopPropagation();
            switchModelReviewSource(target);
            control.querySelector(`[data-source="${target}"]`)?.focus?.();
        };
        control.appendChild(button);
    });
    return control;
}

function replaceModelReviewCarousel(deck, source, { focus = false } = {}) {
    const items = modelReviewSourceItems(source);
    if (!deck || !items.length) return false;
    appState.modelReviewSource = source;
    const selected = items.find(item => item.path === appState.modelReviewSelectedPath)
        || items[0];
    appState.modelReviewSelectedPath = selected.path;
    const previous = deck.querySelector('.model-review-carousel');
    const carousel = createModelReviewCarousel(items, source);
    carousel.classList.add('is-lane-entering');
    if (previous) {
        previous.replaceWith(carousel);
    } else {
        deck.insertBefore(carousel, deck.querySelector('.model-review-deck-nav.next'));
    }
    markActiveModelReviewCard(carousel, selected.path);
    syncModelReviewSourceControl(deck);
    requestModelReviewFrame(() => {
        const card = carousel.querySelector(modelReviewCardSelector(selected.path));
        scrollModelReviewCardIntoView(carousel, card, 'auto');
        requestModelReviewFrame(() => carousel.classList.remove('is-lane-entering'));
        if (focus) card?.focus?.({ preventScroll: true });
    });
    return true;
}

function switchModelReviewSource(source) {
    if (!['held', 'recommended'].includes(source)) return false;
    if (source === activeModelReviewSource()) return false;
    const deck = els.wallpaperGrid?.querySelector('.model-review-deck');
    return replaceModelReviewCarousel(deck, source);
}

function applyModelReviewDecisionResult(item, action, result) {
    const automaticallyHeld = item?.auto_filtered === true;
    const itemsBefore = modelReviewVisibleItems();
    const indexBefore = itemsBefore.findIndex(candidate => candidate.path === item.path);
    if (!(appState.modelReviewResolvedPaths instanceof Set)) {
        appState.modelReviewResolvedPaths = new Set();
    }
    appState.modelReviewResolvedPaths.add(item.path);
    if (typeof invalidateModelReviewRecommendationCache === 'function') {
        invalidateModelReviewRecommendationCache(item.path);
    }
    if (appState.modelReviewData) {
        const data = appState.modelReviewData;
        const sourceKey = automaticallyHeld ? 'items' : 'recommendations';
        const sourceItems = Array.isArray(data[sourceKey]) ? data[sourceKey] : [];
        const remaining = sourceItems.filter(candidate => candidate?.path !== item.path);
        const removed = remaining.length < sourceItems.length;
        const updated = {
            ...data,
            learning: result?.learning || data.learning,
            [sourceKey]: remaining,
        };
        if (automaticallyHeld) {
            const pending = Number(data.pending_count);
            updated.pending_count = removed && Number.isFinite(pending)
                ? Math.max(0, pending - 1)
                : data.pending_count;
            updated.model_filter = result?.model_filter || data.model_filter;
        } else {
            const recommendationCount = Number(data.recommendation_count);
            updated.recommendation_count = removed && Number.isFinite(recommendationCount)
                ? Math.max(0, recommendationCount - 1)
                : data.recommendation_count;
            updated.recommendation_learning = result?.learning
                || data.recommendation_learning;
        }
        appState.modelReviewData = updated;
    }

    const next = modelReviewVisibleItems();
    appState.modelReviewSelectedPath = next[indexBefore]?.path
        || next[indexBefore - 1]?.path
        || next[0]?.path
        || null;

    if (automaticallyHeld) {
        if (!appState.status || typeof appState.status !== 'object') appState.status = {};
        appState.status.model_review_count = Math.max(
            0,
            Number(appState.status.model_review_count || 0) - 1,
        );
        if (action === 'keep' && result?.review?.new_path) {
            appState.status.pool_count = Number(appState.status.pool_count || 0) + 1;
        }
        if (action === 'ban') {
            appState.status.blocklist_count = Number(appState.status.blocklist_count || 0) + 1;
        }
    }
    return appState.modelReviewSelectedPath;
}

function syncModelReviewCarouselPositions(carousel) {
    const cards = [...(carousel?.querySelectorAll('.model-review-card') || [])];
    const total = cards.length;
    cards.forEach((card, index) => {
        card.setAttribute('aria-posinset', String(index + 1));
        card.setAttribute('aria-setsize', String(total));
    });
}

function removeResolvedModelReviewCard(path, action) {
    const carousel = els.wallpaperGrid?.querySelector('.model-review-carousel');
    const card = carousel?.querySelector(modelReviewCardSelector(path));
    const remaining = modelReviewVisibleItems();
    if (!carousel || !card) {
        renderModelReviewView();
        return;
    }

    const nextSource = activeModelReviewSource();
    const deck = carousel.closest?.('.model-review-deck');
    const nextPath = appState.modelReviewSelectedPath || remaining[0]?.path || null;
    const nextCard = carousel.dataset.source === nextSource && nextPath
        ? carousel.querySelector(modelReviewCardSelector(nextPath))
        : null;

    // Activate the following card before collapsing the outgoing card. Its
    // flex space then shrinks to zero, so the rest of the stack naturally
    // slides into place without a second scroll animation.
    carousel.classList.add('is-resolving-card');
    if (nextCard) markActiveModelReviewCard(carousel, nextPath);
    card.classList.add('is-resolving', action === 'keep' ? 'resolve-keep' : 'resolve-ban');
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        card.removeEventListener('transitionend', finishTransition);
        card.remove();
        carousel.classList.remove('is-resolving-card');
        if (!remaining.length) {
            const queuedRecommendations = Number(
                appState.modelReviewData?.recommendation_count,
            );
            if (
                nextSource === 'recommended'
                && Number.isFinite(queuedRecommendations)
                && queuedRecommendations > 0
                && typeof fetchModelReview === 'function'
            ) {
                fetchModelReview({ orient: appState.currentOrient })
                    .catch(error => console.debug('Could not load the next review batch:', error));
                return;
            }
            renderModelReviewView();
            return;
        }
        if (carousel.dataset.source !== nextSource) {
            replaceModelReviewCarousel(deck, nextSource, { focus: true });
            return;
        }
        syncModelReviewCarouselPositions(carousel);
        syncModelReviewSourceControl(deck);
        const selectedPath = nextPath || remaining[0].path;
        appState.modelReviewSelectedPath = selectedPath;
        markActiveModelReviewCard(carousel, selectedPath, { force: true });
        carousel.querySelector(modelReviewCardSelector(selectedPath))
            ?.focus?.({ preventScroll: true });
    };
    const finishTransition = event => {
        if (event.target !== card || event.propertyName !== 'flex-basis') return;
        finish();
    };
    card.addEventListener('transitionend', finishTransition);
    setTimeout(finish, 440);
}

async function resolveModelReviewDecision(item, action) {
    if (!item?.path || !['keep', 'ban'].includes(action)) return false;
    if (!(appState.modelReviewActionInFlight instanceof Set)) {
        appState.modelReviewActionInFlight = new Set();
    }
    if (appState.modelReviewActionInFlight.has(item.path)) return false;
    appState.modelReviewActionInFlight.add(item.path);
    // Mark the choice before the network request starts.  The old UI only
    // changed after the request returned, which made a click feel ignored on
    // a slow API or while a local model action was being queued.
    setModelReviewCardBusy(item.path, true, action);
    try {
        let result;
        if (item.auto_filtered === true) {
            result = await WayperApi.modelReviewAction(item.path, action);
        } else if (action === 'keep') {
            result = await WayperApi.preferenceFeedback(item.path, 'keep');
        } else {
            result = await banImage(item.path, {
                preserveView: true,
                preferenceContext: 'model_review',
                returnResult: true,
            });
            if (!result) return false;
        }
        applyModelReviewDecisionResult(item, action, result);
        updateStatusUI();
        removeResolvedModelReviewCard(item.path, action);
        return true;
    } catch (error) {
        console.error('Failed to ' + action + ' model review item:', error);
        alert('Could not ' + action + ' ' + (item.name || 'this wallpaper')
            + ': ' + error.message);
        return false;
    } finally {
        appState.modelReviewActionInFlight.delete(item.path);
        setModelReviewCardBusy(item.path, false);
    }
}

function modelReviewZeroStatePresentation(data) {
    const strategy = modelReviewStrategy(data);
    const modelFilter = data?.model_filter || {};
    const recommendationStatus = data?.recommendation_status || data?.status || 'untrained';
    const unavailable = data?.status === 'error'
        || recommendationStatus === 'error'
        || modelFilter.status === 'error';

    if (unavailable) {
        return {
            variant: 'unavailable',
            eyebrow: 'Needs attention',
            title: 'Review is temporarily unavailable',
            detail: data?.error
                || modelFilter.reason
                || 'Wayper could not update the review queue. Your wallpapers are unchanged.',
            action: 'retry',
            actionLabel: 'Try again',
        };
    }
    // Recommended is an active-learning lane and remains useful while the
    // separate unattended/Auto-held calibration is still collecting labels.
    if (recommendationStatus !== 'ready') {
        return {
            variant: 'learning',
            eyebrow: 'Getting ready',
            title: 'The model is still learning',
            detail: modelFilter.reason
                || 'Keep or Dislike a few wallpapers to build enough preference feedback.',
            action: 'pool',
            actionLabel: 'Browse Pool',
        };
    }
    return {
        variant: 'complete',
        eyebrow: 'Queue clear',
        title: 'You’re all caught up',
        detail: modelFilter.status === 'calibration_pending'
            ? 'Recommended is ready; Auto-held will activate after the next calibration refresh.'
            : strategy === 'rules'
            ? 'There are no model recommendations waiting. Rules continue to filter new downloads.'
            : 'There are no auto-held images or recommendations waiting for this monitor.',
        action: 'pool',
        actionLabel: 'Back to Pool',
    };
}

function createModelReviewZeroState(data) {
    const presentation = modelReviewZeroStatePresentation(data);
    const section = document.createElement('section');
    section.className = `model-review-zero-state is-${presentation.variant}`;
    section.setAttribute('role', presentation.variant === 'unavailable' ? 'alert' : 'status');

    const icon = document.createElement('div');
    icon.className = 'model-review-zero-icon';
    icon.setAttribute('aria-hidden', 'true');
    const icons = {
        complete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/></svg>',
        learning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.15 3.35L16.5 7.5l-3.35 1.15L12 12l-1.15-3.35L7.5 7.5l3.35-1.15L12 3Z"/><path d="m18.5 13 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z"/><path d="M5.5 13.5 6.3 16l2.2.7-2.2.8L5.5 20l-.8-2.5-2.2-.8 2.2-.7.8-2.5Z"/></svg>',
        unavailable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/></svg>',
    };
    icon.innerHTML = icons[presentation.variant];
    section.appendChild(icon);

    const eyebrow = document.createElement('span');
    eyebrow.className = 'model-review-zero-eyebrow';
    eyebrow.textContent = presentation.eyebrow;
    section.appendChild(eyebrow);

    const title = document.createElement('h2');
    title.textContent = presentation.title;
    const detail = document.createElement('p');
    detail.textContent = presentation.detail;
    section.appendChild(title);
    section.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'model-review-zero-actions';
    actions.appendChild(modelReviewMakeButton(
        presentation.actionLabel,
        `model-review-zero-action is-${presentation.action}`,
        () => presentation.action === 'retry' ? refreshImages() : setViewMode('pool'),
    ));
    section.appendChild(actions);
    return section;
}

function createModelReviewWorkspace(data) {
    const source = activeModelReviewSource(data);
    const items = modelReviewVisibleItems(data);
    const workspace = document.createElement('div');
    workspace.className = 'model-review-workspace';
    workspace.setAttribute('role', 'region');
    workspace.setAttribute('aria-label', 'Model review');
    workspace.setAttribute(
        'aria-keyshortcuts',
        'ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space A X Delete',
    );

    if (!items.length && data?.recommendation_status === 'pending') {
        return workspace;
    }
    if (!items.length) {
        workspace.appendChild(createModelReviewZeroState(data));
        return workspace;
    }

    selectedModelReviewItem(data);
    const deck = document.createElement('section');
    deck.className = 'model-review-deck';
    deck.setAttribute('aria-label', 'Model review card deck');
    deck.appendChild(createModelReviewSourceControl(data));

    const previous = modelReviewMakeButton(
        '←',
        'model-review-deck-nav previous',
        () => moveModelReviewSelection(-1),
    );
    previous.disabled = items.length < 2;
    previous.title = 'Previous card (Left arrow)';
    previous.setAttribute('aria-label', 'Previous review card');
    decorateModelReviewNavButton(previous, -1);
    deck.appendChild(previous);

    const carousel = createModelReviewCarousel(items, source);
    deck.appendChild(carousel);

    const next = modelReviewMakeButton(
        '→',
        'model-review-deck-nav next',
        () => moveModelReviewSelection(1),
    );
    next.disabled = items.length < 2;
    next.title = 'Next card (Right arrow)';
    next.setAttribute('aria-label', 'Next review card');
    decorateModelReviewNavButton(next, 1);
    deck.appendChild(next);

    markActiveModelReviewCard(carousel, appState.modelReviewSelectedPath);
    syncModelReviewSourceControl(deck, data);

    workspace.appendChild(deck);
    return workspace;
}
function renderModelReviewView() {
    if (!modelReviewModeActive()) return;
    removeBlocklistSentinel();
    if (sentinel?.parentNode) sentinel.remove();
    observer?.unobserve?.(sentinel);
    els.wallpaperGrid.innerHTML = '';
    appState.currentBatchIndex = 0;
    if (!appState.modelReviewData) return;
    const data = appState.modelReviewData;
    els.wallpaperGrid.appendChild(createModelReviewWorkspace(data));
    const selectedPath = appState.modelReviewSelectedPath;
    if (selectedPath) {
        requestModelReviewFrame(() => {
            const carousel = els.wallpaperGrid.querySelector('.model-review-carousel');
            const card = carousel?.querySelector(modelReviewCardSelector(selectedPath));
            if (!carousel || !card) return;
            const previousBehavior = carousel.style.scrollBehavior;
            carousel.style.scrollBehavior = 'auto';
            scrollModelReviewCardIntoView(carousel, card, 'auto');
            markActiveModelReviewCard(carousel, selectedPath);
            requestModelReviewFrame(() => {
                carousel.style.scrollBehavior = previousBehavior;
            });
        });
    }
}

function syncPreferenceReviewLayout() {
    // The card deck sizes itself from the viewport and needs no legacy grid
    // reconciliation on resize.
    if (modelReviewModeActive()) {
        return;
    }
    const panel = typeof els !== 'undefined'
        ? els.wallpaperGrid?.querySelector('.model-review-panel')
        : null;
    if (!panel || (appState.mode !== 'trash' && !modelReviewModeActive())) return;
    const list = panel.querySelector('.model-review-list');
    const limit = preferenceReviewDisplayLimit(list);
    if (Number(panel.dataset.visibleLimit) !== limit) {
        syncPreferenceReviewRows(panel);
    }
    if (preferenceReviewVisibleItems(list).length < limit) {
        void refillPreferenceReviewCandidates();
    }
}

function createPreferenceReviewPanel() {
    const data = appState.preferenceSuggestions;
    if (!data || typeof data !== 'object') return null;

    const panel = document.createElement('section');
    panel.className = 'model-review-panel';
    panel.tabIndex = -1;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Model review');

    const header = document.createElement('div');
    header.className = 'model-review-header';
    const heading = document.createElement('div');
    heading.className = 'model-review-heading';
    const title = document.createElement('span');
    title.className = 'model-review-title';
    title.textContent = 'Review';
    heading.appendChild(title);
    const subtitle = document.createElement('span');
    subtitle.className = 'model-review-subtitle';
    subtitle.textContent = modelReviewModeActive()
        ? 'Automatically held by the model · inspect, Keep or Dislike · Enter/Space · A/D'
        : 'Ranked by local tag/context evidence · Tab/Arrows · Enter/Space · A/D';
    heading.appendChild(subtitle);
    const count = document.createElement('span');
    count.className = 'model-review-count';
    const pending = Number(data.pending_count);
    count.textContent = preferenceReviewCountText(
        modelReviewModeActive() && Number.isFinite(pending)
            ? pending
            : preferenceReviewVisibleItems().length,
    );
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
    syncPreferenceReviewRows(panel);
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
                const chip = document.createElement('button');
                chip.type = 'button';
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
                <button class="action-btn url" title="Open on Wallhaven (O)" aria-keyshortcuts="O">${ICONS.externalLink()}</button>
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
                <button class="action-btn" title="Set Wallpaper (Enter)" aria-keyshortcuts="Enter">${ICONS.setWallpaper()}</button>
                <button class="action-btn fav ${img.is_favorite ? 'active' : ''}" title="Favorite (F)" aria-keyshortcuts="F">${ICONS.favorite(16, img.is_favorite)}</button>
                <button class="action-btn dislike" title="Dislike and teach the model (D)" aria-keyshortcuts="D">${ICONS.dislike()}</button>
                <button class="action-btn ban" title="Ban this exact image only (X)" aria-keyshortcuts="X Delete">${ICONS.ban()}</button>
                <button class="action-btn url" title="Open on Wallhaven (O)" aria-keyshortcuts="O">${ICONS.externalLink()}</button>
            </div>
        `;
        const cardImg = card.querySelector('img');
        cardImg.onload = () => cardImg.classList.remove('loading');
        card.onclick = () => showLightbox(img);
        const btns = card.querySelectorAll('.action-btn');
        btns[0].onclick = (e) => { e.stopPropagation(); setWallpaper(img.path); };
        btns[1].onclick = (e) => { e.stopPropagation(); toggleFavoriteImage(img.path); };
        btns[2].onclick = (e) => {
            e.stopPropagation();
            card.focus({ preventScroll: true });
            dislikeImage(img.path);
        };
        btns[3].onclick = (e) => {
            e.stopPropagation();
            card.focus({ preventScroll: true });
            banImage(img.path);
        };
        btns[4].onclick = (e) => { e.stopPropagation(); openWallhavenUrl(img.name); };
    }

    return card;
}
