# Uploader Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add uploader exclusion filtering that mirrors the existing tag filtering system — local filtering during download, cloud sync to Wallhaven's user blacklist, uploader suggestions engine, API endpoints, and GUI management.

**Architecture:** `exclude_uploaders` list in config filters images locally after metadata fetch (Wallhaven API has no uploader query parameter). Cloud sync pushes/pulls via the `blacklist_users` textarea on `/settings/browsing` and the `user_blacklist` field from the API settings endpoint. Uploader suggestions use the same cost-benefit scoring as tag suggestions.

**Tech Stack:** Python 3.12+, httpx, FastAPI, Electron (vanilla JS)

---

### Task 1: Config — add `exclude_uploaders` field

**Files:**
- Modify: `wayper/config.py:24-32` (WallhavenConfig dataclass)
- Modify: `wayper/config.py:114-172` (save_config serialization)
- Modify: `wayper/config.py:190-200` (load_config deserialization)
- Modify: `example-config.toml:31-32` (add commented example)

- [ ] **Step 1: Add `exclude_uploaders` to `WallhavenConfig`**

In `wayper/config.py`, add the field after `exclude_combos`:

```python
@dataclass
class WallhavenConfig:
    categories: str = "111"
    top_range: str = "1M"
    sorting: str = "toplist"
    ai_art_filter: int = 0
    max_page: int = 15
    batch_size: int = 5
    exclude_tags: list[str] = field(default_factory=list)
    exclude_combos: list[list[str]] = field(default_factory=list)
    exclude_uploaders: list[str] = field(default_factory=list)
```

- [ ] **Step 2: Add serialization in `save_config`**

After the `exclude_combos` serialization block (line ~153), add:

```python
    if wh.exclude_uploaders:
        uploaders_str = ", ".join(f'"{_esc(u)}"' for u in wh.exclude_uploaders)
        lines.append(f"exclude_uploaders = [{uploaders_str}]")
```

- [ ] **Step 3: Add deserialization in `load_config`**

In the `WallhavenConfig(...)` constructor call inside `load_config` (line ~191-200), add:

```python
        exclude_uploaders=wallhaven_raw.get("exclude_uploaders", []),
```

- [ ] **Step 4: Add commented example to `example-config.toml`**

After the `exclude_combos` comment line, add:

```toml
# exclude_uploaders = ["username1", "username2"]  # synced to Wallhaven user blacklist if credentials are set
```

- [ ] **Step 5: Verify**

Run: `python3 -c "from wayper.config import load_config, save_config; c = load_config(); c.wallhaven.exclude_uploaders = ['test']; save_config(c); c2 = load_config(); print(c2.wallhaven.exclude_uploaders)"`

Expected: `['test']`

Then restore config: `python3 -c "from wayper.config import load_config, save_config; c = load_config(); c.wallhaven.exclude_uploaders = []; save_config(c)"`

---

### Task 2: Local filtering — skip excluded uploaders during download

**Files:**
- Modify: `wayper/wallhaven.py:253-259` (download_for filtering logic)

- [ ] **Step 1: Add uploader check in `download_for`**

In `wayper/wallhaven.py`, the `download_for` method checks tags at lines 257-259. Add an uploader check right before the tag checks. The full block becomes:

```python
        for (filename, url, item, dest), detail in zip(candidates, details):
            if detail:
                item = {**item, **detail}

            # Skip excluded uploaders (local-only — Wallhaven API has no uploader filter)
            uploader = item.get("uploader", "")
            if isinstance(uploader, dict):
                uploader = uploader.get("username", "")
            if uploader and uploader.lower() in {
                u.lower() for u in self.config.wallhaven.exclude_uploaders
            }:
                continue

            tag_names = extract_tag_names(item.get("tags", []))
            if self._matches_exclude_combo(tag_names) or self._matches_local_exclude(tag_names):
                continue
```

Note: Wallhaven API returns uploader as `{"username": "...", "group": "..."}` dict in full wallpaper info, but as a plain string in metadata storage. Handle both formats.

- [ ] **Step 2: Verify by inspecting the code flow**

Run: `python3 -c "from wayper.wallhaven import WallhavenClient; print('import ok')"`

Expected: `import ok`

---

### Task 3: Cloud sync — push/pull user blacklist to Wallhaven

**Files:**
- Modify: `wayper/wallhaven_web.py:204-240` (add `sync_user_blacklist` method after `sync_tag_blacklist`)
- Modify: `wayper/wallhaven_web.py:291-323` (add `fetch_cloud_users` and `merge_cloud_users_into_config`)
- Modify: `wayper/wallhaven_web.py:326-338` (add `sync_cloud_user_blacklist` fire-and-forget wrapper)

- [ ] **Step 1: Add `sync_user_blacklist` method to `WallhavenWeb` class**

After `sync_tag_blacklist` (line ~240), add:

```python
    def sync_user_blacklist(self, usernames: list[str]) -> bool:
        """Sync user blacklist to Wallhaven account settings.

        Reads current settings form, merges usernames into blacklist_users
        textarea, and POSTs back while preserving all other settings.
        """
        if not self._ensure_login():
            return False
        try:
            resp = self._client.get(f"{self.BASE}/settings/browsing")
            if resp.status_code != 200:
                log.warning("wallhaven web: settings page returned %d", resp.status_code)
                return False

            fields = self._parse_form_fields(resp.text)
            if "_token" not in fields:
                log.warning("wallhaven web: no CSRF token on settings page")
                return False

            existing = {u.strip() for u in fields.get("blacklist_users", "").split("\n") if u.strip()}
            merged = sorted(existing | set(usernames))
            fields["blacklist_users"] = "\n".join(merged)

            resp = self._client.post(
                f"{self.BASE}/settings/browsing",
                data=fields,
                headers={"Referer": f"{self.BASE}/settings/browsing"},
            )
            ok = resp.status_code in (200, 302)
            if ok:
                log.info("wallhaven web: synced %d users to cloud user blacklist", len(usernames))
            else:
                log.warning("wallhaven web: user blacklist sync POST returned %d", resp.status_code)
            return ok
        except Exception:
            log.warning("wallhaven web: user blacklist sync error", exc_info=True)
            return False
```

- [ ] **Step 2: Add `fetch_cloud_users` function**

After `fetch_cloud_tags` (line ~306), add:

```python
def fetch_cloud_users(config: WayperConfig) -> list[str]:
    """Fetch user_blacklist from Wallhaven API settings (needs API key, no login)."""
    if not config.api_key:
        return []
    try:
        with httpx.Client(proxy=config.proxy, timeout=httpx.Timeout(15, connect=10)) as client:
            resp = client.get(
                "https://wallhaven.cc/api/v1/settings",
                params={"apikey": config.api_key},
            )
            resp.raise_for_status()
            users = resp.json().get("data", {}).get("user_blacklist", [])
            return [u for u in users if u]
    except Exception:
        log.warning("wallhaven web: failed to fetch cloud user blacklist", exc_info=True)
        return []
```

- [ ] **Step 3: Add `merge_cloud_users_into_config` function**

After `merge_cloud_tags_into_config` (line ~323), add:

```python
def merge_cloud_users_into_config(config: WayperConfig) -> bool:
    """Merge cloud user_blacklist into local exclude_uploaders. Returns True if config was modified."""
    from .config import save_config

    cloud = fetch_cloud_users(config)
    if not cloud:
        return False
    local_lower = {u.lower() for u in config.wallhaven.exclude_uploaders}
    new_users = [u for u in cloud if u.lower() not in local_lower]
    if not new_users:
        return False
    config.wallhaven.exclude_uploaders.extend(new_users)
    save_config(config)
    log.info("Merged %d cloud users into local exclude_uploaders", len(new_users))
    return True
```

- [ ] **Step 4: Add `sync_cloud_user_blacklist` fire-and-forget wrapper**

After `sync_cloud_tag_blacklist` (line ~338), add:

```python
def sync_cloud_user_blacklist(config: WayperConfig, usernames: list[str]) -> None:
    """Sync exclude_uploaders to Wallhaven cloud user blacklist (fire-and-forget thread).

    No-op if wallhaven_username/password are not configured.
    """
    if not config.wallhaven_username or not config.wallhaven_password:
        return

    def _do():
        with _web_lock:
            _ensure_web_session(config).sync_user_blacklist(usernames)

    threading.Thread(target=_do, daemon=True).start()
```

- [ ] **Step 5: Verify import**

Run: `python3 -c "from wayper.wallhaven_web import fetch_cloud_users, merge_cloud_users_into_config, sync_cloud_user_blacklist; print('ok')"`

Expected: `ok`

---

### Task 4: Daemon — merge cloud user blacklist on startup/reload

**Files:**
- Modify: `wayper/daemon.py:183-186` (startup cloud merge)
- Modify: `wayper/daemon.py:199-200` (reload cloud merge)

- [ ] **Step 1: Add cloud user merge on daemon startup**

In `wayper/daemon.py`, after the existing cloud tag merge (line ~186), add:

```python
    from .wallhaven_web import merge_cloud_users_into_config

    await asyncio.to_thread(merge_cloud_users_into_config, config)
```

The startup section should now read:

```python
    client = WallhavenClient(config)
    await asyncio.to_thread(client.refresh_cloud_tags)
    from .wallhaven_web import merge_cloud_tags_into_config

    await asyncio.to_thread(merge_cloud_tags_into_config, config)
    from .wallhaven_web import merge_cloud_users_into_config

    await asyncio.to_thread(merge_cloud_users_into_config, config)
```

- [ ] **Step 2: Add cloud user merge on config reload**

In the `reload_config_if_needed` function, after the existing cloud tag merge (line ~200), add:

```python
        await asyncio.to_thread(merge_cloud_users_into_config, config)
```

Move the import to the top of the function or combine with existing import. The reload block should read:

```python
    async def reload_config_if_needed() -> None:
        global _reload_config
        nonlocal config, client, fav_sync_count
        if not _reload_config:
            return
        _reload_config = False
        config = load_config()
        old, client = client, WallhavenClient(config)
        await asyncio.to_thread(client.refresh_cloud_tags)
        await asyncio.to_thread(merge_cloud_tags_into_config, config)
        await asyncio.to_thread(merge_cloud_users_into_config, config)
        await old.close()
        fav_sync_count = FAV_SYNC_INTERVAL
        log.info("Configuration reloaded")
```

- [ ] **Step 3: Verify**

Run: `python3 -c "from wayper.daemon import run_daemon; print('import ok')"`

Expected: `import ok`

---

### Task 5: Uploader suggestions engine

**Files:**
- Modify: `wayper/suggestions.py` (add `UploaderSuggestion` type and `suggest_uploaders_to_exclude` function)

- [ ] **Step 1: Add `UploaderSuggestion` TypedDict**

After `ComboSuggestion` (line ~25), add:

```python
class UploaderSuggestion(TypedDict):
    uploader: str
    ban_count: int
    kept_count: int
    fav_count: int
    net_benefit: float
```

- [ ] **Step 2: Add `suggest_uploaders_to_exclude` function**

At the end of `wayper/suggestions.py`, add:

```python
def suggest_uploaders_to_exclude(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    excluded_uploaders: list[str],
    favorites: set[str] | None = None,
    *,
    max_results: int = 10,
) -> list[UploaderSuggestion]:
    """Suggest uploaders to exclude using cost-benefit scoring.

    Same logic as tag suggestions: net_benefit = ban - KEPT_WEIGHT * kept - FAV_WEIGHT * fav.
    Only uploaders with positive net benefit and >=3 bans are returned.
    """
    if not blacklisted:
        return []

    favorites = favorites or set()
    excluded_lower = {u.lower() for u in excluded_uploaders}

    uploader_ban: dict[str, int] = {}
    uploader_kept: dict[str, int] = {}
    uploader_fav: dict[str, int] = {}

    for filename, meta in metadata.items():
        uploader = meta.get("uploader", "")
        if not uploader or uploader.lower() in excluded_lower:
            continue
        if filename in blacklisted:
            uploader_ban[uploader] = uploader_ban.get(uploader, 0) + 1
        else:
            uploader_kept[uploader] = uploader_kept.get(uploader, 0) + 1
            if filename in favorites:
                uploader_fav[uploader] = uploader_fav.get(uploader, 0) + 1

    results: list[UploaderSuggestion] = []
    for uploader, ban_count in uploader_ban.items():
        if ban_count < 3:
            continue
        kept_count = uploader_kept.get(uploader, 0)
        fav_count = uploader_fav.get(uploader, 0)
        net_benefit = ban_count - KEPT_WEIGHT * kept_count - FAV_WEIGHT * fav_count
        if net_benefit <= 0:
            continue
        results.append({
            "uploader": uploader,
            "ban_count": ban_count,
            "kept_count": kept_count,
            "fav_count": fav_count,
            "net_benefit": round(net_benefit, 1),
        })

    results.sort(key=lambda r: (-r["ban_count"], -r["net_benefit"]))
    return results[:max_results]
```

- [ ] **Step 3: Verify**

Run: `python3 -c "from wayper.suggestions import suggest_uploaders_to_exclude, UploaderSuggestion; print('ok')"`

Expected: `ok`

---

### Task 6: API endpoints — config, suggestions, stats

**Files:**
- Modify: `wayper/server/api.py:179-202` (GET /api/config response)
- Modify: `wayper/server/api.py:232-261` (PATCH /api/config handler)
- Modify: `wayper/server/api.py:649-696` (tag-suggestions → add uploader-suggestions)

- [ ] **Step 1: Add `exclude_uploaders` to GET /api/config response**

In the `get_config_route` function (line ~194-201), add `exclude_uploaders` to the wallhaven dict:

```python
        "wallhaven": {
            "categories": config.wallhaven.categories,
            "top_range": config.wallhaven.top_range,
            "sorting": config.wallhaven.sorting,
            "ai_art_filter": config.wallhaven.ai_art_filter,
            "exclude_tags": config.wallhaven.exclude_tags,
            "exclude_combos": config.wallhaven.exclude_combos,
            "exclude_uploaders": config.wallhaven.exclude_uploaders,
        },
```

- [ ] **Step 2: Add `exclude_uploaders` handling in PATCH /api/config**

In the `update_config_route` function, inside the `if "wallhaven" in updates:` block (after line ~246), add:

```python
        if "exclude_uploaders" in wh:
            config.wallhaven.exclude_uploaders = wh["exclude_uploaders"]
```

- [ ] **Step 3: Add cloud user sync trigger in PATCH /api/config**

After the existing tag cloud sync block (lines ~254-259), add:

```python
    # Sync exclude_uploaders to Wallhaven cloud user blacklist (fire-and-forget)
    if "wallhaven" in updates and "exclude_uploaders" in updates["wallhaven"]:
        from ..wallhaven_web import sync_cloud_user_blacklist

        sync_cloud_user_blacklist(config, config.wallhaven.exclude_uploaders)
```

- [ ] **Step 4: Add GET /api/uploader-suggestions endpoint**

After the `tag_suggestions` endpoint (line ~696), add:

```python
@app.get("/api/uploader-suggestions")
def uploader_suggestions():
    """Suggest uploaders to exclude based on dislike history."""
    config = get_config()
    metadata = _get_metadata()

    from wayper.state import read_mode

    active_purities = read_mode(config)
    metadata = {
        fn: meta for fn, meta in metadata.items() if meta.get("purity", "sfw") in active_purities
    }

    blacklisted = {fn for _, fn in list_blacklist(config) if fn in metadata}

    fav_base = config.download_dir / "favorites"
    favs: set[str] = set()
    if fav_base.is_dir():
        for f in fav_base.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                favs.add(f.name)

    from wayper.suggestions import suggest_uploaders_to_exclude

    results = suggest_uploaders_to_exclude(
        metadata, blacklisted, config.wallhaven.exclude_uploaders, favs
    )
    return {"suggestions": results}
```

- [ ] **Step 5: Verify API starts**

Run: `python3 -c "from wayper.server.api import app; print('ok')"`

Expected: `ok`

---

### Task 7: GUI — settings panel and suggestion display

**Files:**
- Modify: `wayper/electron/index.html:241-246` (add exclude_uploaders field)
- Modify: `wayper/electron/renderer.js:519-520` (render uploaders on settings load)
- Modify: `wayper/electron/renderer.js:553-610` (add uploader render/add/get functions)
- Modify: `wayper/electron/renderer.js:790-797` (include uploaders in save)

- [ ] **Step 1: Add HTML field for exclude_uploaders**

In `wayper/electron/index.html`, after the `exclude-combos-field` div (line ~246), add:

```html
                        <div class="field">
                            <label for="input-exclude-uploader">Exclude Uploaders</label>
                            <div class="tag-input-row">
                                <input type="text" id="input-exclude-uploader" placeholder="Username..." class="tag-input">
                                <button type="button" id="btn-add-uploader" class="btn-add-tag">Add</button>
                            </div>
                            <div id="exclude-uploaders-container" class="tag-chips"></div>
                            <small class="hint">Uploaders to exclude — synced to Wallhaven user blacklist</small>
                        </div>
```

- [ ] **Step 2: Add render/add/get functions in renderer.js**

After the `getExcludeCombos` function (line ~610), add:

```javascript
function renderExcludeUploaders(uploaders) {
    const container = document.getElementById('exclude-uploaders-container');
    container.innerHTML = '';
    uploaders.forEach(u => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = u;
        const btn = document.createElement('button');
        btn.className = 'tag-chip-remove';
        btn.textContent = '\u00d7';
        btn.onclick = () => chip.remove();
        chip.appendChild(btn);
        container.appendChild(chip);
    });
}

function addExcludeUploader() {
    const input = document.getElementById('input-exclude-uploader');
    const name = input.value.trim();
    if (!name) return;
    const container = document.getElementById('exclude-uploaders-container');
    const existing = [...container.querySelectorAll('.tag-chip')].map(c => c.textContent.slice(0, -1));
    if (existing.some(e => e.toLowerCase() === name.toLowerCase())) { input.value = ''; return; }
    renderExcludeUploaders([...existing, name]);
    input.value = '';
}

function getExcludeUploaders() {
    const container = document.getElementById('exclude-uploaders-container');
    return [...container.querySelectorAll('.tag-chip')].map(c => c.textContent.slice(0, -1));
}
```

- [ ] **Step 3: Render uploaders on settings load**

In the `fillSettingsForm` function, after `renderExcludeCombos` (line ~520), add:

```javascript
    renderExcludeUploaders(w.exclude_uploaders || []);
```

- [ ] **Step 4: Include uploaders in save**

In the `saveSettings` function, add `exclude_uploaders` to the `updates.wallhaven` object (line ~796):

```javascript
    updates.wallhaven = {
        categories: document.getElementById('input-categories').value,
        top_range: document.getElementById('input-top-range').value,
        sorting: document.getElementById('input-sorting').value,
        ai_art_filter: parseInt(document.getElementById('input-ai-art').value),
        exclude_tags: getExcludeTags(),
        exclude_combos: getExcludeCombos(),
        exclude_uploaders: getExcludeUploaders()
    };
```

- [ ] **Step 5: Wire up the Add button and Enter key**

In `renderer.js` at line ~213 (after the `input-exclude-tag` keydown listener), add:

```javascript
    document.getElementById('btn-add-uploader').onclick = addExcludeUploader;
    document.getElementById('input-exclude-uploader').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addExcludeUploader(); }
    });
```

- [ ] **Step 6: Verify GUI**

Run: `python -m wayper.server.launcher`

Open the settings panel. Verify the "Exclude Uploaders" field appears with chip input. Add a username, save, reload — confirm it persists.

---

### Task 8: AI suggestions prompt — update to mention local filtering

**Files:**
- Modify: `wayper/ai_suggestions.py:269-279`

- [ ] **Step 1: Update AI prompt text**

The current AI prompt says users can only block uploaders via Wallhaven's account settings. Update it to mention the new `exclude_uploaders` config:

```python
    if top_uploaders:
        parts.append(
            "\n## Top Uploaders in Banned Images\n"
            "These uploaders appear frequently in banned images. Suggest adding them "
            "to exclude_uploaders (filtered locally during download and synced to "
            "Wallhaven's user blacklist). Only suggest uploaders whose ban count is "
            "high relative to their kept count.\n"
        )
        for u in top_uploaders:
            parts.append(f"  {u['uploader']} — {u['ban_count']} banned\n")
```

- [ ] **Step 2: Verify**

Run: `python3 -c "from wayper.ai_suggestions import _build_prompt; print('ok')"`

Expected: `ok`

---

### Task 9: Lint and final verification

- [ ] **Step 1: Run ruff check**

Run: `ruff check wayper/`

Expected: No errors

- [ ] **Step 2: Run ruff format check**

Run: `ruff format --check wayper/`

Expected: No errors (or fix any formatting issues)

- [ ] **Step 3: End-to-end smoke test**

Run: `python3 -c "
from wayper.config import load_config
c = load_config()
print('exclude_uploaders:', c.wallhaven.exclude_uploaders)
print('config ok')

from wayper.suggestions import suggest_uploaders_to_exclude
print('suggestions ok')

from wayper.wallhaven_web import fetch_cloud_users, merge_cloud_users_into_config, sync_cloud_user_blacklist
print('cloud sync ok')

from wayper.server.api import app
print('api ok')
"`

Expected: All `ok` lines printed without errors.
