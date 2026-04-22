# Lightbox Zoom & Pan

**Date:** 2026-04-22
**Status:** Design

## Overview

Add full image-viewer interactions to the existing lightbox: scroll-wheel zoom anchored at the cursor, click-and-drag pan, double-click toggle, keyboard zoom controls, and pan-then-navigate behavior for arrow keys when zoomed in. Today the lightbox displays an image at fit-to-screen with no further inspection — users cannot zoom into details.

## Problem

The current lightbox (`renderer.js` `showLightbox` / `closeLightbox` / `navigateLightbox`) is read-only:
- The image renders at fit (`max-width: calc(100vw - 120px); max-height: calc(100vh - 100px)`) with no zoom mechanism
- Mouse wheel events are not intercepted, so they either do nothing or scroll the page underneath
- There is no way to inspect a region of the image without opening the file externally

Users want to zoom into faces / textures / signatures within the GUI, with the standard image-viewer keybindings they already know.

## Design

### State

Module-level zoom state (single instance — there is only ever one lightbox):

```js
let zoom = { scale: 1, x: 0, y: 0 };  // x/y = pan offset in CSS pixels, scale relative to fit
let dragState = null;                  // { startX, startY, startTx, startTy, moved } during drag
```

`scale = 1` means fit-to-screen (the existing layout box). `scale > 1` zooms in; `scale < 1` zooms out. `x` / `y` translate the rendered image relative to its layout center.

### DOM Structure

Wrap the `<img class="lightbox-image">` in a `<div class="lightbox-stage">`:

```html
<div class="lightbox">
  <div class="lightbox-backdrop"></div>
  <div class="lightbox-stage">
    <img class="lightbox-image" alt="">
  </div>
  <div class="lightbox-toolbar">…</div>
  <button class="lightbox-close">…</button>
  <button class="lightbox-nav prev">…</button>
  <button class="lightbox-nav next">…</button>
</div>
```

The stage owns the entry animation (the existing `transform: scale(0.92 → 1)` + opacity fade). The image's `transform` is owned exclusively by JS (`translate(x,y) scale(s)`). This decouples entry from interactive zoom, eliminating the conflict between CSS-controlled and JS-controlled transforms.

### CSS Changes (`styles.css`)

- Move the existing entry transition rules from `.lightbox-image` / `.lightbox.visible .lightbox-image` to `.lightbox-stage` / `.lightbox.visible .lightbox-stage`.
- The `.lightbox-stage` keeps the existing `max-width` / `max-height` constraints so the image's layout box stays fit-sized.
- `.lightbox-image` gains `transition: transform 0.12s ease-out`, `cursor: grab`, `user-select: none`, `-webkit-user-drag: none`.
- `.lightbox-image.dragging` sets `cursor: grabbing` and `transition: none` (so panning feels 1:1 with the cursor).

### Wheel Zoom (cursor-anchored)

```js
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
const ZOOM_RATE = 0.0015;  // tuned for typical wheel deltaY ≈ 100/notch → ~16% per notch

function handleWheel(e) {
    e.preventDefault();
    const stage = lightboxEl.querySelector('.lightbox-stage');
    const rect = stage.getBoundingClientRect();
    const cX = rect.left + rect.width / 2;
    const cY = rect.top + rect.height / 2;

    const oldScale = zoom.scale;
    const newScale = clamp(oldScale * Math.exp(-e.deltaY * ZOOM_RATE), ZOOM_MIN, ZOOM_MAX);
    if (newScale === oldScale) return;

    const r = newScale / oldScale;
    zoom.x = (e.clientX - cX) * (1 - r) + r * zoom.x;
    zoom.y = (e.clientY - cY) * (1 - r) + r * zoom.y;
    zoom.scale = newScale;
    clampPan();
    applyZoom();
}
```

The stage's bounding rect gives the un-transformed center, since the stage itself is not affected by the image's transform. The translate-update keeps the image-local point under the cursor pinned to the cursor across the zoom change.

### Pan (drag)

Mousedown on `.lightbox-image` (left button only) starts a drag:

```js
function handleMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState = {
        startX: e.clientX, startY: e.clientY,
        startTx: zoom.x, startTy: zoom.y,
        moved: false,
    };
    img.classList.add('dragging');
}
```

Mousemove updates `zoom.x/y` from the delta once movement exceeds 5 px (so a still-mouse click is not treated as pan). Mouseup clears `dragState` and the `dragging` class.

Mousedown on `.lightbox-backdrop` keeps its existing close-on-click behavior — backdrop and image have separate handlers, so clicks on the image never close the lightbox.

### Pan Clamping

```js
function clampPan() {
    const stage = lightboxEl.querySelector('.lightbox-stage');
    const rect = stage.getBoundingClientRect();
    const overflowX = Math.max(0, (rect.width * zoom.scale - rect.width) / 2);
    const overflowY = Math.max(0, (rect.height * zoom.scale - rect.height) / 2);
    zoom.x = clamp(zoom.x, -overflowX, overflowX);
    zoom.y = clamp(zoom.y, -overflowY, overflowY);
}
```

When zoomed-out (`scale < 1`), overflow is 0, so the image stays centered. When zoomed-in, the image can pan but cannot move past its own edges off the stage center — preventing the image from disappearing into the corners.

### Keyboard

Extend the lightbox-specific switch in `handleGlobalKeydown` (renderer.js ~268):

| Key | Behavior |
|---|---|
| `0` | Reset to fit (`zoom = { scale: 1, x: 0, y: 0 }`) |
| `+`, `=` | Zoom in one step at image center (multiply scale by 1.15, clamp) — both keys handled because unshifted `=` and shifted `+` are common, and Numpad `+` is `e.key === '+'` |
| `-` | Zoom out one step at image center (multiply scale by 1/1.15, clamp) |
| `←` | If `scale > 1` and `zoom.x < maxTx`: pan right by 50 px (clamped). Else: `navigateLightbox(-1)` |
| `→` | If `scale > 1` and `zoom.x > -maxTx`: pan left by 50 px (clamped). Else: `navigateLightbox(1)` |
| `Esc`, `Space`, `Enter`, `f`, `x`, `o` | Unchanged from current behavior |

Pan-then-navigate logic ("iOS-style"): when zoomed in, arrow keys pan first; only after reaching the edge in that direction does the next press navigate. This relies on the clamped `zoom.x` already being at `±maxTx` to detect the edge.

### Double-Click

On `.lightbox-image` `dblclick`:
- If `scale === 1`: zoom to 100% original pixels (`scale = naturalWidth / stageWidth`, clamped to `ZOOM_MAX`), anchored at the click position
- Else: reset to fit

The click vs dblclick conflict is handled by the standard `click`/`dblclick` event ordering plus the 5-px drag threshold (a true click without movement reaches `dblclick`).

### Image Swap & Reset

Two code paths swap the displayed image:

1. `navigateLightbox(direction)` — keyboard / nav-button driven
2. `showLightbox(img)` early-return branch when `lightboxEl` already exists (called by `navigateLightbox` and by clicking a different card while the lightbox is open)

Both reset zoom. The cleanest place to do so is inside the `showLightbox` swap branch, since `navigateLightbox` always routes through it:

```js
if (lightboxEl) {
    lightboxEl.querySelector('.lightbox-image').src = imageUrl(img.path);
    resetZoom();
    return;
}
```

Every new image starts at fit, regardless of how the user got there.

```js
function resetZoom() {
    zoom = { scale: 1, x: 0, y: 0 };
    applyZoom();
}
```

`closeLightbox` does not need to reset (the lightbox element is removed entirely after the close animation).

### Apply Transform

```js
function applyZoom() {
    const img = lightboxEl?.querySelector('.lightbox-image');
    if (!img) return;
    img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}
```

Inline `style.transform` overrides any CSS rule on `.lightbox-image`. Since the stage now owns the entry animation, there is no conflict.

### Event Wiring

In `showLightbox`, after `lightboxEl` is appended:

```js
const stage = lightboxEl.querySelector('.lightbox-stage');
const img = lightboxEl.querySelector('.lightbox-image');
stage.addEventListener('wheel', handleWheel, { passive: false });
img.addEventListener('mousedown', handleMouseDown);
img.addEventListener('dblclick', handleDoubleClick);
window.addEventListener('mousemove', handleMouseMove);
window.addEventListener('mouseup', handleMouseUp);
```

Mousemove/mouseup live on `window` so a drag started on the image continues to track even when the cursor leaves the image bounds.

`closeLightbox` must remove the `window` listeners (or use a flag-guarded handler that no-ops when `lightboxEl === null`). Cleanest: store handler refs in a module-level variable so `closeLightbox` can `removeEventListener` them.

## Edge Cases

- **Wheel during entry animation**: zoom math operates on the layout (un-transformed) stage rect, which is correct from the moment the element is appended. Allowed.
- **Drag past viewport**: window-level mousemove handles this; `clampPan` keeps the result inside bounds.
- **Touch / pinch zoom**: out of scope. Electron desktop only.
- **Trackpad pinch**: shows up as `wheel` events with `ctrlKey: true` and small `deltaY`. The same wheel handler will respond, which is the standard browser behavior — acceptable.
- **Toolbar / nav buttons during zoom**: they sit above the image (`z-index: 2`), unaffected by image transform. Their click handlers continue to work.
- **Drag starting on toolbar/nav button**: `handleMouseDown` is bound to `.lightbox-image` only, so drag never starts from buttons.

## Testing

No automated tests exist for the GUI today (per CLAUDE.md guidelines). Manual test plan:

1. Open lightbox on a normal pool image
2. Scroll wheel up → image zooms in centered on cursor; verify the cursor's image-pixel stays under the cursor
3. Scroll wheel down → zooms out; clamps at 0.5×
4. While zoomed in, click and drag → image pans; clamps at edges
5. Press `0` → resets to fit
6. Press `+` / `-` → zooms at center, one step at a time
7. Press `←` while zoomed and not at left edge → pans toward left edge; one more press at the edge → navigates to previous image
8. Same for `→`
9. Double-click on image at fit → zooms to 100% at click position
10. Double-click again → returns to fit
11. Click backdrop while zoomed → closes lightbox
12. Click image (no drag) while zoomed → does nothing (does not close)
13. Press `→` to navigate to next image while zoomed at edge → next image opens at fit (zoom reset)
14. `Esc` closes from any zoom state

## Files Touched

- `wayper/electron/renderer.js` — lightbox state, handlers, DOM template, event wiring
- `wayper/electron/styles.css` — `.lightbox-stage` rules, move entry transition off `.lightbox-image`, add `dragging` class
