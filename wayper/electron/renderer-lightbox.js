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
    const reviewOnly = img.reviewOnly === true;
    const isTrash = img.isTrash ?? appState.mode === 'trash';

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
            ${reviewOnly ? `
                <button class="lb-btn" data-action="keep" title="Keep (K)">
                    ${ICONS.favorite(18)}<span>Keep</span><kbd>K</kbd>
                </button>
                <button class="lb-btn" data-action="ban" title="Ban (X)">
                    ${ICONS.ban(18)}<span>Ban</span><kbd>X</kbd>
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
        ${reviewOnly ? '' : `
            <button class="lightbox-nav prev" title="Previous image">${ICONS.chevronLeft()}</button>
            <button class="lightbox-nav next" title="Next image">${ICONS.chevronRight()}</button>
        `}
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
    if (!reviewOnly) {
        lightboxEl.querySelector('.lightbox-nav.prev').onclick = () => navigateLightbox(-1);
        lightboxEl.querySelector('.lightbox-nav.next').onclick = () => navigateLightbox(1);
    }

    lightboxEl.querySelectorAll('.lb-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (!lightboxImg) return;
            const action = btn.dataset.action;
            if (action === 'set') { setWallpaper(lightboxImg.path); closeLightbox(); }
            else if (action === 'fav') { toggleFavoriteImage(lightboxImg.path); closeLightbox(); }
            else if (action === 'keep' && lightboxImg.reviewOnly) {
                void keepLightboxReviewSuggestion();
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
