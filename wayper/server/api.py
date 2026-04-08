from __future__ import annotations

import asyncio
import json as json_mod
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from wayper.ai_suggestions import (
    AISuggestionError,
    generate_ai_suggestions,
    get_ai_status,
    update_ai_history_feedback,
)
from wayper.backend import query_current, set_wallpaper
from wayper.config import WayperConfig, load_config, save_config
from wayper.core import do_ban, do_fav, do_next, do_prev, do_unban, do_unfav
from wayper.daemon import is_daemon_running, signal_daemon
from wayper.pool import (
    count_images,
    favorites_dir,
    list_blacklist,
    list_images,
    pool_dir,
    remove_from_blacklist,
)
from wayper.state import (
    ALL_PURITIES,
    find_in_trash,
    purity_from_path,
    read_mode,
    restore_from_trash,
    write_mode,
)
from wayper.suggestions import suggest_combo_patterns, suggest_tags_to_exclude

log = logging.getLogger("wayper.api")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_cached_config: WayperConfig | None = None
_cached_mtime: float = 0


def get_config() -> WayperConfig:
    """Return cached config, reloading when file changes. Monitors are auto-detected."""
    global _cached_config, _cached_mtime
    from wayper.config import CONFIG_FILE

    try:
        mtime = CONFIG_FILE.stat().st_mtime
    except OSError:
        mtime = 0
    if _cached_config is None or mtime != _cached_mtime:
        _cached_config = load_config()
        _cached_mtime = mtime
    else:
        # Refresh monitors (backend caches until display change event)
        try:
            from wayper.backend import detect_monitors

            _cached_config.monitors = detect_monitors()
        except Exception:
            pass
    return _cached_config


_cached_metadata: dict | None = None
_cached_meta_mtime: float = 0


def _get_metadata() -> dict:
    """Return cached metadata, reloading only when the file changes on disk."""
    global _cached_metadata, _cached_meta_mtime
    config = get_config()
    mf = config.metadata_file
    try:
        mtime = mf.stat().st_mtime
    except OSError:
        mtime = 0
    if _cached_metadata is None or mtime != _cached_meta_mtime:
        from wayper.pool import load_metadata

        _cached_metadata = load_metadata(config)
        _cached_meta_mtime = mtime
    return _cached_metadata


# Pydantic models
class StatusResponse(BaseModel):
    running: bool
    pid: int | None = None
    pool_count: int = 0
    favorites_count: int = 0
    blocklist_count: int = 0
    recoverable_count: int = 0
    mode: list[str] = ["sfw"]


class ImageItem(BaseModel):
    path: str
    name: str
    is_favorite: bool = False


class MonitorInfo(BaseModel):
    name: str
    orientation: str
    current_image: str | None = None


class SetWallpaperRequest(BaseModel):
    monitor: str
    image_path: str


class ActionRequest(BaseModel):
    image_path: str
    monitor: str | None = None


class WallhavenConfigModel(BaseModel):
    categories: str
    top_range: str
    sorting: str
    ai_art_filter: int
    exclude_tags: list[str]
    exclude_combos: list[list[str]] = []


class ConfigResponse(BaseModel):
    download_dir: str
    interval_min: int
    mode: list[str]
    quota_mb: int
    proxy: str
    pause_on_lock: bool
    safe_mode: bool
    has_api_key: bool
    has_wh_password: bool
    wallhaven_username: str
    blacklist_ttl_days: int
    wallhaven: WallhavenConfigModel


class SetModeRequest(BaseModel):
    mode: str | None = None
    purities: list[str] | None = None


def _resolve_image(config: WayperConfig, image_path: str) -> Path:
    """Resolve and validate an image path stays within download_dir."""
    img_full = (config.download_dir / image_path).resolve()
    if not img_full.is_relative_to(config.download_dir):
        raise HTTPException(403, "Path traversal not allowed")
    if not img_full.exists():
        raise HTTPException(404, "Image not found")
    return img_full


@app.get("/api/config", response_model=ConfigResponse)
def get_config_route():
    config = get_config()
    return {
        "download_dir": str(config.download_dir),
        "interval_min": config.interval // 60,
        "mode": sorted(read_mode(config)),
        "quota_mb": config.quota_mb,
        "proxy": config.proxy or "",
        "pause_on_lock": config.pause_on_lock,
        "safe_mode": config.safe_mode,
        "has_api_key": bool(config.api_key),
        "has_wh_password": bool(config.wallhaven_password),
        "wallhaven_username": config.wallhaven_username,
        "blacklist_ttl_days": config.blacklist_ttl_days,
        "wallhaven": {
            "categories": config.wallhaven.categories,
            "top_range": config.wallhaven.top_range,
            "sorting": config.wallhaven.sorting,
            "ai_art_filter": config.wallhaven.ai_art_filter,
            "exclude_tags": config.wallhaven.exclude_tags,
            "exclude_combos": config.wallhaven.exclude_combos,
        },
    }


@app.patch("/api/config")
def update_config_route(updates: dict = Body(...)):
    config = get_config()

    if "interval_min" in updates:
        config.interval = updates["interval_min"] * 60
    elif "interval" in updates:
        config.interval = updates["interval"]

    if "quota_mb" in updates:
        config.quota_mb = updates["quota_mb"]
    if "proxy" in updates:
        config.proxy = updates["proxy"].strip() or None
    if "pause_on_lock" in updates:
        config.pause_on_lock = bool(updates["pause_on_lock"])
    if "safe_mode" in updates:
        config.safe_mode = bool(updates["safe_mode"])
    if "api_key" in updates:
        config.api_key = updates["api_key"].strip()
    if "wallhaven_username" in updates:
        config.wallhaven_username = updates["wallhaven_username"].strip()
    if "wallhaven_password" in updates:
        config.wallhaven_password = updates["wallhaven_password"]
    if "blacklist_ttl_days" in updates:
        val = int(updates["blacklist_ttl_days"])
        config.blacklist_ttl_days = val if val > 0 else 0

    if "wallhaven" in updates:
        wh = updates["wallhaven"]
        old_exclude_tags = config.wallhaven.exclude_tags.copy() if "exclude_tags" in wh else None
        if "categories" in wh:
            config.wallhaven.categories = wh["categories"]
        if "top_range" in wh:
            config.wallhaven.top_range = wh["top_range"]
        if "sorting" in wh:
            config.wallhaven.sorting = wh["sorting"]
        if "ai_art_filter" in wh:
            config.wallhaven.ai_art_filter = wh["ai_art_filter"]
        if "exclude_tags" in wh:
            config.wallhaven.exclude_tags = wh["exclude_tags"]
        if "exclude_combos" in wh:
            config.wallhaven.exclude_combos = wh["exclude_combos"]

    save_config(config)
    signal_daemon(config, signal.SIGHUP)
    global _cached_config, _cached_mtime
    _cached_config = config
    _cached_mtime = 0  # force reload on next get_config if file changes again

    # Sync exclude_tags to Wallhaven cloud tag_blacklist (fire-and-forget)
    if "wallhaven" in updates and "exclude_tags" in updates["wallhaven"]:
        if old_exclude_tags != config.wallhaven.exclude_tags:
            from ..wallhaven_web import sync_cloud_tag_blacklist

            sync_cloud_tag_blacklist(config, config.wallhaven.exclude_tags)

    return {"status": "ok"}


@app.post("/api/mode")
def set_mode_route(req: SetModeRequest):
    config = get_config()

    if req.purities is not None:
        purities = set(req.purities) & set(ALL_PURITIES)
    elif req.mode is not None:
        purities = {p.strip() for p in req.mode.split(",") if p.strip() in ALL_PURITIES}
    else:
        raise HTTPException(400, "Provide 'purities' or 'mode'")

    if not purities:
        raise HTTPException(400, "At least one valid purity required")

    if config.safe_mode:
        purities = {"sfw"}

    write_mode(config, purities)
    signal_daemon(config, signal.SIGUSR2)

    current = query_current()
    for monitor_name, img_path in current.items():
        if img_path and purity_from_path(config, img_path) not in purities:
            do_next(config, monitor_name)

    return {"status": "ok", "purities": sorted(purities)}


@app.get("/api/events")
async def sse_events():
    """SSE stream for real-time state changes (mode, wallpaper)."""
    from starlette.responses import StreamingResponse

    async def event_stream():
        config = get_config()
        last_mtime = 0.0
        last_mode: set[str] = set()
        last_wallpapers: dict[str, str | None] = {}
        tick = 0
        try:
            last_mtime = config.state_file.stat().st_mtime
            last_mode = read_mode(config)
        except OSError:
            pass
        try:
            wp = query_current()
            last_wallpapers = {k: str(v) if v else None for k, v in wp.items()}
        except OSError:
            pass

        while True:
            await asyncio.sleep(0.3)
            tick += 1
            try:
                mtime = config.state_file.stat().st_mtime
                if mtime != last_mtime:
                    last_mtime = mtime
                    current = read_mode(config)
                    if current != last_mode:
                        last_mode = current
                        payload = json_mod.dumps({"type": "mode", "purities": sorted(current)})
                        yield f"data: {payload}\n\n"
            except OSError:
                pass

            # Check wallpaper changes every ~1s (every 3rd tick)
            if tick % 3 == 0:
                try:
                    current_wp = query_current()
                    wp_strs = {k: str(v) if v else None for k, v in current_wp.items()}
                    if wp_strs != last_wallpapers:
                        last_wallpapers = wp_strs
                        payload = json_mod.dumps({"type": "wallpaper"})
                        yield f"data: {payload}\n\n"
                except OSError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/disk")
def get_disk_usage():
    from wayper.pool import disk_usage_mb

    config = get_config()
    return {"used_mb": round(disk_usage_mb(config), 1), "quota_mb": config.quota_mb}


@app.post("/api/control/{action}")
def control_action(action: str, monitor_name: str | None = Body(None, embed=True)):
    config = get_config()

    # Resolve monitor
    monitor = monitor_name
    if not monitor:
        from wayper.backend import get_context

        monitor, _, _ = get_context(config)

    if action == "next":
        result = do_next(config, monitor)
    elif action == "prev":
        result = do_prev(config, monitor)
    elif action == "fav":
        result = do_fav(config, monitor)
    elif action == "unfav":
        result = do_unfav(config, monitor)
    elif action == "ban":
        result = do_ban(config, monitor, clear_thumbnail=lambda p: _remove_thumbnail(config, p))
    elif action == "unban":
        result = do_unban(config, monitor)
    else:
        raise HTTPException(400, f"Unknown action: {action}")

    if not result.ok:
        raise HTTPException(400, result.error)

    response = {"status": result.status or "ok"}
    if result.image:
        response["image"] = str(result.image)
    response.update(result.extra)
    return response


@app.get("/api/status", response_model=StatusResponse)
def get_status(orient: str = ""):
    config = get_config()
    running, pid = is_daemon_running(config)
    purities = read_mode(config)

    orientations = [orient] if orient in ("landscape", "portrait") else ["landscape", "portrait"]
    pool_c = 0
    fav_c = 0
    for purity in purities:
        for o in orientations:
            pool_c += count_images(pool_dir(config, purity, o))
            fav_c += count_images(favorites_dir(config, purity, o))

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


@app.get("/api/monitors", response_model=list[MonitorInfo])
def get_monitors():
    config = get_config()
    current_wallpapers = query_current()
    monitors = []
    for m in config.monitors:
        img_path = current_wallpapers.get(m.name)
        img_rel = None
        if img_path:
            try:
                img_rel = str(img_path.relative_to(config.download_dir))
            except ValueError:
                pass
        monitors.append(MonitorInfo(name=m.name, orientation=m.orientation, current_image=img_rel))
    return monitors


@app.get("/api/images", response_model=list[ImageItem])
def get_images(mode: str = "pool", purity: str = "sfw", orient: str = "landscape"):
    config = get_config()

    if mode == "trash":
        entries = list_blacklist(config)
        items = []
        for _, filename in entries:
            trashed = find_in_trash(config, filename)
            if trashed:
                items.append(
                    ImageItem(
                        path=f"__trash/{filename}",
                        name=filename,
                        is_favorite=False,
                    )
                )
        return items

    if mode == "pool":
        path = pool_dir(config, purity, orient)
    else:
        path = favorites_dir(config, purity, orient)

    if not path.exists():
        return []

    images = list_images(path)
    images.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    is_fav = mode == "favorites"

    return [
        ImageItem(path=str(p.relative_to(config.download_dir)), name=p.name, is_favorite=is_fav)
        for p in images
    ]


@app.post("/api/image/restore")
def restore_image(req: ActionRequest):
    config = get_config()
    filename = Path(req.image_path).name

    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")

    remove_from_blacklist(config, filename)

    try:
        with Image.open(trashed) as img:
            width, height = img.size
            orientation = "landscape" if width >= height else "portrait"
    except Exception:
        orientation = "landscape"

    meta = _get_metadata()
    img_meta = meta.get(filename, {})
    purity = img_meta.get("purity", "sfw")
    if purity not in ALL_PURITIES:
        purity = "sfw"

    dest_dir = pool_dir(config, purity, orientation)
    dest = restore_from_trash(config, filename, dest_dir)
    if not dest:
        raise HTTPException(500, "Failed to restore image")

    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}


@app.get("/api/blocklist")
def get_blocklist():
    config = get_config()
    entries = list_blacklist(config)
    result = []
    for ts, filename in entries:
        recoverable = find_in_trash(config, filename) is not None
        result.append({"filename": filename, "timestamp": ts, "recoverable": recoverable})
    recoverable_count = sum(1 for e in result if e["recoverable"])
    return {"entries": result, "total": len(result), "recoverable_count": recoverable_count}


class UnblockRequest(BaseModel):
    filename: str


@app.post("/api/blocklist/remove")
def remove_blocklist_entry(req: UnblockRequest):
    config = get_config()
    remove_from_blacklist(config, req.filename)
    return {"status": "ok"}


@app.post("/api/wallpaper/set")
def set_wallpaper_route(req: SetWallpaperRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    if not any(m.name == req.monitor for m in config.monitors):
        raise HTTPException(404, "Monitor not found")

    set_wallpaper(req.monitor, img_full, config.transition)
    return {"status": "ok"}


@app.post("/api/image/favorite")
def favorite_image(req: ActionRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    is_fav = img_full.is_relative_to(config.download_dir / "favorites")
    if is_fav:
        result = do_unfav(config, image=img_full)
    else:
        result = do_fav(config, image=img_full)

    if not result.ok:
        raise HTTPException(400, result.error)

    new_path = str(result.image.relative_to(config.download_dir)) if result.image else ""
    return {"status": "ok", "new_path": new_path}


@app.post("/api/image/ban")
def ban_image_route(req: ActionRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    result = do_ban(
        config,
        image=img_full,
        clear_thumbnail=lambda p: _remove_thumbnail(config, p),
    )
    if not result.ok:
        raise HTTPException(400, result.error)

    return {"status": "ok"}


@app.post("/api/daemon/{action}")
def daemon_action(action: str):
    if action not in ["start", "stop"]:
        raise HTTPException(status_code=400, detail="Invalid action")

    config = get_config()

    if action == "start":
        running, _ = is_daemon_running(config)
        if running:
            return {"status": "already_running"}
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "daemon"]
        else:
            cmd = [sys.executable, "-m", "wayper.cli", "daemon"]
        subprocess.Popen(
            cmd,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"status": "ok"}

    # stop
    running, pid = is_daemon_running(config)
    if not running or not pid:
        return {"status": "not_running"}
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass  # already dead
    return {"status": "ok"}


@app.get("/api/search")
def search_images(q: str = "", tags: str = ""):
    """Search images by tags, category, or filename.

    Use ?tags=tag1,tag2 for exact multi-tag intersection (all must match).
    Use ?q=query for substring search.
    """
    if not q and not tags:
        return {"matches": [], "suggestions": []}

    metadata = _get_metadata()
    matches: list[str] = []
    tag_counts: dict[str, int] = {}

    if tags:
        # Exact tag intersection: image must have ALL specified tags
        required = {t.strip().lower() for t in tags.split(",") if t.strip()}
        for filename, meta in metadata.items():
            img_tags = {t.lower() for t in meta.get("tags", [])}
            if required.issubset(img_tags):
                matches.append(filename)
        return {"matches": matches, "suggestions": []}

    query = q.lower()
    for filename, meta in metadata.items():
        img_tags = [t.lower() for t in meta.get("tags", [])]
        category = meta.get("category", "").lower()
        fname = filename.lower()

        if any(query in tag for tag in img_tags) or query in category or query in fname:
            matches.append(filename)
            for tag in meta.get("tags", []):
                if tag.lower().startswith(query):
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1

    suggestions = sorted(tag_counts.keys(), key=lambda t: -tag_counts[t])[:8]
    return {"matches": matches, "suggestions": suggestions}


@app.get("/api/tag-suggestions")
def tag_suggestions(context: str = ""):
    """Suggest tags to exclude based on dislike history vs same-purity pool.

    With ?context=tag1,tag2, returns refinement suggestions for combo drill-down.
    """
    config = get_config()
    metadata = _get_metadata()

    # Filter to current purity mode — stale data from inactive modes hurts suggestions
    from wayper.state import read_mode

    active_purities = read_mode(config)
    metadata = {
        fn: meta for fn, meta in metadata.items() if meta.get("purity", "sfw") in active_purities
    }

    blacklisted = {fn for _, fn in list_blacklist(config) if fn in metadata}

    # Build favorites set from filesystem
    fav_base = config.download_dir / "favorites"
    favs: set[str] = set()
    if fav_base.is_dir():
        for f in fav_base.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                favs.add(f.name)

    if context:
        from wayper.suggestions import suggest_combo_refinements

        context_tags = [t.strip() for t in context.split(",") if t.strip()]
        results = suggest_combo_refinements(
            metadata,
            blacklisted,
            context_tags,
            config.wallhaven.exclude_tags,
            config.wallhaven.exclude_combos,
            favs,
        )
        return {"suggestions": results, "context": context_tags}

    results = suggest_tags_to_exclude(
        metadata, blacklisted, config.wallhaven.exclude_tags, config.wallhaven.exclude_combos, favs
    )
    combos = suggest_combo_patterns(
        metadata, blacklisted, config.wallhaven.exclude_tags, config.wallhaven.exclude_combos, favs
    )
    return {"suggestions": results, "combo_suggestions": combos}


@app.get("/api/tag-stats")
def tag_stats(
    tags: str = "",
    top: int = 30,
    group: str = "banned",
    combo: str = "",
    purity: str = "",
):
    """Query tag statistics for AI analysis.

    Modes:
      ?tags=tag1,tag2  — exact ban/kept/fav counts for specific tags
      ?top=N&group=banned|kept|favorites — top N tags by group count
      ?combo=tag1,tag2  — counts for images matching ALL tags simultaneously
    """
    config = get_config()
    metadata = _get_metadata()
    blacklisted = {fn for _, fn in list_blacklist(config)}

    fav_base = config.download_dir / "favorites"
    favs: set[str] = set()
    if fav_base.is_dir():
        for f in fav_base.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                favs.add(f.name)

    # Parse purity filter
    purity_set: set[str] | None = None
    if purity:
        purity_set = {p.strip().lower() for p in purity.split(",") if p.strip()}

    # Build per-tag counters in a single pass
    tag_banned: dict[str, int] = {}
    tag_kept: dict[str, int] = {}
    tag_fav: dict[str, int] = {}
    total_banned = 0
    total_kept = 0
    total_fav = 0

    for filename, meta in metadata.items():
        if purity_set and meta.get("purity", "sfw") not in purity_set:
            continue
        file_tags = meta.get("tags", [])
        if filename in blacklisted:
            total_banned += 1
            for t in file_tags:
                tag_banned[t] = tag_banned.get(t, 0) + 1
        else:
            total_kept += 1
            is_fav = filename in favs
            if is_fav:
                total_fav += 1
            for t in file_tags:
                tag_kept[t] = tag_kept.get(t, 0) + 1
                if is_fav:
                    tag_fav[t] = tag_fav.get(t, 0) + 1

    summary = {
        "total_banned": total_banned,
        "total_kept": total_kept,
        "total_favorites": total_fav,
    }

    # Mode: specific tag lookup
    if tags:
        query_tags = [t.strip() for t in tags.split(",") if t.strip()]
        # Case-insensitive lookup map
        lower_map: dict[str, str] = {}
        for t in set(tag_banned) | set(tag_kept):
            lower_map.setdefault(t.lower(), t)
        results = []
        for qt in query_tags:
            canonical = lower_map.get(qt.lower(), qt)
            results.append(
                {
                    "tag": canonical,
                    "banned": tag_banned.get(canonical, 0),
                    "kept": tag_kept.get(canonical, 0),
                    "favorites": tag_fav.get(canonical, 0),
                }
            )
        return {"tags": results, "summary": summary}

    # Mode: combo lookup
    if combo:
        combo_tags = [t.strip() for t in combo.split(",") if t.strip()]
        lower_map_c: dict[str, str] = {}
        for t in set(tag_banned) | set(tag_kept):
            lower_map_c.setdefault(t.lower(), t)
        canonical_combo = [lower_map_c.get(t.lower(), t) for t in combo_tags]
        combo_lower = {t.lower() for t in canonical_combo}

        combo_banned = 0
        combo_kept = 0
        combo_fav = 0
        for filename, meta in metadata.items():
            file_tags_lower = {t.lower() for t in meta.get("tags", [])}
            if combo_lower.issubset(file_tags_lower):
                if filename in blacklisted:
                    combo_banned += 1
                else:
                    combo_kept += 1
                    if filename in favs:
                        combo_fav += 1
        precision = (
            combo_banned / (combo_banned + combo_kept + 3 * combo_fav)
            if (combo_banned + combo_kept + combo_fav) > 0
            else 0
        )
        return {
            "combo": canonical_combo,
            "banned": combo_banned,
            "kept": combo_kept,
            "favorites": combo_fav,
            "precision": round(precision, 3),
            "summary": summary,
        }

    # Mode: top N tags by group
    if group == "banned":
        source = tag_banned
    elif group == "favorites":
        source = tag_fav
    else:
        source = tag_kept

    sorted_tags = sorted(source.items(), key=lambda x: -x[1])[:top]
    results_top = []
    for t, count in sorted_tags:
        results_top.append(
            {
                "tag": t,
                "banned": tag_banned.get(t, 0),
                "kept": tag_kept.get(t, 0),
                "favorites": tag_fav.get(t, 0),
                group + "_count": count,
            }
        )
    return {"top": results_top, "group": group, "summary": summary}


@app.get("/api/ai-suggestions/status")
async def ai_suggestions_status():
    """Return current AI analysis status for polling."""
    return get_ai_status()


@app.post("/api/ai-suggestions")
async def ai_suggestions_route():
    """Generate AI-powered tag exclusion suggestions using Claude CLI."""
    config = get_config()
    try:
        result = await generate_ai_suggestions(config)
    except AISuggestionError as e:
        log.warning("AI suggestion error [%s]: %s", e.code, e)
        status_map = {"cli_not_found": 503, "timeout": 504}
        raise HTTPException(status_map.get(e.code, 400), str(e))
    return result


@app.post("/api/ai-suggestions/feedback")
async def ai_suggestions_feedback(body: dict = Body()):
    """Record user feedback on an AI suggestion (applied/dismissed)."""
    tags = body.get("tags", [])
    action = body.get("action", "")
    if not tags or action not in ("applied_add", "applied_remove", "dismissed"):
        raise HTTPException(400, "Invalid feedback: need tags and action")
    config = get_config()
    update_ai_history_feedback(config.ai_history_file, tags, action)
    return {"ok": True}


@app.get("/trash/{filename}")
def serve_trash_image(filename: str):
    """Serve an image from system trash (not under download_dir)."""
    from fastapi.responses import FileResponse

    config = get_config()
    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")
    if not os.access(trashed, os.R_OK):
        log.warning("No permission to read %s — grant Full Disk Access to your terminal", trashed)
        raise HTTPException(403, "Permission denied: grant Full Disk Access to terminal")
    return FileResponse(trashed)


def _remove_thumbnail(config: WayperConfig, image_path: str) -> None:
    """Remove cached thumbnail for an image, if it exists."""
    rel = Path(image_path)
    thumb = config.download_dir / ".thumbnails" / rel.parent / (rel.stem + ".jpg")
    thumb.unlink(missing_ok=True)


@app.get("/thumbnails/{path:path}")
def serve_thumbnail(path: str):
    """Serve a cached thumbnail, generating on first request."""
    from fastapi.responses import FileResponse

    from wayper.image import generate_thumbnail

    config = get_config()
    img_full = (config.download_dir / path).resolve()
    if not img_full.is_relative_to(config.download_dir):
        raise HTTPException(403, "Path traversal not allowed")
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    rel = img_full.relative_to(config.download_dir)
    cache_dir = config.download_dir / ".thumbnails" / rel.parent

    thumb = generate_thumbnail(img_full, cache_dir)
    target = thumb if thumb else img_full
    return FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})


# Mount images directory
_dl_dir = get_config().download_dir
_dl_dir.mkdir(parents=True, exist_ok=True)
app.mount("/images", StaticFiles(directory=_dl_dir), name="images")


def _find_free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_file() -> Path:
    from wayper.config import CONFIG_DIR

    return CONFIG_DIR / "api.port"


def run():
    import atexit

    import uvicorn

    from wayper.logging import setup_logging

    setup_logging()

    port = _find_free_port()
    pf = port_file()
    pf.parent.mkdir(parents=True, exist_ok=True)
    pf.write_text(str(port))
    atexit.register(lambda: pf.unlink(missing_ok=True))

    log.info("API server starting on port %d", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    run()
