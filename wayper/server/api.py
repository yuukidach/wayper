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

from wayper.ai_suggestions import AISuggestionError, generate_ai_suggestions
from wayper.backend import FileLock, query_current, set_wallpaper
from wayper.config import WayperConfig, load_config, save_config
from wayper.core import do_dislike, do_fav, do_next, do_prev, do_undislike, do_unfav
from wayper.daemon import is_daemon_running, signal_daemon
from wayper.pool import (
    add_to_blacklist,
    count_images,
    favorites_dir,
    list_blacklist,
    list_images,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from wayper.state import (
    ALL_PURITIES,
    find_in_trash,
    push_undo,
    read_mode,
    restore_from_trash,
    write_mode,
)
from wayper.suggestions import suggest_tags_to_exclude

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
    """Return cached config, reloading only when the file changes on disk."""
    global _cached_config, _cached_mtime
    from wayper.config import CONFIG_FILE

    try:
        mtime = CONFIG_FILE.stat().st_mtime
    except OSError:
        mtime = 0
    if _cached_config is None or mtime != _cached_mtime:
        _cached_config = load_config()
        _cached_mtime = mtime
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
    pool_target: int
    quota_mb: int
    proxy: str
    pause_on_lock: bool
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
        "pool_target": config.pool_target,
        "quota_mb": config.quota_mb,
        "proxy": config.proxy or "",
        "pause_on_lock": config.pause_on_lock,
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

    if "pool_target" in updates:
        config.pool_target = updates["pool_target"]
    if "quota_mb" in updates:
        config.quota_mb = updates["quota_mb"]
    if "proxy" in updates:
        config.proxy = updates["proxy"].strip() or None
    if "pause_on_lock" in updates:
        config.pause_on_lock = bool(updates["pause_on_lock"])

    if "wallhaven" in updates:
        wh = updates["wallhaven"]
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

    write_mode(config, purities)
    signal_daemon(config, signal.SIGUSR2)
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
    elif action == "dislike":
        result = do_dislike(config, monitor, clear_thumbnail=lambda p: _remove_thumbnail(config, p))
    elif action == "undislike":
        result = do_undislike(config, monitor)
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
        try:
            rel_path = img_full.relative_to(config.download_dir / "favorites")
            dest = config.download_dir / rel_path
        except ValueError:
            raise HTTPException(400, "Invalid file structure for favorite")
    else:
        rel_path = img_full.relative_to(config.download_dir)
        dest = config.download_dir / "favorites" / rel_path

    dest.parent.mkdir(parents=True, exist_ok=True)
    img_full.rename(dest)
    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}


@app.post("/api/image/dislike")
def dislike_image_route(req: ActionRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    # If in favorites, move back to pool first
    if "favorites" in req.image_path:
        from wayper.state import orientation_from_path, purity_from_path

        purity = purity_from_path(config, img_full)
        dest_dir = pool_dir(config, purity, orientation_from_path(config, img_full))
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img_full.name
        img_full.rename(dest)
        img_full = dest

    try:
        current_wallpapers = query_current()
    except Exception:
        current_wallpapers = {}

    with FileLock(blocking=False):
        purities = read_mode(config)
        for mon in config.monitors:
            current_path = current_wallpapers.get(mon.name)
            if current_path and current_path.resolve() == img_full.resolve():
                next_img = pick_random(config, purities, mon.orientation, exclude=img_full)
                if next_img:
                    set_wallpaper(mon.name, next_img, config.transition)

        add_to_blacklist(config, img_full.name)
        push_undo(config, img_full.name, img_full.parent)
        _remove_thumbnail(config, req.image_path)

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
        subprocess.Popen(
            [sys.executable, "-m", "wayper.cli", "daemon"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"status": "ok"}

    # stop
    running, pid = is_daemon_running(config)
    if not running or not pid:
        return {"status": "not_running"}
    os.kill(pid, signal.SIGTERM)
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
    blacklisted = {fn for _, fn in list_blacklist(config)}

    if context:
        from wayper.suggestions import suggest_combo_refinements

        context_tags = [t.strip() for t in context.split(",") if t.strip()]
        results = suggest_combo_refinements(
            metadata,
            blacklisted,
            context_tags,
            config.wallhaven.exclude_tags,
            config.wallhaven.exclude_combos,
        )
        return {"suggestions": results, "context": context_tags}

    results = suggest_tags_to_exclude(
        metadata, blacklisted, config.wallhaven.exclude_tags, config.wallhaven.exclude_combos
    )
    return {"suggestions": results}


@app.post("/api/ai-suggestions")
async def ai_suggestions_route():
    """Generate AI-powered tag exclusion suggestions using Claude CLI."""
    config = get_config()
    try:
        result = await generate_ai_suggestions(config)
    except AISuggestionError as e:
        status = (
            503 if "not found" in str(e).lower() else 504 if "timed out" in str(e).lower() else 400
        )
        raise HTTPException(status, str(e))
    return result


@app.get("/trash/{filename}")
def serve_trash_image(filename: str):
    """Serve an image from system trash (not under download_dir)."""
    from fastapi.responses import FileResponse

    config = get_config()
    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")
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


def run():
    import uvicorn

    from wayper.logging import setup_logging

    setup_logging()
    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")
