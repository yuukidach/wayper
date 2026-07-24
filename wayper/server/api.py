from __future__ import annotations

import asyncio
import json as json_mod
import logging
import os
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image

from wayper.ai_suggestions import (
    AISuggestionError,
    generate_ai_suggestions,
    get_ai_status,
    update_ai_history_feedback,
)
from wayper.backend import query_current
from wayper.catalog import ImageCatalog
from wayper.config import WayperConfig, load_config, save_config
from wayper.core import (
    do_ban,
    do_fav,
    do_next,
    do_prev,
    do_set_wallpaper,
    do_unban,
    do_unfav,
)
from wayper.daemon import (
    is_daemon_running,
    request_config_reload,
    request_mode_reload,
    request_stop,
    start_daemon_process,
)
from wayper.lock import FileLock
from wayper.pool import (
    ensure_directories,
    favorite_filenames,
    favorites_dir,
    list_blacklist,
    list_images,
    pool_dir,
    remove_from_blacklist,
)
from wayper.server.config_service import apply_config_updates, config_payload
from wayper.server.schemas import (
    ActionRequest,
    BlocklistEntry,
    BlocklistResponse,
    ConfigResponse,
    ImageItem,
    ImagePage,
    MonitorInfo,
    PreferenceFeedbackRequest,
    SetModeRequest,
    SetWallpaperRequest,
    StatusResponse,
    UnblockRequest,
    UpdateCheckResponse,
    WallhavenConfigModel,
)
from wayper.state import (
    ALL_PURITIES,
    find_in_trash,
    find_many_in_trash,
    purity_from_path,
    read_mode,
    restore_from_trash,
    trash_state_token,
    write_mode,
)
from wayper.status import library_counts
from wayper.suggestions import suggest_combo_patterns, suggest_tags_to_exclude
from wayper.tags import normalize_tag
from wayper.update import check_for_updates

log = logging.getLogger("wayper.api")

# Keep the HTTP schemas and route callables importable from this historical
# module while their definitions live in focused modules.
__all__ = [
    "app",
    "get_config",
    "ActionRequest",
    "BlocklistEntry",
    "BlocklistResponse",
    "ConfigResponse",
    "ImageItem",
    "ImagePage",
    "MonitorInfo",
    "PreferenceFeedbackRequest",
    "SetModeRequest",
    "SetWallpaperRequest",
    "StatusResponse",
    "UnblockRequest",
    "UpdateCheckResponse",
    "WallhavenConfigModel",
    "get_config_route",
    "update_check_route",
    "update_config_route",
    "set_mode_route",
    "sse_events",
    "get_disk_usage",
    "control_action",
    "get_status",
    "get_monitors",
    "get_images",
    "get_images_page",
    "restore_image",
    "get_blocklist",
    "remove_blocklist_entry",
    "set_wallpaper_route",
    "favorite_image",
    "ban_image_route",
    "preference_suggestions",
    "preference_suggestion_feedback",
    "daemon_action",
    "search_images",
    "tag_suggestions",
    "uploader_suggestions",
    "tag_stats",
    "ai_suggestions_status",
    "ai_suggestions_route",
    "ai_suggestions_feedback",
    "serve_trash_image",
    "serve_trash_thumbnail",
    "serve_thumbnail_query",
    "serve_thumbnail",
    "serve_image_query",
    "serve_image",
    "port_file",
    "run",
]

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


def _active_suggestion_data(
    config: WayperConfig,
) -> tuple[dict, set[str], set[str]]:
    """Return metadata and labels restricted to the active purity modes."""
    favorites = _build_favs_set(config)
    catalog = ImageCatalog(
        _get_metadata(),
        (filename for _, filename in list_blacklist(config)),
        favorites,
        purities=read_mode(config),
    )
    return catalog.metadata, set(catalog.banned_filenames), favorites


def _build_favs_set(config) -> set[str]:
    """Compatibility wrapper for callers that use the API helper."""
    # The legacy API ignored dotfiles in favorite directories.  Keep that
    # presentation rule while the shared pool helper handles directory
    # traversal and extension filtering.
    return {name for name in favorite_filenames(config) if not name.startswith(".")}


def _relative_image(config: WayperConfig, image: Path | None) -> str | None:
    if image is None:
        return None
    try:
        return str(image.relative_to(config.download_dir))
    except ValueError:
        return str(image)


def _relative_image_map(config: WayperConfig, images: dict[str, Path]) -> dict[str, str]:
    return {
        monitor: rel
        for monitor, image in images.items()
        if (rel := _relative_image(config, image)) is not None
    }


_image_dir_cache: dict[str, tuple[int, list[tuple[int, Path]]]] = {}
_blocklist_cache: tuple[tuple[int, tuple[int, ...]], dict] | None = None
_trash_image_cache: tuple[tuple[int, tuple[int, ...]], list[ImageItem]] | None = None
MAX_IMAGE_PAGE_LIMIT = 500


def _cached_dir_images(directory: Path) -> list[tuple[int, Path]]:
    """Return image files sorted newest-first, cached by directory mtime."""
    key = str(directory)
    try:
        dir_mtime = directory.stat().st_mtime_ns
    except OSError:
        _image_dir_cache.pop(key, None)
        return []

    cached = _image_dir_cache.get(key)
    if cached and cached[0] == dir_mtime:
        return cached[1]

    records: list[tuple[int, Path]] = []
    for path in list_images(directory):
        try:
            records.append((path.stat().st_mtime_ns, path))
        except OSError:
            continue
    records.sort(key=lambda item: item[0], reverse=True)
    _image_dir_cache[key] = (dir_mtime, records)
    return records


def _count_images_cached(directory: Path) -> int:
    return len(_cached_dir_images(directory))


def _parse_purities(raw: str) -> list[str]:
    purities = [p.strip() for p in raw.split(",") if p.strip() in ALL_PURITIES]
    return purities or ["sfw"]


def _blocklist_token(config: WayperConfig) -> tuple[int, tuple[int, ...]]:
    try:
        blacklist_mtime = config.blacklist_file.stat().st_mtime_ns
    except OSError:
        blacklist_mtime = 0
    return (blacklist_mtime, trash_state_token(config))


def _blocklist_payload(config: WayperConfig, *, include_images: bool = False) -> dict:
    global _blocklist_cache

    token = _blocklist_token(config)
    if _blocklist_cache and _blocklist_cache[0] == token:
        payload = dict(_blocklist_cache[1])
        payload["images"] = _trash_images(config) if include_images else []
        return payload

    entries = list_blacklist(config)
    trashed = find_many_in_trash(config, {filename for _, filename in entries})
    result = []
    for ts, filename in entries:
        recoverable = filename in trashed
        result.append({"filename": filename, "timestamp": ts, "recoverable": recoverable})

    payload = {
        "entries": result,
        "total": len(result),
        "recoverable_count": len(trashed),
    }
    _blocklist_cache = (token, payload)
    payload = dict(payload)
    payload["images"] = _trash_images(config) if include_images else []
    return payload


def _trash_images(config: WayperConfig) -> list[ImageItem]:
    global _trash_image_cache

    token = _blocklist_token(config)
    if _trash_image_cache and _trash_image_cache[0] == token:
        return _trash_image_cache[1]

    payload = _blocklist_payload(config)
    images = [
        ImageItem(path=f"__trash/{entry['filename']}", name=entry["filename"], is_favorite=False)
        for entry in payload["entries"]
        if entry["recoverable"]
    ]
    _trash_image_cache = (token, images)
    return images


def _trash_image_page(config: WayperConfig, offset: int, limit: int):
    payload = _blocklist_payload(config)
    recoverable_entries = [entry for entry in payload["entries"] if entry["recoverable"]]
    page_entries = recoverable_entries[offset : offset + limit]
    items = [
        ImageItem(path=f"__trash/{entry['filename']}", name=entry["filename"], is_favorite=False)
        for entry in page_entries
    ]
    next_offset = offset + len(items)
    if next_offset >= len(recoverable_entries):
        next_offset = None
    return ImagePage(items=items, total=len(recoverable_entries), next_offset=next_offset)


def _resolve_image(config: WayperConfig, image_path: str) -> Path:
    """Resolve and validate an image path stays within download_dir."""
    download_dir = config.download_dir.resolve()
    img_full = (download_dir / image_path).resolve()
    if not img_full.is_relative_to(download_dir):
        raise HTTPException(403, "Path traversal not allowed")
    if not img_full.is_file():
        raise HTTPException(404, "Image not found")
    return img_full


def _pool_image_location(config: WayperConfig, image: Path) -> tuple[str, str] | None:
    """Return a live pool image's purity/orientation, excluding favorites and files."""
    for purity in ALL_PURITIES:
        for orientation in ("landscape", "portrait"):
            if image.parent == pool_dir(config, purity, orientation).resolve():
                return purity, orientation
    return None


def _model_review_item_details(
    result: object,
    item: object,
) -> dict[str, object] | None:
    """Extract bounded, JSON-safe ranking details from a review response."""
    if not isinstance(result, dict) or not isinstance(item, dict):
        return None
    report = result.get("model")
    model = report if isinstance(report, dict) else {}
    details: dict[str, object] = {}
    for key in (
        "schema_version",
        "feature_normalization",
        "trained_at",
    ):
        value = model.get(key)
        if isinstance(value, str | int | float | bool):
            details[key] = value
    for key in (
        "score",
        "feature_score",
        "probability",
        "calibrated",
        "rank",
        "percentile",
    ):
        value = item.get(key)
        if isinstance(value, str | int | float | bool):
            details[key] = value
    return details or None


def _find_review_item(
    config: WayperConfig,
    result: object,
    image: Path,
) -> dict | None:
    """Find a review item only when its path resolves inside the library."""
    if not isinstance(result, dict) or not isinstance(result.get("items"), list):
        return None
    root = config.download_dir.resolve()
    target = image.resolve()
    for item in result["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        try:
            candidate = (config.download_dir / item["path"]).resolve()
        except (OSError, RuntimeError):
            continue
        if candidate.is_relative_to(root) and candidate == target:
            return item
    return None


def _model_review_feedback(config: WayperConfig, image: Path) -> dict[str, object] | None:
    """Return server-observed ranking details for one review candidate.

    The renderer sends only a context marker.  Looking the candidate up again
    here prevents stale or fabricated client scores from becoming part of the
    preference ledger while still preserving useful audit information when the
    image is acted on from the review panel.
    """
    location = _pool_image_location(config, image)
    if location is None:
        return None
    try:
        from wayper.preference_model import preference_deletion_suggestions

        purity, orientation = location
        result = preference_deletion_suggestions(
            config,
            purities=(purity,),
            orientation=orientation,
            limit=60,
        )
    except Exception:
        log.debug("Could not refresh model-review context for %s", image, exc_info=True)
        return None

    item = _find_review_item(config, result, image)
    return _model_review_item_details(result, item) if item else None


def _blocklist_filename(value: str) -> str:
    """Accept only the exact basename format used by blacklist entries."""
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        raise HTTPException(400, "filename must be a single image filename")
    if Path(value).name != value:
        raise HTTPException(400, "filename must be a single image filename")
    return value


def _resolve_download_dir(raw_path: object) -> Path:
    """Validate a user-provided download directory path."""
    if not isinstance(raw_path, str):
        raise HTTPException(400, "download_dir must be a string")
    value = raw_path.strip()
    if not value:
        raise HTTPException(400, "download_dir cannot be empty")
    path = Path(os.path.expandvars(value)).expanduser()
    if not path.is_absolute():
        raise HTTPException(400, "download_dir must be an absolute path or start with ~")
    return path


def _record_preference_feedback(
    config: WayperConfig,
    action: str,
    filename: str,
    source: str,
    *,
    context: str | None = None,
    model: dict[str, object] | None = None,
    strict: bool = False,
    already_locked: bool = False,
) -> None:
    """Persist feedback for routes that do not go through ``core``."""
    try:
        from wayper.preference_model import (
            record_preference_feedback,
        )

        feedback_kwargs: dict[str, object] = {
            "source": source,
            "already_locked": already_locked,
        }
        if context is not None:
            feedback_kwargs["context"] = context
        if model is not None:
            feedback_kwargs["model"] = model
        record_preference_feedback(config, action, filename, **feedback_kwargs)
    except Exception as e:
        # The filesystem action has already succeeded. Feedback must not turn
        # a successful restore/unblock into an HTTP error if its ledger is full
        # or temporarily locked.
        log.warning("Could not record preference feedback for %s", filename, exc_info=True)
        if strict:
            raise HTTPException(500, "Could not save preference feedback") from e
        return

    if already_locked:
        return
    _schedule_preference_model_retrain(config)


def _schedule_preference_model_retrain(config: WayperConfig) -> None:
    """Queue a model refresh after completing a state transaction."""
    try:
        from wayper.preference_model import schedule_preference_model_retrain

        schedule_preference_model_retrain(config)
    except Exception:
        # The label is already durable. A later GUI/API request can queue the
        # refresh again, so scheduling itself must not discard user feedback.
        log.warning("Could not schedule preference model refresh", exc_info=True)


@app.get("/api/config", response_model=ConfigResponse)
def get_config_route():
    config = get_config()
    return config_payload(config, read_mode(config))


@app.get("/api/update-check", response_model=UpdateCheckResponse)
def update_check_route(force: bool = False):
    config = get_config()
    return check_for_updates(config, force=force)


def _dedup_by(items: list, key) -> list:
    """Compatibility wrapper for the old API helper.

    Configuration writes now live in ``config_service``; keeping this tiny
    adapter avoids breaking scripts that imported the helper while making the
    route itself use the shared implementation.
    """
    from wayper.server.config_service import _deduplicate

    return _deduplicate(items, key)


@app.patch("/api/config")
def update_config_route(updates: dict = Body(...)):
    config = get_config()
    changes = apply_config_updates(
        config,
        updates,
        resolve_download_dir=_resolve_download_dir,
    )
    if "download_dir" in updates:
        try:
            ensure_directories(config)
        except OSError as e:
            raise HTTPException(400, f"Cannot create download directory: {e}") from e

    save_config(config)
    request_config_reload(config)
    global _cached_config, _cached_mtime
    _cached_config = config
    _cached_mtime = 0  # force reload on next get_config if file changes again
    if changes.download_dir_changed:
        _image_dir_cache.clear()
        global _cached_metadata, _cached_meta_mtime, _blocklist_cache, _trash_image_cache
        _cached_metadata = None
        _cached_meta_mtime = 0
        _blocklist_cache = None
        _trash_image_cache = None

    # Sync exclude_tags to Wallhaven cloud tag_blacklist (fire-and-forget)
    if changes.exclude_tags_changed:
        from ..wallhaven_web import sync_cloud_tag_blacklist

        sync_cloud_tag_blacklist(config, config.wallhaven.exclude_tags)

    # Sync exclude_uploaders to Wallhaven cloud user blacklist (fire-and-forget)
    if changes.exclude_uploaders_changed:
        from ..wallhaven_web import sync_cloud_user_blacklist

        sync_cloud_user_blacklist(config, config.wallhaven.exclude_uploaders)

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

    current = query_current()
    for monitor_name, img_path in current.items():
        if img_path and purity_from_path(config, img_path) not in purities:
            do_next(config, monitor_name)

    request_mode_reload(config)

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

    handlers = {
        "next": do_next,
        "prev": do_prev,
        "fav": do_fav,
        "unfav": do_unfav,
        "unban": do_unban,
    }
    if action == "ban":
        result = do_ban(config, monitor, clear_thumbnail=lambda p: _remove_thumbnail(config, p))
    elif handler := handlers.get(action):
        result = handler(config, monitor)
    else:
        raise HTTPException(400, f"Unknown action: {action}")

    if not result.ok:
        raise HTTPException(400, result.error)

    response = {"status": result.status or "ok"}
    if result.image:
        response["image"] = str(result.image)
    if result.monitor:
        response["monitor"] = result.monitor
        if action == "ban":
            response["current_image"] = _relative_image(
                config, result.extra.get("replacement_image")
            )
        elif result.image:
            response["current_image"] = _relative_image(config, result.image)
    response.update(result.extra)
    if "replacement_image" in response:
        response["replacement_image"] = _relative_image(config, response["replacement_image"])
    if "replacement_images" in response:
        response["replacement_images"] = _relative_image_map(config, response["replacement_images"])
    return response


@app.get("/api/status", response_model=StatusResponse)
def get_status(orient: str = "", include_recoverable: bool = True):
    config = get_config()
    running, pid = is_daemon_running(config)
    purities = read_mode(config)

    orientations = [orient] if orient in ("landscape", "portrait") else ["landscape", "portrait"]
    pool_c, fav_c = library_counts(
        config,
        purities,
        orientations,
        count=_count_images_cached,
    )

    entries = list_blacklist(config)
    blocklist_c = len(entries)
    recoverable_c = 0
    if include_recoverable:
        recoverable_c = _blocklist_payload(config)["recoverable_count"]

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


def _image_records_for_mode(
    config: WayperConfig,
    mode: str,
    purities: list[str],
    orient: str,
) -> list[tuple[int, Path, bool]]:
    records: list[tuple[int, Path, bool]] = []
    for purity in purities:
        if mode == "pool":
            path = pool_dir(config, purity, orient)
            is_fav = False
        else:
            path = favorites_dir(config, purity, orient)
            is_fav = True
        records.extend((mtime, p, is_fav) for mtime, p in _cached_dir_images(path))

    records.sort(key=lambda item: item[0], reverse=True)
    return records


def _image_items_from_records(
    config: WayperConfig,
    records: list[tuple[int, Path, bool]],
) -> list[ImageItem]:
    return [
        ImageItem(
            path=str(path.relative_to(config.download_dir)),
            name=path.name,
            is_favorite=is_fav,
        )
        for _, path, is_fav in records
    ]


@app.get("/api/images", response_model=list[ImageItem])
def get_images(mode: str = "pool", purity: str = "sfw", orient: str = "landscape"):
    config = get_config()

    if mode == "trash":
        return _blocklist_payload(config, include_images=True)["images"]

    records = _image_records_for_mode(config, mode, _parse_purities(purity), orient)
    return _image_items_from_records(config, records)


@app.get("/api/images/page", response_model=ImagePage)
def get_images_page(
    mode: str = "pool",
    purity: str = "sfw",
    orient: str = "landscape",
    offset: int = 0,
    limit: int = 120,
):
    config = get_config()
    offset = max(0, offset)
    limit = min(MAX_IMAGE_PAGE_LIMIT, max(1, limit))

    if mode == "trash":
        return _trash_image_page(config, offset, limit)
    else:
        records = _image_records_for_mode(config, mode, _parse_purities(purity), orient)
        total = len(records)
        page = _image_items_from_records(config, records[offset : offset + limit])
    next_offset = offset + len(page)
    if next_offset >= total:
        next_offset = None
    return ImagePage(items=page, total=total, next_offset=next_offset)


@app.post("/api/image/restore")
def restore_image(req: ActionRequest):
    config = get_config()
    filename = Path(req.image_path).name

    with FileLock():
        trashed = find_in_trash(config, filename)
        if not trashed:
            raise HTTPException(404, "Image not found in trash")

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
        remove_from_blacklist(config, filename)
        _record_preference_feedback(
            config,
            "unban",
            filename,
            "api_restore",
            already_locked=True,
        )

    _schedule_preference_model_retrain(config)
    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}


@app.get("/api/blocklist", response_model=BlocklistResponse)
def get_blocklist():
    config = get_config()
    return _blocklist_payload(config)


@app.post("/api/blocklist/remove")
def remove_blocklist_entry(req: UnblockRequest):
    config = get_config()
    filename = _blocklist_filename(req.filename)
    with FileLock():
        exists = any(entry_filename == filename for _, entry_filename in list_blacklist(config))
        if exists:
            remove_from_blacklist(config, filename)
            _record_preference_feedback(
                config,
                "unban",
                filename,
                "api_blocklist_remove",
                already_locked=True,
            )
    if exists:
        _schedule_preference_model_retrain(config)
    return {"status": "ok", "removed": exists}


@app.post("/api/wallpaper/set")
def set_wallpaper_route(req: SetWallpaperRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    if not any(m.name == req.monitor for m in config.monitors):
        raise HTTPException(404, "Monitor not found")

    result = do_set_wallpaper(config, req.monitor, img_full)
    if not result.ok:
        raise HTTPException(400, result.error)

    return {
        "status": "ok",
        "monitor": req.monitor,
        "current_image": _relative_image(config, img_full),
    }


@app.post("/api/image/favorite")
def favorite_image(req: ActionRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    is_fav = img_full.is_relative_to((config.download_dir / "favorites").resolve())
    if is_fav:
        result = do_unfav(config, image=img_full, wait_remote=False)
    else:
        result = do_fav(config, image=img_full, wait_remote=False)

    if not result.ok:
        raise HTTPException(400, result.error)

    new_path = str(result.image.relative_to(config.download_dir)) if result.image else ""
    return {"status": "ok", "new_path": new_path, "remote_sync": result.extra.get("remote_sync")}


@app.post("/api/image/ban")
def ban_image_route(req: ActionRequest):
    config = get_config()
    img_full = _resolve_image(config, req.image_path)

    is_model_review = req.preference_context == "model_review"
    review_model = _model_review_feedback(config, img_full) if is_model_review else None

    ban_kwargs: dict[str, object] = {
        "image": img_full,
        "wait_remote": False,
        "clear_thumbnail": lambda p: _remove_thumbnail(config, p),
    }
    if is_model_review:
        ban_kwargs["preference_context"] = "model_review"
        ban_kwargs["preference_model"] = review_model
    result = do_ban(config, **ban_kwargs)
    if not result.ok:
        raise HTTPException(400, result.error)

    return {
        "status": "ok",
        "replacement_images": _relative_image_map(
            config, result.extra.get("replacement_images", {})
        ),
    }


@app.get("/api/preference-suggestions")
def preference_suggestions(purity: str = "", orient: str = "", limit: int = 24):
    """Return local model candidates for human review; never delete automatically."""
    from wayper.preference_model import (
        preference_deletion_suggestions,
        schedule_preference_model_retrain,
    )

    config = get_config()
    purities = _parse_purities(purity) if purity else sorted(read_mode(config))
    result = preference_deletion_suggestions(
        config,
        purities=purities,
        orientation=orient,
        limit=min(60, max(1, limit)),
    )
    learning = result.get("learning")
    if isinstance(learning, dict) and learning.get("due"):
        # A CLI/MCP action may have recorded feedback in another process. Queue
        # the non-blocking refresh when the long-lived API process next observes it.
        schedule_preference_model_retrain(config, force=True)
    return result


@app.post("/api/preference-suggestions/feedback")
def preference_suggestion_feedback(req: PreferenceFeedbackRequest):
    """Record an explicit positive correction for a reviewed candidate."""
    if req.action != "keep":
        raise HTTPException(400, "Only the keep feedback action is supported")
    config = get_config()
    with FileLock():
        image = _resolve_image(config, req.path)
        location = _pool_image_location(config, image)
        if location is None:
            raise HTTPException(400, "Keep feedback is only available for live pool images")

        from wayper.preference_model import preference_deletion_suggestions

        purity, orientation = location
        current_candidates = preference_deletion_suggestions(
            config,
            purities=(purity,),
            orientation=orientation,
            limit=60,
        )
        if not isinstance(current_candidates, dict):
            raise HTTPException(409, "Image is no longer a model review candidate")
        candidate_item = _find_review_item(config, current_candidates, image)
        if candidate_item is None:
            raise HTTPException(409, "Image is no longer a model review candidate")
        candidate_model = _model_review_item_details(current_candidates, candidate_item)

        _record_preference_feedback(
            config,
            "keep",
            image.name,
            "model_suggestion",
            context="model_review",
            model=candidate_model or None,
            strict=True,
            already_locked=True,
        )

    _schedule_preference_model_retrain(config)
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
        start_daemon_process()
        return {"status": "ok"}

    # stop
    running, pid = is_daemon_running(config)
    if not running or not pid:
        return {"status": "not_running"}
    request_stop(config)
    return {"status": "ok"}


@app.get("/api/search")
def search_images(q: str = "", tags: str = "", uploader: str = ""):
    """Search images by tags, uploader, category, or filename.

    Use ?tags=tag1,tag2 for exact multi-tag intersection (all must match).
    Use ?uploader=name for exact uploader match.
    Use ?q=query for substring search.
    """
    if not q and not tags and not uploader:
        return {"matches": [], "suggestions": []}

    result = ImageCatalog(_get_metadata()).search(
        query=q,
        tags=tags.split(",") if tags else (),
        uploader=uploader,
    )
    if tags or uploader:
        return {"matches": list(result.matches), "suggestions": []}
    return {
        "matches": list(result.matches),
        "suggestions": list(result.tag_suggestions),
        "uploader_suggestions": list(result.uploader_suggestions),
    }


@app.get("/api/tag-suggestions")
def tag_suggestions(context: str = ""):
    """Suggest tags to exclude based on dislike history vs same-purity pool.

    With ?context=tag1,tag2, returns refinement suggestions for combo drill-down.
    """
    config = get_config()
    metadata, blacklisted, favs = _active_suggestion_data(config)
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


@app.get("/api/uploader-suggestions")
def uploader_suggestions():
    """Suggest uploaders to exclude based on dislike history."""
    config = get_config()
    metadata, blacklisted, favs = _active_suggestion_data(config)

    from wayper.suggestions import suggest_uploaders_to_exclude

    results = suggest_uploaders_to_exclude(
        metadata, blacklisted, config.wallhaven.exclude_uploaders, favs
    )
    return {"suggestions": results}


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
    purities = [value.strip() for value in purity.split(",") if value.strip()] or None
    catalog = ImageCatalog(
        _get_metadata(),
        (filename for _, filename in list_blacklist(config)),
        _build_favs_set(config),
        purities=purities,
    )
    tag_banned, tag_kept, tag_fav = catalog.tag_counts()

    # Mode: specific tag lookup
    if tags:
        query_tags = [t.strip() for t in tags.split(",") if t.strip()]
        # Case-insensitive lookup map
        results = []
        for qt in query_tags:
            key = normalize_tag(qt)
            results.append(
                {
                    "tag": catalog.display_tag(qt),
                    "banned": tag_banned.get(key, 0),
                    "kept": tag_kept.get(key, 0),
                    "favorites": tag_fav.get(key, 0),
                }
            )
        return {"tags": results, "summary": catalog.summary}

    # Mode: combo lookup
    if combo:
        combo_tags = [t.strip() for t in combo.split(",") if t.strip()]
        canonical_combo = [catalog.display_tag(tag) for tag in combo_tags]
        stats = catalog.combo_stats(combo_tags)
        return {
            "combo": canonical_combo,
            "banned": stats.banned,
            "kept": stats.kept,
            "favorites": stats.favorites,
            "precision": round(stats.precision, 3),
            "summary": catalog.summary,
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
                "tag": catalog.display_tag(t),
                "banned": tag_banned.get(t, 0),
                "kept": tag_kept.get(t, 0),
                "favorites": tag_fav.get(t, 0),
                group + "_count": count,
            }
        )
    return {"top": results_top, "group": group, "summary": catalog.summary}


@app.get("/api/ai-suggestions/status")
async def ai_suggestions_status():
    """Return current AI analysis status for polling."""
    return get_ai_status()


@app.post("/api/ai-suggestions")
async def ai_suggestions_route():
    """Generate AI-powered tag exclusion suggestions using Codex CLI."""
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


@app.head("/trash/{filename}")
@app.get("/trash/{filename}")
def serve_trash_image(filename: str):
    """Serve an image from system trash (not under download_dir)."""
    config = get_config()
    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")
    if not os.access(trashed, os.R_OK):
        log.warning("No permission to read %s — grant Full Disk Access to your terminal", trashed)
        raise HTTPException(403, "Permission denied: grant Full Disk Access to terminal")
    return FileResponse(trashed)


@app.head("/trash-thumbnails/{filename}")
@app.get("/trash-thumbnails/{filename}")
def serve_trash_thumbnail(filename: str):
    """Serve a cached thumbnail for an image in system trash."""
    from wayper.image import generate_thumbnail

    config = get_config()
    trashed = find_in_trash(config, filename)
    if not trashed:
        raise HTTPException(404, "Image not found in trash")
    if not os.access(trashed, os.R_OK):
        log.warning("No permission to read %s — grant Full Disk Access to your terminal", trashed)
        raise HTTPException(403, "Permission denied: grant Full Disk Access to terminal")

    cache_dir = config.download_dir / ".thumbnails" / "__trash"
    thumb = generate_thumbnail(trashed, cache_dir)
    target = thumb if thumb else trashed
    return FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})


def _remove_thumbnail(config: WayperConfig, image_path: str) -> None:
    """Remove cached thumbnail for an image, if it exists."""
    rel = Path(image_path)
    thumb = config.download_dir / ".thumbnails" / rel.parent / (rel.stem + ".jpg")
    thumb.unlink(missing_ok=True)


def _thumbnail_response(config: WayperConfig, image_path: str) -> FileResponse:
    """Serve a cached thumbnail, generating on first request."""
    from wayper.image import generate_thumbnail

    download_dir = config.download_dir.resolve()
    img_full = (download_dir / image_path).resolve()
    if not img_full.is_relative_to(download_dir):
        raise HTTPException(403, "Path traversal not allowed")
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    rel = img_full.relative_to(config.download_dir)
    cache_dir = config.download_dir / ".thumbnails" / rel.parent

    thumb = generate_thumbnail(img_full, cache_dir)
    target = thumb if thumb else img_full
    return FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/thumbnails")
def serve_thumbnail_query(path: str):
    """Serve a cached thumbnail for a relative image path from a query parameter."""
    config = get_config()
    return _thumbnail_response(config, path)


@app.get("/thumbnails/{path:path}")
def serve_thumbnail(path: str):
    """Serve a cached thumbnail for a relative image path in the URL."""
    config = get_config()
    return _thumbnail_response(config, path)


@app.get("/images")
def serve_image_query(path: str):
    """Serve an image for a relative image path from a query parameter."""
    config = get_config()
    img_full = _resolve_image(config, path)
    return FileResponse(img_full, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/images/{path:path}")
def serve_image(path: str):
    """Serve images from the currently configured download directory."""
    config = get_config()
    img_full = _resolve_image(config, path)
    return FileResponse(img_full, headers={"Cache-Control": "public, max-age=86400"})


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
