from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from wayper.backend import FileLock, get_context, query_current, set_wallpaper
from wayper.config import NO_TRANSITION, WayperConfig, load_config, save_config
from wayper.daemon import is_daemon_running, signal_daemon
from wayper.history import go_prev, pick_next
from wayper.history import push as push_history
from wayper.pool import (
    add_to_blacklist,
    favorites_dir,
    list_images,
    pick_random,
    pool_dir,
)
from wayper.state import push_undo, read_mode, write_mode

log = logging.getLogger("wayper.api")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["file://", "http://127.0.0.1:8080", "http://localhost:8080"],
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


# Pydantic models
class StatusResponse(BaseModel):
    running: bool
    pid: int | None = None


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


class ConfigResponse(BaseModel):
    download_dir: str
    interval_min: int
    mode: str
    pool_target: int
    quota_mb: int
    wallhaven: WallhavenConfigModel


class SetModeRequest(BaseModel):
    mode: str


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
        "mode": str(read_mode(config) or "pool"),
        "pool_target": config.pool_target,
        "quota_mb": config.quota_mb,
        "wallhaven": {
            "categories": config.wallhaven.categories,
            "top_range": config.wallhaven.top_range,
            "sorting": config.wallhaven.sorting,
            "ai_art_filter": config.wallhaven.ai_art_filter,
            "exclude_tags": config.wallhaven.exclude_tags,
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

    save_config(config)
    global _cached_config, _cached_mtime
    _cached_config = config
    _cached_mtime = 0  # force reload on next get_config if file changes again
    return {"status": "ok"}


@app.post("/api/mode")
def set_mode_route(req: SetModeRequest):
    if req.mode not in ["sfw", "nsfw"]:
        raise HTTPException(400, "Invalid mode")
    config = get_config()
    write_mode(config, req.mode)
    signal_daemon(config, signal.SIGUSR2)
    return {"status": "ok", "mode": req.mode}


@app.get("/api/disk")
def get_disk_usage():
    from wayper.pool import disk_usage_mb

    config = get_config()
    return {"used_mb": round(disk_usage_mb(config), 1), "quota_mb": config.quota_mb}


@app.post("/api/control/{action}")
def control_action(action: str):
    if action not in ["next", "prev", "dislike", "fav", "unfav"]:
        raise HTTPException(400, "Invalid action")

    config = get_config()
    monitor, mon_cfg, current_img = get_context(config)
    if not mon_cfg:
        raise HTTPException(400, "No monitor config found")

    mode = read_mode(config)

    if action == "next":
        img = pick_next(config, monitor, mon_cfg.orientation)
        if img:
            set_wallpaper(monitor, img, config.transition)
        return {"status": "ok", "image": str(img) if img else None}

    if action == "prev":
        img = go_prev(config, monitor)
        if img:
            set_wallpaper(monitor, img, config.transition)
            return {"status": "ok", "image": str(img)}
        return {"status": "at_oldest"}

    if action in ("fav", "unfav"):
        if not current_img:
            raise HTTPException(400, "No current wallpaper")
        is_fav = current_img.is_relative_to(config.download_dir / "favorites")
        if action == "fav" and is_fav:
            return {"status": "already_favorite"}
        if action == "unfav" and not is_fav:
            return {"status": "not_favorite"}
        with FileLock(blocking=False):
            if action == "fav":
                dest_dir = favorites_dir(config, mode, mon_cfg.orientation)
            else:
                dest_dir = pool_dir(config, mode, mon_cfg.orientation)
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / current_img.name
            current_img.rename(dest)
            set_wallpaper(monitor, dest, NO_TRANSITION)
        return {"status": "ok", "image": str(dest)}

    # dislike
    if not current_img:
        raise HTTPException(400, "No current wallpaper")
    with FileLock(blocking=False):
        if current_img.is_relative_to(config.download_dir / "favorites"):
            return {"status": "is_favorite"}
        next_img = pick_random(config, mode, mon_cfg.orientation)
        if next_img:
            set_wallpaper(monitor, next_img, config.transition)
            push_history(config, monitor, next_img)
        add_to_blacklist(config, current_img.name)
        push_undo(config, current_img.name, current_img.parent)
    return {"status": "ok"}


@app.get("/api/status", response_model=StatusResponse)
def get_status():
    config = get_config()
    running, pid = is_daemon_running(config)
    return StatusResponse(running=running, pid=pid)


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


# Mount images directory
app.mount("/images", StaticFiles(directory=get_config().download_dir), name="images")


def run():
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")
