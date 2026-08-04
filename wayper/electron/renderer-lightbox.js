// --- Lightbox ---

let lightboxEl = null;
let lightboxImg = null;
let _imgEl = null;
let _stageEl = null;
let zoom = { scale: 1, x: 0, y: 0 };
let dragState = null;
let lightboxPreviousFocus = null;
let lightboxPreviousReviewPath = null;
let lightboxCloseTimer = null;

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
    if (lightboxImg?.reviewOnly) {
        navigateReviewLightbox(direction);
        return;
    }
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
    if (
        typeof document === 'undefined'
        || typeof document.querySelector !== 'function'
        || typeof CSS === 'undefined'
        || typeof CSS.escape !== 'function'
    ) return;
    const card = document.querySelector(`.wallpaper-card[data-path="${CSS.escape(path)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    card.focus({ preventScroll: true });
}

function lightboxFocusableElements() {
    if (!lightboxEl) return [];
    return [...lightboxEl.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.disabled && element.getAttribute?.('aria-hidden') !== 'true');
}

function focusLightboxEntry(element = lightboxEl) {
    // Focus the dialog itself first.  This preserves the established
    // Enter/Space shortcuts and avoids treating a repeated preview key as an
    // accidental Keep; the first Tab moves to the first toolbar action.
    if (element && typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
    }
}

function handleLightboxKeydown(event) {
    if (!lightboxEl) return;

    if (event.key === 'Tab') {
        const focusable = lightboxFocusableElements();
        if (!focusable.length) {
            event.preventDefault();
            lightboxEl.focus?.({ preventScroll: true });
            return;
        }
        const currentIndex = focusable.indexOf(document.activeElement);
        let nextIndex;
        if (event.shiftKey) {
            nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
        } else {
            nextIndex = currentIndex < 0 || currentIndex >= focusable.length - 1
                ? 0
                : currentIndex + 1;
        }
        event.preventDefault();
        focusable[nextIndex].focus({ preventScroll: true });
        return;
    }

    // Native button activation (Enter/Space) must win over the document-level
    // lightbox shortcuts.  The click handlers below perform the action.
    if ((event.key === 'Enter' || event.key === ' ') && event.target?.closest?.('button')) {
        event.stopPropagation();
    }
}

function setLightboxReturnFocus(element) {
    if (!element || typeof element.focus !== 'function') return false;
    lightboxPreviousFocus = element;
    return true;
}

function restoreLightboxFocus(previous, reviewPath) {
    // An asynchronous review action may already have restored focus to the
    // surviving queue before the fade-out timer runs.  Do not steal it back
    // to the removed candidate (or to the first row) in that case.
    if (
        reviewPath
        && typeof document !== 'undefined'
        && document.activeElement?.closest?.('.model-review-workspace, .model-review-panel')
    ) {
        return;
    }
    if (
        previous
        && previous.isConnected !== false
        && !previous.disabled
        && typeof previous.focus === 'function'
    ) {
        previous.focus({ preventScroll: true });
        return;
    }
    if (
        reviewPath
        && typeof focusPreferenceReviewCandidate === 'function'
        && focusPreferenceReviewCandidate(reviewPath)
    ) {
        return;
    }
    // A normal gallery preview should not jump into an unrelated review panel
    // merely because its original card disappeared while the dialog was open.
    if (!reviewPath) return;
    // A candidate may have been removed while the review lightbox was open.
    // Keep keyboard users in the review surface whenever a replacement exists.
    const reviewFallback = document.querySelector?.('.model-review-card.active')
        || document.querySelector?.('.model-review-card:not(.is-busy)')
        || document.querySelector?.('.model-review-row button:not(:disabled)')
        || document.querySelector?.('.model-review-row:not(.is-busy)');
    if (reviewFallback?.focus) {
        reviewFallback.focus({ preventScroll: true });
        return;
    }
    const reviewPanel = document.querySelector?.(
        '.model-review-workspace, .model-review-panel',
    );
    if (reviewPanel?.focus) {
        reviewPanel.focus({ preventScroll: true });
    }
}

function showLightbox(img) {
    const opening = !lightboxEl;
    const focusBeforeOpen = document.activeElement;
    if (lightboxEl && lightboxCloseTimer !== null) {
        clearTimeout(lightboxCloseTimer);
        lightboxCloseTimer = null;
        lightboxEl.classList.add('visible');
    }
    if (opening) {
        lightboxPreviousReviewPath = img.reviewOnly === true ? img.path : null;
    }
    lightboxImg = img;
    syncGalleryToLightbox(img.path);
    if (opening) {
        const syncedFocus = document.activeElement;
        lightboxPreviousFocus = syncedFocus && syncedFocus !== document.body
            ? syncedFocus
            : focusBeforeOpen;
    }
    const reviewOnly = img.reviewOnly === true;
    const isTrash = img.isTrash ?? appState.mode === 'trash';

    // If lightbox already exists, just swap the image (avoids DOM thrashing)
    if (lightboxEl) {
        _imgEl.src = imageUrl(img.path);
        resetZoom();
        focusLightboxEntry(lightboxEl);
        return;
    }

    lightboxEl = document.createElement('div');
    lightboxEl.className = reviewOnly ? 'lightbox review-lightbox' : 'lightbox';
    lightboxEl.tabIndex = -1;
    lightboxEl.setAttribute?.('role', 'dialog');
    lightboxEl.setAttribute?.('aria-modal', 'true');
    lightboxEl.setAttribute?.(
        'aria-label',
        reviewOnly
            ? 'Review preview; use left and right arrows to switch candidates'
            : 'Wallpaper preview',
    );
    if (reviewOnly) {
        lightboxEl.setAttribute?.(
            'aria-keyshortcuts',
            'ArrowLeft ArrowRight A D X Delete Escape',
        );
    }
    lightboxEl.innerHTML = `
        <div class="lightbox-backdrop"></div>
        <div class="lightbox-stage">
            <img class="lightbox-image" src="${imageUrl(img.path)}" alt="">
        </div>
        <div class="lightbox-toolbar">
            ${reviewOnly ? `
                <button class="lb-btn review-lightbox-decision review-lightbox-ban" data-action="ban" title="Dislike and teach the model (D)">
                    <span>Dislike</span><kbd class="review-keycap">D</kbd>
                </button>
                <button class="lb-btn review-lightbox-decision review-lightbox-keep" data-action="keep" title="Keep (A)">
                    <span>Keep</span><kbd class="review-keycap">A</kbd>
                </button>
            ` : isTrash ? `
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
                <button class="lb-btn" data-action="dislike" title="Dislike and teach the model (D)">
                    ${ICONS.dislike(18)}<span>Dislike</span><kbd>D</kbd>
                </button>
                <button class="lb-btn" data-action="ban" title="Ban this exact image only (X)">
                    ${ICONS.ban(18)}<span>Ban</span><kbd>X</kbd>
                </button>
            `}
            <div class="lb-spacer"></div>
            <button class="lb-btn" data-action="url" title="Open on Wallhaven (O)">
                ${ICONS.externalLink(18)}<span>Wallhaven</span><kbd>O</kbd>
            </button>
        </div>
        <button class="lightbox-close" title="Close (Esc)">${ICONS.close(20)}</button>
        ${reviewOnly ? '' : `
            <button class="lightbox-nav prev" title="Previous image">${ICONS.chevronLeft()}</button>
            <button class="lightbox-nav next" title="Next image">${ICONS.chevronRight()}</button>
        `}
    `;

    document.body.appendChild(lightboxEl);
    const createdLightbox = lightboxEl;
    _stageEl = lightboxEl.querySelector('.lightbox-stage');
    _imgEl = lightboxEl.querySelector('.lightbox-image');
    resetZoom();
    const revealLightbox = () => {
        if (lightboxEl !== createdLightbox) return;
        createdLightbox.classList.add('visible');
    };
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(revealLightbox);
    } else {
        revealLightbox();
    }

    // Wheel zoom on the stage (anchored at cursor)
    _stageEl.addEventListener('wheel', handleWheel, { passive: false });
    // Drag to pan: mousedown on image; window mousemove/up are attached on demand in handleMouseDown
    // so dragging continues outside the image bounds without firing on every idle mouse move.
    _imgEl.addEventListener('mousedown', handleMouseDown);
    _imgEl.addEventListener('dblclick', handleDoubleClick);
    lightboxEl.addEventListener('keydown', handleLightboxKeydown);

    // All button actions read from lightboxImg (not closure) to stay current after navigation
    lightboxEl.querySelector('.lightbox-backdrop').onclick = closeLightbox;
    const closeButton = lightboxEl.querySelector('.lightbox-close');
    closeButton.setAttribute?.('aria-label', 'Close preview (Escape)');
    closeButton.onclick = closeLightbox;
    if (!reviewOnly) {
        const previousButton = lightboxEl.querySelector('.lightbox-nav.prev');
        const nextButton = lightboxEl.querySelector('.lightbox-nav.next');
        previousButton.setAttribute?.('aria-label', 'Previous image');
        nextButton.setAttribute?.('aria-label', 'Next image');
        previousButton.onclick = () => navigateLightbox(-1);
        nextButton.onclick = () => navigateLightbox(1);
    }

    lightboxEl.querySelectorAll('.lb-btn').forEach(btn => {
        const action = btn.dataset.action;
        if (action === 'keep') {
            btn.setAttribute?.('aria-label', 'Keep reviewed candidate (A)');
            btn.setAttribute?.('aria-keyshortcuts', 'A');
        } else if (action === 'ban' && reviewOnly) {
            btn.setAttribute?.('aria-label', 'Dislike reviewed candidate (D)');
            btn.setAttribute?.('aria-keyshortcuts', 'D X Delete');
        } else if (action === 'dislike') {
            btn.setAttribute?.('aria-label', 'Dislike and teach the model (D)');
            btn.setAttribute?.('aria-keyshortcuts', 'D');
        } else if (action === 'ban') {
            btn.setAttribute?.('aria-label', 'Ban this exact image only (X)');
            btn.setAttribute?.('aria-keyshortcuts', 'X Delete');
        }
        btn.onclick = (e) => {
            e.stopPropagation();
            if (!lightboxImg) return;
            if (action === 'set') { setWallpaper(lightboxImg.path); closeLightbox(); }
            else if (action === 'fav') { toggleFavoriteImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'keep' && lightboxImg.reviewOnly) {
                void keepLightboxReviewSuggestion();
            }
            else if (action === 'dislike' && !lightboxImg.reviewOnly) {
                dislikeImage(lightboxImg.path);
                closeLightbox();
            }
            else if (action === 'ban') {
                if (lightboxImg.reviewOnly) {
                    void banLightboxReviewSuggestion();
                } else {
                    banImage(lightboxImg.path);
                    closeLightbox();
                }
            }
            else if (action === 'restore') { restoreImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'url') { openWallhavenUrl(lightboxImg.name); }
        };
    });
    // Move focus synchronously so a keyboard user can immediately Tab through
    // the dialog, even before the opening animation's next frame.
    focusLightboxEntry(lightboxEl);
}

function closeLightbox(event) {
    if (!lightboxEl) return;
    // The lightbox is a separate overlay.  Keep its close gesture from
    // bubbling into the underlying blocklist controls or triggering a second
    // page-level action.
    event?.preventDefault();
    event?.stopPropagation();
    // Safety net: if a drag is in flight when closing, tear down its window listeners
    if (dragState) {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        dragState = null;
    }
    const closingLightbox = lightboxEl;
    const previousFocus = lightboxPreviousFocus;
    const previousReviewPath = lightboxPreviousReviewPath;
    lightboxEl.classList.remove('visible');
    if (lightboxCloseTimer !== null) clearTimeout(lightboxCloseTimer);
    lightboxCloseTimer = setTimeout(() => {
        // Do not tear down a newer lightbox if one was opened during the fade.
        if (lightboxEl !== closingLightbox) {
            lightboxCloseTimer = null;
            return;
        }
        closingLightbox.remove();
        lightboxEl = null;
        lightboxImg = null;
        _imgEl = null;
        _stageEl = null;
        lightboxCloseTimer = null;
        lightboxPreviousFocus = null;
        lightboxPreviousReviewPath = null;
        restoreLightboxFocus(previousFocus, previousReviewPath);
    }, 200);
}

function reviewLightboxItems() {
    if (typeof preferenceReviewItems === 'function') {
        return preferenceReviewItems();
    }
    const items = appState.preferenceSuggestions?.items;
    return Array.isArray(items) ? items : [];
}

function reviewLightboxNeighbor(items, currentPath, direction) {
    if (!Array.isArray(items)) return null;
    const index = items.findIndex(item => item?.path === currentPath);
    if (index < 0) return null;
    const step = direction === 'ArrowLeft'
        ? -1
        : direction === 'ArrowRight' ? 1 : Number(direction);
    if (!Number.isFinite(step) || step === 0) return null;
    const nextIndex = index + step;
    return nextIndex >= 0 && nextIndex < items.length ? items[nextIndex] : null;
}

function navigateReviewLightbox(direction) {
    if (!lightboxImg?.reviewOnly) return false;
    const items = reviewLightboxItems();
    const next = reviewLightboxNeighbor(items, lightboxImg.path, direction);
    if (!next) return false;
    // Restore focus to the candidate that was last previewed, rather than the
    // row that opened the lightbox, when Escape closes after a left/right hop.
    const nextRow = typeof preferenceReviewRow === 'function'
        ? preferenceReviewRow(next.path)
        : (
            typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
                ? [...document.querySelectorAll('.model-review-row')]
                    .find(row => row.dataset?.path === next.path)
                : null
        );
    if (nextRow) lightboxPreviousFocus = nextRow;
    lightboxPreviousReviewPath = next.path;
    showLightbox({ ...next, isTrash: false, reviewOnly: true });
    return true;
}

function navigateLightbox(direction) {
    if (!lightboxImg) return;
    if (lightboxImg.reviewOnly) {
        navigateReviewLightbox(direction);
        return;
    }
    const idx = appState.images.findIndex(i => i.path === lightboxImg.path);
    if (idx === -1) return;
    const next = idx + direction;
    if (next >= 0 && next < appState.images.length) {
        showLightbox(appState.images[next]);
    }
}
