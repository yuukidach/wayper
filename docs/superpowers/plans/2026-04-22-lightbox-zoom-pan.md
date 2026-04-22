# Lightbox Zoom & Pan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scroll-wheel zoom (cursor-anchored), drag-pan, double-click toggle, keyboard zoom controls, and pan-then-navigate arrow behavior to the lightbox in `wayper/electron/renderer.js`.

**Architecture:** Wrap the lightbox `<img>` in a `<div class="lightbox-stage">` so the stage owns the entry animation while JS owns the image's `transform` (zoom/pan). Module-level state `zoom = { scale, x, y }` is applied via inline `style.transform`. Window-level mousemove/mouseup listeners track drags; `closeLightbox` removes them.

**Tech Stack:** Vanilla JS (no framework), CSS transitions, Electron renderer process.

**Spec:** `docs/superpowers/specs/2026-04-22-lightbox-zoom-pan-design.md` — read this first.

**Conventions for this codebase (from `CLAUDE.md`):**
- No tests exist; do not add test infrastructure. Verification is **manual** through the running GUI.
- Batch commits: do **one** commit at the end of the plan, not per task.
- Modern JS, no transpilation. The renderer runs in Electron (Chromium).

**How to manually test during implementation:**

The wayper GUI is already running (PID found via `pgrep -af wayper-gui`). After each code change:
1. The Electron window does NOT auto-reload renderer.js. Reload via the running window: `Ctrl+R` (when window is focused), or quit and restart with `wayper-gui &` from a shell.
2. Check DevTools console for errors: `Ctrl+Shift+I` in the Wayper window.
3. To take a screenshot for inspection: `grim -g "$(hyprctl clients -j | python3 -c "import json,sys;[print(f'{c[\"at\"][0]},{c[\"at\"][1]} {c[\"size\"][0]}x{c[\"size\"][1]}') for c in json.load(sys.stdin) if 'wayper' in c.get('class','').lower()]")" /tmp/wayper.png` then read `/tmp/wayper.png`.

---

## File Structure

**Files modified (only two):**

- `wayper/electron/renderer.js` — DOM template, zoom state, handlers, keyboard extensions
- `wayper/electron/styles.css` — `.lightbox-stage` rules, move entry transition, `.dragging` class

No new files. The lightbox lives entirely inside renderer.js (~lines 2369-2454) and styles.css (~lines 1544-1730 for lightbox section).

---

## Task 1: CSS Refactor — Move Entry Transition to Stage Wrapper

**Files:**
- Modify: `wayper/electron/styles.css:1578-1590` (`.lightbox-image` rule) and `:1561-1564` (`.lightbox.visible .lightbox-image`)

**Why this first:** Establishes the wrapper boundary cleanly. After this task, the lightbox still looks identical (the rules apply to `.lightbox-stage` instead, and we'll add the wrapper to the DOM in Task 2).

- [ ] **Step 1.1: Read current `.lightbox-image` and `.lightbox.visible .lightbox-image` CSS**

Read `wayper/electron/styles.css` lines 1561-1590 to confirm the exact current rules before editing.

- [ ] **Step 1.2: Replace `.lightbox-image` rule and add `.lightbox-stage` rule**

Edit `wayper/electron/styles.css`. Find this block (around line 1578):

```css
.lightbox-image {
  position: relative;
  max-width: calc(100vw - 120px);
  max-height: calc(100vh - 100px);
  object-fit: contain;
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
  z-index: 1;
  transform: scale(0.92);
  opacity: 0;
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              opacity 0.25s var(--ease);
}
```

Replace with:

```css
.lightbox-stage {
  position: relative;
  max-width: calc(100vw - 120px);
  max-height: calc(100vh - 100px);
  z-index: 1;
  transform: scale(0.92);
  opacity: 0;
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              opacity 0.25s var(--ease);
}

.lightbox-image {
  display: block;
  max-width: calc(100vw - 120px);
  max-height: calc(100vh - 100px);
  object-fit: contain;
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
  cursor: grab;
  user-select: none;
  -webkit-user-drag: none;
  transition: transform 0.12s ease-out;
  transform-origin: 50% 50%;
}

.lightbox-image.dragging {
  cursor: grabbing;
  transition: none;
}
```

- [ ] **Step 1.3: Replace `.lightbox.visible .lightbox-image` rule**

Edit `wayper/electron/styles.css`. Find this block (around line 1561):

```css
.lightbox.visible .lightbox-image {
  transform: scale(1);
  opacity: 1;
}
```

Replace with:

```css
.lightbox.visible .lightbox-stage {
  transform: scale(1);
  opacity: 1;
}
```

- [ ] **Step 1.4: Verify CSS file syntax**

Run: `python3 -c "import sys; open('/home/da/projects/wayper/wayper/electron/styles.css').read()"` — should exit 0 (just confirms the file is readable; CSS has no real linter in this repo).

---

## Task 2: DOM Wrapper + Zoom State + Helpers

**Files:**
- Modify: `wayper/electron/renderer.js:2369-2454` (entire lightbox section)

**Why:** Adds the stage wrapper to the DOM template, declares zoom state, and adds the four pure helpers (`clamp`, `applyZoom`, `resetZoom`, `clampPan`) that all later tasks call. Wires `resetZoom()` into the swap branch so navigation already resets even before zoom is interactive.

- [ ] **Step 2.1: Add zoom state declarations after the existing lightbox state**

Edit `wayper/electron/renderer.js`. Find:

```js
let lightboxEl = null;
let lightboxImg = null;
```

Add immediately after:

```js
let zoom = { scale: 1, x: 0, y: 0 };
let dragState = null;
let _windowMoveHandler = null;
let _windowUpHandler = null;

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
    const img = lightboxEl?.querySelector('.lightbox-image');
    if (!img) return;
    img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function clampPan() {
    const stage = lightboxEl?.querySelector('.lightbox-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const overflowX = Math.max(0, (rect.width * zoom.scale - rect.width) / 2);
    const overflowY = Math.max(0, (rect.height * zoom.scale - rect.height) / 2);
    zoom.x = clamp(zoom.x, -overflowX, overflowX);
    zoom.y = clamp(zoom.y, -overflowY, overflowY);
}

function resetZoom() {
    zoom = { scale: 1, x: 0, y: 0 };
    applyZoom();
}
```

- [ ] **Step 2.2: Wrap the `<img>` in `<div class="lightbox-stage">` in the lightbox template**

Edit `wayper/electron/renderer.js`. Find this line inside `showLightbox` (around line 2388):

```js
        <img class="lightbox-image" src="${imageUrl(img.path)}" alt="">
```

Replace with:

```js
        <div class="lightbox-stage">
            <img class="lightbox-image" src="${imageUrl(img.path)}" alt="">
        </div>
```

- [ ] **Step 2.3: Reset zoom in the swap branch of `showLightbox`**

Edit `wayper/electron/renderer.js`. Find:

```js
    // If lightbox already exists, just swap the image (avoids DOM thrashing)
    if (lightboxEl) {
        lightboxEl.querySelector('.lightbox-image').src = imageUrl(img.path);
        return;
    }
```

Replace with:

```js
    // If lightbox already exists, just swap the image (avoids DOM thrashing)
    if (lightboxEl) {
        lightboxEl.querySelector('.lightbox-image').src = imageUrl(img.path);
        resetZoom();
        return;
    }
```

- [ ] **Step 2.4: Reset zoom on first creation**

Edit `wayper/electron/renderer.js`. Find:

```js
    document.body.appendChild(lightboxEl);
    requestAnimationFrame(() => lightboxEl.classList.add('visible'));
```

Replace with:

```js
    document.body.appendChild(lightboxEl);
    resetZoom();
    requestAnimationFrame(() => lightboxEl.classList.add('visible'));
```

- [ ] **Step 2.5: Manual smoke test**

Reload the Wayper window (`Ctrl+R` while focused) and click an image card. Expected:
- Lightbox opens with entry animation (image scales up + fades in) — same as before
- DevTools console (`Ctrl+Shift+I`) has no errors
- Inspect the DOM: confirm `.lightbox-stage > img.lightbox-image` structure
- The `<img>` element has inline `style="transform: translate(0px, 0px) scale(1);"`
- Press `→` / `←`: navigation between images works as before, image still resets to fit

If the lightbox doesn't appear or looks wrong, the most likely cause is a CSS selector that didn't get migrated to `.lightbox-stage`. Re-check Task 1 step 1.3.

---

## Task 3: Wheel Zoom (Cursor-Anchored)

**Files:**
- Modify: `wayper/electron/renderer.js` (add handler + wire it inside `showLightbox`)

- [ ] **Step 3.1: Add `handleWheel` function**

Add this function in `wayper/electron/renderer.js` immediately after the `resetZoom` function from Task 2:

```js
function handleWheel(e) {
    if (!lightboxEl) return;
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

- [ ] **Step 3.2: Wire the wheel handler in `showLightbox`**

Edit `wayper/electron/renderer.js`. Find the existing button wiring inside `showLightbox` (around line 2419):

```js
    // All button actions read from lightboxImg (not closure) to stay current after navigation
    lightboxEl.querySelector('.lightbox-backdrop').onclick = closeLightbox;
    lightboxEl.querySelector('.lightbox-close').onclick = closeLightbox;
```

Insert immediately above it:

```js
    // Wheel zoom on the stage (anchored at cursor)
    lightboxEl.querySelector('.lightbox-stage').addEventListener('wheel', handleWheel, { passive: false });

```

- [ ] **Step 3.3: Manual test wheel zoom**

Reload, open lightbox, scroll wheel up over the image. Expected:
- Image zooms in; the pixel under the cursor stays under the cursor
- Continued scrolling clamps at 8× (image stops growing)
- Scroll wheel down: zooms out; clamps at 0.5× (image continues to shrink and centers)
- Trackpad pinch (sends `wheel` events with `ctrlKey`) also zooms — same handler, expected behavior
- Page underneath the lightbox does NOT scroll (the `passive: false` + `preventDefault()` blocks it)

If the cursor "drifts" relative to the image, the math in Step 3.1 is off. Verify the formula matches `zoom.x = (e.clientX - cX) * (1 - r) + r * zoom.x`. The `cX` MUST come from the stage bounding rect, not the image rect (the image's rect changes with its transform; the stage's does not).

---

## Task 4: Drag-to-Pan

**Files:**
- Modify: `wayper/electron/renderer.js` (add 3 handlers, wire mousedown on image, wire window listeners in `showLightbox`, remove window listeners in `closeLightbox`)

- [ ] **Step 4.1: Add the three drag handlers**

Add these functions in `wayper/electron/renderer.js` immediately after `handleWheel` from Task 3:

```js
function handleMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState = {
        startX: e.clientX,
        startY: e.clientY,
        startTx: zoom.x,
        startTy: zoom.y,
        moved: false,
    };
    lightboxEl.querySelector('.lightbox-image').classList.add('dragging');
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
    if (!dragState) return;
    lightboxEl?.querySelector('.lightbox-image')?.classList.remove('dragging');
    dragState = null;
}
```

- [ ] **Step 4.2: Wire mousedown on the image and window listeners in `showLightbox`**

Edit `wayper/electron/renderer.js`. Find the wheel wiring added in Task 3:

```js
    // Wheel zoom on the stage (anchored at cursor)
    lightboxEl.querySelector('.lightbox-stage').addEventListener('wheel', handleWheel, { passive: false });
```

Add immediately after:

```js
    // Drag to pan: mousedown on image, mousemove/up on window so dragging continues outside the image
    lightboxEl.querySelector('.lightbox-image').addEventListener('mousedown', handleMouseDown);
    _windowMoveHandler = handleMouseMove;
    _windowUpHandler = handleMouseUp;
    window.addEventListener('mousemove', _windowMoveHandler);
    window.addEventListener('mouseup', _windowUpHandler);

```

- [ ] **Step 4.3: Remove window listeners in `closeLightbox`**

Edit `wayper/electron/renderer.js`. Find `closeLightbox`:

```js
function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('visible');
    setTimeout(() => {
        if (lightboxEl) { lightboxEl.remove(); lightboxEl = null; lightboxImg = null; }
    }, 200);
}
```

Replace with:

```js
function closeLightbox() {
    if (!lightboxEl) return;
    if (_windowMoveHandler) { window.removeEventListener('mousemove', _windowMoveHandler); _windowMoveHandler = null; }
    if (_windowUpHandler) { window.removeEventListener('mouseup', _windowUpHandler); _windowUpHandler = null; }
    dragState = null;
    lightboxEl.classList.remove('visible');
    setTimeout(() => {
        if (lightboxEl) { lightboxEl.remove(); lightboxEl = null; lightboxImg = null; }
    }, 200);
}
```

- [ ] **Step 4.4: Manual test drag-pan**

Reload, open lightbox, scroll to zoom in (~3×). Expected:
- Cursor over image shows `cursor: grab`
- Mousedown + drag → image pans with the cursor; cursor changes to `grabbing`
- Release: image stays at the panned position; cursor back to `grab`
- Drag past image edge: stops at clamp boundary (image edge does not pass the stage center)
- At fit (1×): drag does nothing visible (overflow is 0, so `clampPan` zeroes the translate immediately)
- Click backdrop (anywhere outside image): lightbox closes
- Click image without dragging: lightbox does NOT close (because mousedown was on image, not backdrop, and our handler does not call close)
- Open and close lightbox 5× in a row: no console errors, no leaked event listeners (DevTools → Performance → Event Listeners count if you want to be thorough)

If clicks on the image close the lightbox, check that `handleMouseDown` calls `e.preventDefault()` AND that the click handlers were not added to the image itself. The backdrop click handler is on `.lightbox-backdrop`, not on the image — they are siblings under `.lightbox`.

---

## Task 5: Keyboard Zoom (`0`, `+`, `=`, `-`)

**Files:**
- Modify: `wayper/electron/renderer.js:268-301` (the lightbox switch inside `handleGlobalKeydown`)

- [ ] **Step 5.1: Add new cases to the lightbox keydown switch**

Edit `wayper/electron/renderer.js`. Find this block (around line 268):

```js
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
                if (lightboxImg) { banImage(lightboxImg.path); closeLightbox(); }
                return;
            case 'o':
                if (lightboxImg) openWallhavenUrl(lightboxImg.name);
                return;
        }
        return;
    }
```

Add these cases inside the switch (insert above the closing `}` at the end of the switch body):

```js
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
```

- [ ] **Step 5.2: Add the `zoomAtCenter` helper**

Add this function in `wayper/electron/renderer.js` immediately after `handleMouseUp` (added in Task 4):

```js
function zoomAtCenter(factor) {
    if (!lightboxEl) return;
    const oldScale = zoom.scale;
    const newScale = clamp(oldScale * factor, ZOOM_MIN, ZOOM_MAX);
    if (newScale === oldScale) return;
    const r = newScale / oldScale;
    // Anchor at stage center → cursor offset is zero, so translate just scales by r
    zoom.x = r * zoom.x;
    zoom.y = r * zoom.y;
    zoom.scale = newScale;
    clampPan();
    applyZoom();
}
```

- [ ] **Step 5.3: Manual test keyboard zoom**

Reload, open lightbox. Expected:
- Press `+` (Shift+`=`) or `=` (unshifted): image grows ~15%, centered on the image's current center
- Press `-`: image shrinks ~15%
- Press `0`: image returns to fit-to-screen, pan resets to (0, 0)
- Repeated `+` clamps at 8×; repeated `-` clamps at 0.5×
- After zooming with `+`, panning with drag still works
- The `0` keydown does NOT trigger the page's number-key shortcut (the lightbox switch returns early before falling through to the global switch)

---

## Task 6: Pan-Then-Navigate Arrow Keys

**Files:**
- Modify: `wayper/electron/renderer.js` (replace the two `ArrowLeft`/`ArrowRight` cases inside the lightbox switch, add `arrowPanOrNavigate` helper)

- [ ] **Step 6.1: Add `arrowPanOrNavigate` helper**

Add this function in `wayper/electron/renderer.js` immediately after `zoomAtCenter` (added in Task 5):

```js
function arrowPanOrNavigate(direction) {
    // direction: -1 = ArrowLeft, +1 = ArrowRight
    if (!lightboxEl) return;
    if (zoom.scale <= 1) {
        navigateLightbox(direction);
        return;
    }
    const stage = lightboxEl.querySelector('.lightbox-stage');
    const rect = stage.getBoundingClientRect();
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
```

- [ ] **Step 6.2: Replace the `ArrowLeft` / `ArrowRight` cases in the lightbox switch**

Edit `wayper/electron/renderer.js`. Find inside the lightbox switch (around line 273):

```js
            case 'ArrowLeft':
                e.preventDefault();
                navigateLightbox(-1);
                return;
            case 'ArrowRight':
                e.preventDefault();
                navigateLightbox(1);
                return;
```

Replace with:

```js
            case 'ArrowLeft':
                e.preventDefault();
                arrowPanOrNavigate(-1);
                return;
            case 'ArrowRight':
                e.preventDefault();
                arrowPanOrNavigate(1);
                return;
```

- [ ] **Step 6.3: Manual test pan-then-navigate**

Reload, open lightbox on an image with a previous and next image in the pool. Expected:
- At fit (scale = 1): `←` / `→` immediately navigate prev/next, same as before
- Zoom to 3× (image is now wider than the stage). Initial `zoom.x = 0` (centered).
- Press `→` repeatedly: image pans toward its left (revealing the right side); `zoom.x` decreases by 50 px each press, clamped at `-overflowX`. Once `zoom.x` reaches `-overflowX`, the next `→` press navigates to the next image.
- Press `←` repeatedly: image pans toward its right (revealing the left side); once `zoom.x` reaches `+overflowX`, the next `←` press navigates to the previous image.
- After navigation, the new image opens at fit (zoom reset, see Task 2 step 2.3)

If `→` navigates immediately even when not at the edge, check the sign convention. With `transform: translate(zoom.x, zoom.y)`, positive `zoom.x` shifts the image visually to the right (revealing its LEFT side). So `←` increases `zoom.x` (eventually showing the image's left edge) and triggers prev-navigation when `zoom.x === +overflowX`. The opposite for `→`.

---

## Task 7: Double-Click Toggle (fit ↔ 100%)

**Files:**
- Modify: `wayper/electron/renderer.js` (add handler + wire `dblclick` inside `showLightbox`)

- [ ] **Step 7.1: Add `handleDoubleClick`**

Add this function in `wayper/electron/renderer.js` immediately after `arrowPanOrNavigate` (added in Task 6):

```js
function handleDoubleClick(e) {
    if (!lightboxEl) return;
    e.preventDefault();
    const img = lightboxEl.querySelector('.lightbox-image');
    const stage = lightboxEl.querySelector('.lightbox-stage');

    if (zoom.scale > 1.01) {
        // Already zoomed in → reset to fit
        resetZoom();
        return;
    }

    // Zoom to 100% original pixels, anchored at click position
    const stageRect = stage.getBoundingClientRect();
    const naturalRatio = img.naturalWidth / stageRect.width;
    if (!isFinite(naturalRatio) || naturalRatio <= 0) return;

    const oldScale = zoom.scale;
    const newScale = clamp(naturalRatio, ZOOM_MIN, ZOOM_MAX);
    if (newScale <= oldScale + 0.01) return; // already at or above 100% (small image)

    const cX = stageRect.left + stageRect.width / 2;
    const cY = stageRect.top + stageRect.height / 2;
    const r = newScale / oldScale;
    zoom.x = (e.clientX - cX) * (1 - r) + r * zoom.x;
    zoom.y = (e.clientY - cY) * (1 - r) + r * zoom.y;
    zoom.scale = newScale;
    clampPan();
    applyZoom();
}
```

- [ ] **Step 7.2: Wire `dblclick` on the image in `showLightbox`**

Edit `wayper/electron/renderer.js`. Find the drag wiring added in Task 4:

```js
    // Drag to pan: mousedown on image, mousemove/up on window so dragging continues outside the image
    lightboxEl.querySelector('.lightbox-image').addEventListener('mousedown', handleMouseDown);
    _windowMoveHandler = handleMouseMove;
    _windowUpHandler = handleMouseUp;
    window.addEventListener('mousemove', _windowMoveHandler);
    window.addEventListener('mouseup', _windowUpHandler);
```

Add immediately after:

```js
    lightboxEl.querySelector('.lightbox-image').addEventListener('dblclick', handleDoubleClick);

```

- [ ] **Step 7.3: Manual test double-click**

Reload, open lightbox on a high-resolution image (e.g. 4K wallhaven download). Expected:
- Double-click on a region (e.g. a face): image jumps to 100% original pixels, that region appears under the cursor
- Double-click again anywhere on the image: returns to fit (zoom reset)
- Double-click on a small image where 100% is below fit: nothing visibly changes (the `newScale <= oldScale + 0.01` guard short-circuits)
- A single click (no second click) does NOT zoom and does NOT close (image clicks don't close, and dblclick requires two clicks within the OS double-click interval)
- Drag still works: mousedown → drag → mouseup does not register as a double-click (the OS distinguishes click from drag by movement)

---

## Task 8: Final Verification + Single Commit

- [ ] **Step 8.1: Full manual test pass**

Reload Wayper one more time and run through the spec's manual test plan (section "Testing" of the spec doc), all 14 items. Note any failures in `/tmp/wayper-zoom-test-failures.txt` and fix before committing.

The test plan from the spec, restated:
1. Open lightbox on a normal pool image
2. Scroll wheel up → zooms at cursor
3. Scroll wheel down → zooms out, clamps at 0.5×
4. Click and drag while zoomed → pans, clamps at edges
5. Press `0` → resets to fit
6. Press `+` / `-` → zoom at center, one step at a time
7. `←` while zoomed and not at left edge → pans toward left edge; one more press at edge → navigates prev
8. Same for `→`
9. Double-click on image at fit → 100% at click position
10. Double-click again → fit
11. Click backdrop while zoomed → closes
12. Click image (no drag) while zoomed → does nothing
13. Navigate to next image while zoomed → next opens at fit
14. `Esc` closes from any zoom state

- [ ] **Step 8.2: Lint check**

Run: `cd /home/da/projects/wayper && ruff check wayper/ && ruff format --check wayper/`

Expected: no errors. (Ruff doesn't lint JS/CSS; this just confirms we haven't broken any Python files in passing.)

- [ ] **Step 8.3: Commit**

```bash
cd /home/da/projects/wayper
git add wayper/electron/renderer.js wayper/electron/styles.css
git commit -m "$(cat <<'EOF'
feat: lightbox zoom, pan, and viewer keyboard controls

Add scroll-wheel zoom anchored at cursor (0.5x–8x), drag-to-pan,
double-click toggle between fit and 100%, and keyboard controls
(0 reset, +/- zoom at center, arrow keys pan-then-navigate when
zoomed in). Wrap the image in .lightbox-stage so the entry
animation and JS-controlled zoom transform don't fight.
EOF
)"
```

- [ ] **Step 8.4: Verify commit**

Run: `git log -1 --stat` — should show two files modified: `wayper/electron/renderer.js` and `wayper/electron/styles.css`. No tests, no other files.

---

## Done

After Task 8 the feature is shipped on `main`. No version bump or release tag — that follows the release checklist in `CLAUDE.md` separately if/when the user wants to cut a new version.
