# Sketchy Purity Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Wallhaven's "sketchy" purity tier as an independently toggleable flag, changing the mode system from a single string to a set of purities.

**Architecture:** The core change is `read_mode() -> set[str]` instead of `-> str`. This cascades through state, pool, daemon, history, CLI, API, and GUI. Each purity has independent pool directories and quotas. Images are downloaded per-purity via separate API calls.

**Tech Stack:** Python 3.12+, Click CLI, FastAPI, Electron (vanilla JS)

**Spec:** `docs/superpowers/specs/2026-03-29-sketchy-purity-support-design.md`

---

### Task 1: Core State Model (`state.py`)

**Files:**
- Modify: `wayper/state.py`

The foundation — all other tasks depend on this.

- [ ] **Step 1: Add ALL_PURITIES constant and update read_mode/write_mode**

In `wayper/state.py`, add the constant and change the return type of `read_mode` from `str` to `set[str]`, and `write_mode` from accepting `str` to accepting `set[str]`:

```python
ALL_PURITIES = ("sfw", "sketchy", "nsfw")


def _parse_mode(raw: str) -> set[str]:
    """Parse a mode string like 'sfw,sketchy' into a validated set."""
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    valid = parts & set(ALL_PURITIES)
    return valid or {"sfw"}


def read_mode(config: WayperConfig) -> set[str]:
    sf = config.state_file
    if sf.exists():
        raw = sf.read_text().strip()
        if raw:
            return _parse_mode(raw)
    return _parse_mode(config.default_mode)


def write_mode(config: WayperConfig, mode: set[str]) -> None:
    config.state_file.parent.mkdir(parents=True, exist_ok=True)
    # Canonical order: sfw, sketchy, nsfw
    ordered = [p for p in ALL_PURITIES if p in mode]
    config.state_file.write_text(",".join(ordered))
```

- [ ] **Step 2: Add toggle helpers and purity_from_path**

Add these functions below `write_mode` in `wayper/state.py`:

```python
def toggle_base(current: set[str]) -> set[str]:
    """Swap sfw<->nsfw, preserving sketchy membership."""
    result = current.copy()
    if "nsfw" in result:
        result.discard("nsfw")
        result.add("sfw")
    elif "sfw" in result:
        result.discard("sfw")
        result.add("nsfw")
    else:
        # Only sketchy active — add nsfw
        result.add("nsfw")
    return result


def toggle_purity(current: set[str], purity: str) -> set[str]:
    """Toggle a single purity; refuses to remove the last one."""
    result = current.copy()
    if purity in result:
        if len(result) <= 1:
            return current  # Can't remove the last one
        result.discard(purity)
    else:
        result.add(purity)
    return result


def purity_from_path(config: WayperConfig, img: Path) -> str:
    """Determine purity from an image's filesystem path."""
    try:
        rel = img.relative_to(config.download_dir)
        parts = rel.parts
        if parts[0] == "favorites":
            return parts[1] if len(parts) > 1 and parts[1] in ALL_PURITIES else "sfw"
        return parts[0] if parts[0] in ALL_PURITIES else "sfw"
    except (ValueError, IndexError):
        return "sfw"
```

- [ ] **Step 3: Update _trash_search_dirs to include sketchy**

In `wayper/state.py`, update `_trash_search_dirs` to add sketchy legacy path:

```python
def _trash_search_dirs(config: WayperConfig) -> list[Path]:
    """All directories to search for trashed files: system + legacy."""
    dirs = _system_trash_dirs()
    # Legacy .trash/ fallback
    dirs.extend([
        config.trash_dir / "sfw",
        config.trash_dir / "sketchy",
        config.trash_dir / "nsfw",
        config.trash_dir,
    ])
    return dirs
```

- [ ] **Step 4: Verify state.py changes**

Run: `python -c "from wayper.state import ALL_PURITIES, read_mode, toggle_base, toggle_purity, purity_from_path; print('OK')"`

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add wayper/state.py
git commit -m "feat: change mode from string to purity set in state.py"
```

---

### Task 2: Pool Management (`pool.py`)

**Files:**
- Modify: `wayper/pool.py`

- [ ] **Step 1: Update hardcoded purity tuples**

In `wayper/pool.py`, import `ALL_PURITIES` and update three functions that iterate over `("sfw", "nsfw")`:

Add import at top (after existing imports):
```python
from .state import ALL_PURITIES
```

Update `disk_usage_mb` (line 57):
```python
for purity in ALL_PURITIES:
```

Update `enforce_quota` (line 148):
```python
for purity in ALL_PURITIES:
```

And change the quota division (line 152):
```python
quota_bytes = config.quota_mb * 1024 * 1024 // len(ALL_PURITIES)
```

Update `ensure_directories` (line 215):
```python
for purity in ALL_PURITIES:
```

- [ ] **Step 2: Update pick_random to accept purity set with equal distribution**

Replace the `pick_random` function (line 79-83):

```python
def pick_random(config: WayperConfig, purities: set[str], orientation: str) -> Path | None:
    """Pick a random image: choose a random purity first (equal weight), then a random image."""
    import random as _rand

    active = [p for p in ALL_PURITIES if p in purities]
    if not active:
        return None
    _rand.shuffle(active)
    for purity in active:
        images = list_images(pool_dir(config, purity, orientation))
        images += list_images(favorites_dir(config, purity, orientation))
        if images:
            return _rand.choice(images)
    return None
```

Note: We shuffle and try each purity rather than strictly picking one, so we don't return None when one purity's pool is empty but others have images.

- [ ] **Step 3: Update should_download to accept purity set**

Replace `should_download` (line 168-173):

```python
def should_download(config: WayperConfig, purities: set[str]) -> dict[str, bool]:
    """Return dict of {purity: needs_download} for each active purity."""
    result = {}
    for purity in purities:
        needs = False
        for orient in ("portrait", "landscape"):
            if count_images(pool_dir(config, purity, orient)) < config.pool_target:
                needs = True
                break
        if not needs:
            needs = random.random() < 0.2
        result[purity] = needs
    return result
```

- [ ] **Step 4: Verify pool.py changes**

Run: `python -c "from wayper.pool import pick_random, should_download, ensure_directories; print('OK')"`

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add wayper/pool.py
git commit -m "feat: update pool.py for purity set support"
```

---

### Task 3: Daemon (`daemon.py`)

**Files:**
- Modify: `wayper/daemon.py`

- [ ] **Step 1: Update set_all_wallpapers signature**

Change `set_all_wallpapers` (line 95-103) to accept `set[str]`:

```python
def set_all_wallpapers(config: WayperConfig, purities: set[str]) -> None:
    """Set wallpaper on all configured monitors."""
    history_items: list[tuple[str, Path]] = []
    for mon in config.monitors:
        img = pick_random(config, purities, mon.orientation)
        if img:
            set_wallpaper(mon.name, img, config.transition)
            history_items.append((mon.name, img))
    push_many(config, history_items)
```

- [ ] **Step 2: Update compute_daemon_state**

Change `compute_daemon_state` (line 67-74) — `mode` is now a set, sum counts across active purities:

```python
def compute_daemon_state(config: WayperConfig) -> tuple[bool, set[str], int, int, int]:
    """Compute daemon state tuple: (running, purities, pool_count, fav_count, disk_mb_rounded)."""
    running, _ = is_daemon_running(config)
    purities = read_mode(config)
    pool_count = 0
    fav_count = 0
    for purity in purities:
        for o in ("landscape", "portrait"):
            pool_count += count_images(pool_dir(config, purity, o))
            fav_count += count_images(favorites_dir(config, purity, o))
    disk_mb = disk_usage_mb(config)
    return running, purities, pool_count, fav_count, round(disk_mb)
```

- [ ] **Step 3: Update run_daemon download loop**

In `run_daemon` (line 138-215), the download section (lines 178-180) currently does:
```python
if should_download(config, mode):
    orientations = {m.orientation for m in config.monitors}
    await asyncio.gather(*(client.download_for(o, mode) for o in orientations))
```

Replace with:
```python
download_map = should_download(config, purities)
tasks = []
orientations = {m.orientation for m in config.monitors}
for purity, needs in download_map.items():
    if needs:
        for o in orientations:
            tasks.append(client.download_for(o, purity))
if tasks:
    await asyncio.gather(*tasks)
```

Also rename the variable on line 171 from `mode` to `purities`:
```python
purities = read_mode(config)
```

And update line 174:
```python
set_all_wallpapers(config, purities)
```

- [ ] **Step 4: Verify daemon.py changes**

Run: `python -c "from wayper.daemon import set_all_wallpapers, compute_daemon_state, run_daemon; print('OK')"`

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add wayper/daemon.py
git commit -m "feat: update daemon for purity set support"
```

---

### Task 4: History (`history.py`)

**Files:**
- Modify: `wayper/history.py`

- [ ] **Step 1: Update pick_next to pass purity set**

In `history.py`, `pick_next` (line 86-99) calls `read_mode()` and passes it to `pick_random()`. Since `read_mode()` now returns a set, and `pick_random()` now accepts a set, only the type flow changes — but we should rename the variable for clarity:

```python
def pick_next(config: WayperConfig, monitor: str, orientation: str) -> Path | None:
    """Try forward history, then pick random. Pushes to history if new."""
    from .pool import pick_random
    from .state import read_mode

    img = go_next(config, monitor)
    if img:
        return img

    purities = read_mode(config)
    img = pick_random(config, purities, orientation)
    if img:
        push(config, monitor, img)
    return img
```

- [ ] **Step 2: Commit**

```bash
git add wayper/history.py
git commit -m "feat: update history.py for purity set"
```

---

### Task 5: CLI (`cli.py`)

**Files:**
- Modify: `wayper/cli.py`

- [ ] **Step 1: Update mode command**

Replace the `mode` command (lines 327-348):

```python
@cli.command()
@click.argument("new_mode", required=False)
@click.pass_context
def mode(ctx, new_mode):
    """Show or switch purity mode.

    No argument toggles sfw/nsfw. 'sketchy' toggles sketchy on/off.
    Comma-separated values set exact combination (e.g. sfw,sketchy).
    """
    config = ctx.obj["config"]
    current = read_mode(config)

    if new_mode is None:
        result = toggle_base(current)
    elif new_mode == "sketchy":
        result = toggle_purity(current, "sketchy")
    elif "," in new_mode:
        result = {p.strip() for p in new_mode.split(",") if p.strip() in ALL_PURITIES}
        if not result:
            click.echo("Invalid mode. Use: sfw, sketchy, nsfw", err=True)
            raise SystemExit(1)
    elif new_mode in ("sfw", "nsfw"):
        result = current.copy()
        result.discard("sfw")
        result.discard("nsfw")
        result.add(new_mode)
        if not result:
            result.add(new_mode)
    else:
        click.echo(f"Unknown mode: {new_mode}. Use: sfw, sketchy, nsfw", err=True)
        raise SystemExit(1)

    write_mode(config, result)

    from .daemon import signal_daemon

    signal_daemon(config, signal.SIGUSR2)

    label = ", ".join(p for p in ALL_PURITIES if p in result)
    if ctx.obj["json"]:
        click.echo(json_mod.dumps({"action": "mode", "mode": sorted(result)}))
    else:
        notify("Wallpaper", f"Mode: {label}")
```

Add imports at top of file — add `toggle_base`, `toggle_purity`, `ALL_PURITIES`, and `purity_from_path` to the existing import from `.state`:

```python
from .state import (
    ALL_PURITIES,
    pop_undo,
    purity_from_path,
    push_undo,
    read_mode,
    restore_from_trash,
    toggle_base,
    toggle_purity,
    write_mode,
)
```

- [ ] **Step 2: Update fav command to use purity_from_path**

In the `fav` command (lines 190-227), replace the mode lookup (lines 206-208):

```python
        purity = purity_from_path(config, img)
        dest_dir = favorites_dir(config, purity, mon_cfg.orientation)
```

Remove the `mode = read_mode(config)` line that was there.

- [ ] **Step 3: Update unfav command to use purity_from_path**

In the `unfav` command (lines 229-256), replace the mode lookup (lines 247-248):

```python
        purity = purity_from_path(config, img)
        dest_dir = pool_dir(config, purity, mon_cfg.orientation)
```

- [ ] **Step 4: Update dislike command**

In the `dislike` command (lines 259-291), update mode to purities (line 278):

```python
        purities = read_mode(config)
        next_img = pick_random(config, purities, mon_cfg.orientation)
```

- [ ] **Step 5: Update next_cmd download logic**

In `next_cmd` (lines 127-160), update the download section (lines 146-160):

```python
    purities = read_mode(config)
    download_map = should_download(config, purities)
    to_download = [p for p, needs in download_map.items() if needs]
    if to_download:
        from .wallhaven import WallhavenClient

        async def _download():
            client = WallhavenClient(config)
            try:
                tasks = []
                for purity in to_download:
                    tasks.append(client.download_for("landscape", purity))
                    tasks.append(client.download_for("portrait", purity))
                await asyncio.gather(*tasks)
            finally:
                await client.close()

        asyncio.run(_download())
```

- [ ] **Step 6: Update status command**

In the `status` command (lines 351-399), update mode display. Change `current_mode = read_mode(config)` and all usages:

```python
    current_purities = read_mode(config)
```

Update pool/fav counts to iterate over active purities (lines 362-363):
```python
        pc = sum(count_images(pool_dir(config, p, mon.orientation)) for p in current_purities)
        fc = sum(count_images(favorites_dir(config, p, mon.orientation)) for p in current_purities)
```

Update the display (line 384):
```python
                    "mode": sorted(current_purities),
```

And text output (line 394):
```python
        mode_label = ", ".join(p for p in ALL_PURITIES if p in current_purities)
        click.echo(f"Mode: {mode_label}")
```

- [ ] **Step 7: Verify CLI changes**

Run: `python -m wayper.cli --help`

Expected: Shows help without errors.

Run: `python -m wayper.cli mode --help`

Expected: Shows mode help.

- [ ] **Step 8: Commit**

```bash
git add wayper/cli.py
git commit -m "feat: update CLI for purity set support"
```

---

### Task 6: API Server (`server/api.py`)

**Files:**
- Modify: `wayper/server/api.py`

- [ ] **Step 1: Update imports**

Add `ALL_PURITIES`, `purity_from_path`, and `toggle_purity` to the state import (line 33):

```python
from wayper.state import (
    ALL_PURITIES,
    find_in_trash,
    purity_from_path,
    push_undo,
    read_mode,
    restore_from_trash,
    write_mode,
)
```

- [ ] **Step 2: Update Pydantic models**

Update `StatusResponse` (line 75):
```python
    mode: list[str] = ["sfw"]
```

Update `ConfigResponse` (line 111):
```python
    mode: list[str]
```

Update `SetModeRequest` (lines 117-118) to support both old and new format:
```python
class SetModeRequest(BaseModel):
    mode: str | None = None
    purities: list[str] | None = None
```

- [ ] **Step 3: Update GET /api/config**

Update `get_config_route` (line 137):
```python
        "mode": sorted(read_mode(config)),
```

- [ ] **Step 4: Update POST /api/mode**

Replace `set_mode_route` (lines 184-191):

```python
@app.post("/api/mode")
def set_mode_route(req: SetModeRequest):
    config = get_config()

    if req.purities is not None:
        purities = set(req.purities) & set(ALL_PURITIES)
    elif req.mode is not None:
        # Backwards compatibility: single mode string
        purities = {p.strip() for p in req.mode.split(",") if p.strip() in ALL_PURITIES}
    else:
        raise HTTPException(400, "Provide 'purities' or 'mode'")

    if not purities:
        raise HTTPException(400, "At least one valid purity required")

    write_mode(config, purities)
    signal_daemon(config, signal.SIGUSR2)
    return {"status": "ok", "purities": sorted(purities)}
```

- [ ] **Step 5: Update SSE events**

In `sse_events` (lines 194-226), update the mode comparison and event payload. `last_mode` becomes a `set`:

```python
@app.get("/api/events")
async def sse_events():
    """SSE stream for real-time state changes (mode, etc.)."""
    from starlette.responses import StreamingResponse

    async def event_stream():
        config = get_config()
        last_mtime = 0.0
        last_mode: set[str] = set()
        try:
            last_mtime = config.state_file.stat().st_mtime
            last_mode = read_mode(config)
        except OSError:
            pass

        while True:
            await asyncio.sleep(0.3)
            try:
                mtime = config.state_file.stat().st_mtime
                if mtime != last_mtime:
                    last_mtime = mtime
                    current = read_mode(config)
                    if current != last_mode:
                        last_mode = current
                        yield f"data: {json_mod.dumps({'type': 'mode', 'purities': sorted(current)})}\n\n"
            except OSError:
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

- [ ] **Step 6: Update control_action for fav/unfav/dislike**

In `control_action` (line 255), `mode = read_mode(config)` is used for fav/unfav dest dirs and dislike pick_random.

Update fav/unfav section (lines 270-287) — use `purity_from_path` instead of mode:
```python
    if action in ("fav", "unfav"):
        if not current_img:
            raise HTTPException(400, "No current wallpaper")
        is_fav = current_img.is_relative_to(config.download_dir / "favorites")
        if action == "fav" and is_fav:
            return {"status": "already_favorite"}
        if action == "unfav" and not is_fav:
            return {"status": "not_favorite"}
        with FileLock(blocking=False):
            purity = purity_from_path(config, current_img)
            if action == "fav":
                dest_dir = favorites_dir(config, purity, mon_cfg.orientation)
            else:
                dest_dir = pool_dir(config, purity, mon_cfg.orientation)
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / current_img.name
            current_img.rename(dest)
            set_wallpaper(monitor, dest, NO_TRANSITION)
        return {"status": "ok", "image": str(dest)}
```

Update dislike section (line 308) — `mode` is now a set:
```python
        purities = read_mode(config)
        next_img = pick_random(config, purities, mon_cfg.orientation)
```

Remove the `mode = read_mode(config)` at line 255 since each branch handles it independently now.

- [ ] **Step 7: Update GET /api/status**

Update `get_status` (lines 317-342):

```python
@app.get("/api/status", response_model=StatusResponse)
def get_status():
    config = get_config()
    running, pid = is_daemon_running(config)
    purities = read_mode(config)

    pool_c = 0
    fav_c = 0
    for purity in purities:
        for orient in ["landscape", "portrait"]:
            pool_c += count_images(pool_dir(config, purity, orient))
            fav_c += count_images(favorites_dir(config, purity, orient))

    entries = list_blacklist(config)
    blocklist_c = len(entries)
    recoverable_c = sum(1 for _, fn in entries if find_in_trash(config, fn))

    return StatusResponse(
        running=running,
        pid=pid,
        pool_count=pool_c,
        favorites_count=fav_c,
        blocklist_count=blocklist_c,
        recoverable_count=recoverable_c,
        mode=sorted(purities),
    )
```

- [ ] **Step 8: Update restore_image endpoint**

In `restore_image` (lines 399-424), use metadata to determine purity instead of current mode:

```python
@app.post("/api/image/restore")
def restore_image(req: ActionRequest):
    config = get_config()
    filename = Path(req.image_path).name

    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")

    remove_from_blacklist(config, filename)

    # Determine orientation from image dimensions
    try:
        with Image.open(trashed) as img:
            width, height = img.size
            orientation = "landscape" if width >= height else "portrait"
    except Exception:
        orientation = "landscape"

    # Determine purity from metadata, fall back to first active purity
    from wayper.pool import load_metadata

    meta = load_metadata(config)
    img_meta = meta.get(filename, {})
    purity = img_meta.get("purity", "sfw")
    if purity not in ALL_PURITIES:
        purity = "sfw"

    dest_dir = pool_dir(config, purity, orientation)
    dest = restore_from_trash(config, filename, dest_dir)
    if not dest:
        raise HTTPException(500, "Failed to restore image")

    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}
```

- [ ] **Step 9: Update dislike_image_route**

In `dislike_image_route` (lines 484-509), update mode to purities (line 498):

```python
        purities = read_mode(config)
```

And line 502:
```python
                next_img = pick_random(config, purities, mon.orientation)
```

- [ ] **Step 10: Verify API changes**

Run: `python -c "from wayper.server.api import app; print('OK')"`

Expected: `OK`

- [ ] **Step 11: Commit**

```bash
git add wayper/server/api.py
git commit -m "feat: update API server for purity set support"
```

---

### Task 7: Electron GUI

**Files:**
- Modify: `wayper/electron/index.html`
- Modify: `wayper/electron/renderer.js`
- Modify: `wayper/electron/styles.css`

- [ ] **Step 1: Update HTML — replace binary toggle with three purity buttons**

In `wayper/electron/index.html`, replace the Mode sidebar section (lines 84-93):

```html
            <div class="sidebar-section">
                <h3>Purity</h3>
                <div class="purity-toggles">
                    <button id="btn-purity-sfw" class="purity-btn active" data-purity="sfw">SFW<kbd>F1</kbd></button>
                    <button id="btn-purity-sketchy" class="purity-btn" data-purity="sketchy">Sketchy<kbd>F2</kbd></button>
                    <button id="btn-purity-nsfw" class="purity-btn" data-purity="nsfw">NSFW<kbd>F3</kbd></button>
                </div>
            </div>
```

- [ ] **Step 2: Update renderer.js — state model**

In `wayper/electron/renderer.js`, change `appState.purity` from a string to an array (line 39):

```javascript
    purity: ['sfw'], // active purities: subset of ['sfw', 'sketchy', 'nsfw']
```

- [ ] **Step 3: Update renderer.js — DOM elements**

Replace the mode toggle elements (lines 98-100) with purity button refs:

```javascript
    btnPuritySfw: document.getElementById('btn-purity-sfw'),
    btnPuritySketchy: document.getElementById('btn-purity-sketchy'),
    btnPurityNsfw: document.getElementById('btn-purity-nsfw'),
```

- [ ] **Step 4: Update renderer.js — event listeners**

In `setupEventListeners` (lines 172-175), replace mode toggle/label listeners:

```javascript
    // Sidebar: Purity toggles
    els.btnPuritySfw.onclick = () => toggleSinglePurity('sfw');
    els.btnPuritySketchy.onclick = () => toggleSinglePurity('sketchy');
    els.btnPurityNsfw.onclick = () => toggleSinglePurity('nsfw');
```

- [ ] **Step 5: Update renderer.js — keyboard shortcuts**

In `handleGlobalKeydown` (lines 191-314), remove the `case 'm'` (lines 266-267):

```javascript
        // Remove: case 'm': togglePurity(); break;
```

Add F1/F2/F3 handling. Before the `switch(e.key)` block (around line 234), add:

```javascript
    // Purity toggles (F1/F2/F3)
    if (e.key === 'F1') { e.preventDefault(); toggleSinglePurity('sfw'); return; }
    if (e.key === 'F2') { e.preventDefault(); toggleSinglePurity('sketchy'); return; }
    if (e.key === 'F3') { e.preventDefault(); toggleSinglePurity('nsfw'); return; }
```

- [ ] **Step 6: Update renderer.js — purity toggle functions**

Replace `togglePurity` and `setPurity` functions (lines 479-499):

```javascript
function toggleSinglePurity(purity) {
    const current = appState.purity;
    if (current.includes(purity)) {
        if (current.length <= 1) return; // Can't remove the last one
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
}
```

- [ ] **Step 7: Update renderer.js — fetchConfig**

In `fetchConfig` (lines 659-671), update purity parsing — API now returns an array:

```javascript
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
```

- [ ] **Step 8: Update renderer.js — SSE handler**

In `connectSSE` (lines 673-691), update to handle new event format:

```javascript
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
                }
            }
        } catch (err) {
            console.error('SSE parse error', err);
        }
    };
    es.onerror = () => {};
}
```

- [ ] **Step 9: Update renderer.js — fetchStatus**

In `fetchStatus` (lines 693-719), update mode comparison:

```javascript
        // Check for external mode change
        const newMode = Array.isArray(data.mode) ? data.mode : [data.mode];
        if (JSON.stringify(newMode.sort()) !== JSON.stringify([...appState.purity].sort())) {
            console.log(`Mode changed externally: ${appState.purity} -> ${newMode}`);
            appState.purity = newMode;
            updateUI();
            refreshImages();
        }
```

- [ ] **Step 10: Update renderer.js — updateUI**

In `updateUI` (lines 776-800), replace the mode switch section (lines 790-799):

```javascript
    // Purity toggles
    els.btnPuritySfw.classList.toggle('active', appState.purity.includes('sfw'));
    els.btnPuritySketchy.classList.toggle('active', appState.purity.includes('sketchy'));
    els.btnPurityNsfw.classList.toggle('active', appState.purity.includes('nsfw'));
```

- [ ] **Step 11: Update renderer.js — refreshImages**

In `refreshImages` (lines 747-771), the `purity` query param needs to send the first active purity for the image listing API. Since `/api/images` takes a single purity param, we need to fetch for each active purity and merge:

```javascript
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
            // Fetch images for each active purity and merge
            const fetches = appState.purity.map(p =>
                fetch(`${API_URL}/api/images?mode=${appState.mode}&purity=${p}&orient=${orient}`)
                    .then(r => r.json())
            );
            const results = await Promise.all(fetches);
            appState.images = results.flat();
            // Sort by modification time (newest first) — server already sorts each batch
            renderImages();
        } catch (e) { console.error(e); }
    }
}
```

- [ ] **Step 12: Update styles.css — purity toggle styles**

In `wayper/electron/styles.css`, find the `.mode-switch` styles and replace with purity toggle styles. First, read the current styles to find the exact section, then replace:

```css
/* Purity Toggles */
.purity-toggles {
    display: flex;
    gap: 6px;
}

.purity-btn {
    flex: 1;
    padding: 6px 4px;
    border: 1px solid var(--surface1);
    border-radius: 8px;
    background: var(--surface0);
    color: var(--overlay1);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}

.purity-btn kbd {
    font-size: 9px;
    opacity: 0.5;
}

.purity-btn:hover {
    border-color: var(--overlay0);
    color: var(--text);
}

.purity-btn.active {
    background: var(--surface1);
    border-color: var(--blue);
    color: var(--text);
}
```

Remove the old `.mode-switch`, `.mode-switch-label`, `.switch-track`, `.switch-thumb` styles.

- [ ] **Step 13: Verify GUI loads without errors**

Run: `python -m wayper.server.api &` then open `http://127.0.0.1:8080` to verify the API starts. Kill after.

Run: `python -c "from wayper.server.api import app; print('OK')"`

- [ ] **Step 14: Commit**

```bash
git add wayper/electron/index.html wayper/electron/renderer.js wayper/electron/styles.css
git commit -m "feat: update GUI for three-way purity toggle"
```

---

### Task 8: Config and Documentation

**Files:**
- Modify: `example-config.toml`

- [ ] **Step 1: Update example-config.toml**

Update the `default_mode` line (line 4) and add a comment:

```toml
default_mode = "sfw"           # comma-separated: sfw, sketchy, nsfw (e.g. "sfw,sketchy")
```

- [ ] **Step 2: Commit**

```bash
git add example-config.toml
git commit -m "docs: update example config for purity set support"
```

---

### Task 9: Integration Verification

- [ ] **Step 1: Test CLI mode commands**

```bash
python -m wayper.cli mode
python -m wayper.cli status --json
python -m wayper.cli mode sketchy
python -m wayper.cli status --json
python -m wayper.cli mode sfw,sketchy
python -m wayper.cli status --json
```

Verify: mode values show as arrays in JSON, notifications display correctly.

- [ ] **Step 2: Test API server**

```bash
python -c "
from wayper.server.api import app
from fastapi.testclient import TestClient
client = TestClient(app)

# Test config returns array
r = client.get('/api/config')
print('config mode:', r.json()['mode'])

# Test set purities
r = client.post('/api/mode', json={'purities': ['sfw', 'sketchy']})
print('set purities:', r.json())

# Test backwards compat
r = client.post('/api/mode', json={'mode': 'nsfw'})
print('compat mode:', r.json())

# Test status
r = client.get('/api/status')
print('status mode:', r.json()['mode'])
"
```

- [ ] **Step 3: Test directory creation**

```bash
python -c "
from wayper.config import load_config
from wayper.pool import ensure_directories
config = load_config()
ensure_directories(config)
print('Directories created successfully')
" && ls -la "$(python -c 'from wayper.config import load_config; print(load_config().download_dir)')/sketchy/"
```

Expected: `sketchy/landscape` and `sketchy/portrait` directories exist.
