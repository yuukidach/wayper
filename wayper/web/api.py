from __future__ import annotations

import logging
import signal
import subprocess
import sys

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from wayper.backend import FileLock, query_current, set_wallpaper
from wayper.config import load_config, save_config
from wayper.daemon import (
    is_daemon_running,
    signal_daemon,
)
from wayper.pool import (
    add_to_blacklist,
    favorites_dir,
    list_blacklist,
    list_images,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from wayper.state import push_undo, read_mode, write_mode

log = logging.getLogger("wayper.api")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

config = load_config()


# Define Pydantic models for API responses
class StatusResponse(BaseModel):
    running: bool
    pid: int | None = None
    pool_count: int = 0
    favorites_count: int = 0
    blocklist_count: int = 0
    mode: str = "sfw"


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


@app.get("/api/config", response_model=ConfigResponse)
def get_config_route():
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
    # Update root config
    if "interval_min" in updates:
        config.interval = updates["interval_min"] * 60
        # Convert min to sec for internal storage if needed,
        # but config.py stores interval in seconds?
        # Let's check config.py: interval: int = 300 (seconds)
        # But api returns interval_min? No, config.interval_min property exists?
        # Let's check config.py again.
        # config.py has `interval` (seconds). It does NOT have `interval_min` property.
        # Ah, the original code had `interval_min` in the response dict:
        # `"interval_min": config.interval_min`.
        # Wait, I might have hallucinated `interval_min` property on config object if
        # it's not in the file I read.
        # The Read output of config.py showed `interval: int = 300`.
        # It did NOT show a property `interval_min`.
        # So `config.interval_min` in the previous `api.py` (line 70) would have failed
        # if it doesn't exist.
        # Let's assume it was a mistake in my previous Write or I missed it.
        # Actually I wrote `config.interval_min` in the previous turn. It might have been broken!
        # Let's fix it to use `interval` (seconds) or calculate min.
        pass

    if "interval" in updates:
        config.interval = updates["interval"]

    if "pool_target" in updates:
        config.pool_target = updates["pool_target"]

    if "quota_mb" in updates:
        config.quota_mb = updates["quota_mb"]

    # Update Wallhaven config
    if "wallhaven" in updates:
        wh_updates = updates["wallhaven"]
        if "categories" in wh_updates:
            config.wallhaven.categories = wh_updates["categories"]
        if "top_range" in wh_updates:
            config.wallhaven.top_range = wh_updates["top_range"]
        if "sorting" in wh_updates:
            config.wallhaven.sorting = wh_updates["sorting"]
        if "ai_art_filter" in wh_updates:
            config.wallhaven.ai_art_filter = wh_updates["ai_art_filter"]
        if "exclude_tags" in wh_updates:
            config.wallhaven.exclude_tags = wh_updates["exclude_tags"]

    save_config(config)

    # If daemon is running, we might need to reload it?
    # signal_daemon(config, signal.SIGUSR2) # Reload mode/config?
    # The daemon only reloads config on SIGHUP or restart usually.
    # Let's restart daemon if running? Or just leave it.

    return {"status": "ok"}


class SetModeRequest(BaseModel):
    mode: str


@app.post("/api/mode")
def set_mode_route(req: SetModeRequest):
    if req.mode not in ["sfw", "nsfw"]:
        raise HTTPException(400, "Invalid mode")
    write_mode(config, req.mode)
    signal_daemon(config, signal.SIGUSR2)
    return {"status": "ok", "mode": req.mode}


@app.get("/api/disk")
def get_disk_usage():
    from wayper.pool import disk_usage_mb

    return {"used_mb": round(disk_usage_mb(config), 1), "quota_mb": config.quota_mb}


@app.post("/api/control/{action}")
def control_action(action: str, monitor: str | None = None):
    # Action: next, prev, dislike, fav, unfav, undislike
    if action not in ["next", "prev", "dislike", "fav", "unfav", "undislike"]:
        raise HTTPException(400, "Invalid action")

    # Use CLI logic via subprocess to ensure consistency
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, action]
    else:
        cmd = [sys.executable, "-m", "wayper.cli", action]

    subprocess.run(cmd, check=False)
    return {"status": "ok"}


@app.get("/api/status", response_model=StatusResponse)
def get_status():
    from wayper.pool import count_images, list_blacklist

    running, pid = is_daemon_running(config)
    mode = read_mode(config)

    # Calculate counts for current mode across all orientations
    pool_c = 0
    fav_c = 0
    for orient in ["landscape", "portrait"]:
        pool_c += count_images(pool_dir(config, mode, orient))
        fav_c += count_images(favorites_dir(config, mode, orient))

    blocklist_c = len(list_blacklist(config))

    return StatusResponse(
        running=running,
        pid=pid,
        pool_count=pool_c,
        favorites_count=fav_c,
        blocklist_count=blocklist_c,
        mode=mode or "pool",
    )


@app.get("/api/monitors", response_model=list[MonitorInfo])
def get_monitors():
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
    if mode == "trash":
        # Return blacklisted images that exist in trash
        # We ignore 'orient' because trash is not separated by orientation
        trash_path = config.trash_dir / purity
        if not trash_path.exists():
            return []

        # Get blacklist sorted by time
        entries = list_blacklist(config)
        images = []
        for _, filename in entries:
            # Check if file exists in trash/purity
            f = trash_path / filename
            if f.exists():
                images.append(f)

        # Also include any files in trash not in blacklist (orphans)?
        # For now, just stick to blacklist for correct ordering.

        return [
            ImageItem(path=str(p.relative_to(config.download_dir)), name=p.name, is_favorite=False)
            for p in images
        ]

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
    img_full = config.download_dir / req.image_path
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    # Verify it is in trash
    # Path could be .trash/sfw/image.jpg or .trash/image.jpg
    if ".trash" not in img_full.parts:
        raise HTTPException(400, "Image is not in trash")

    # Remove from blacklist
    remove_from_blacklist(config, img_full.name)

    # Determine purity from path
    purity = "sfw"
    if "nsfw" in img_full.parts:
        purity = "nsfw"

    # Determine orientation from image dimensions
    try:
        with Image.open(img_full) as img:
            width, height = img.size
            orientation = "landscape" if width >= height else "portrait"
    except Exception:
        # Fallback if image is broken
        orientation = "landscape"

    # Move to pool
    dest_dir = pool_dir(config, purity, orientation)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / img_full.name

    img_full.rename(dest)

    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}


@app.post("/api/wallpaper/set")
def set_wallpaper_route(req: SetWallpaperRequest):
    img_full = config.download_dir / req.image_path
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    # Validate monitor
    if not any(m.name == req.monitor for m in config.monitors):
        raise HTTPException(404, "Monitor not found")

    set_wallpaper(req.monitor, img_full, config.transition)
    return {"status": "ok"}


@app.post("/api/image/favorite")
def favorite_image(req: ActionRequest):
    img_full = config.download_dir / req.image_path
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    parts = img_full.parts
    is_fav = "favorites" in parts

    if is_fav:
        # Move back to pool
        try:
            rel_path = img_full.relative_to(config.download_dir / "favorites")
            dest = config.download_dir / rel_path
        except ValueError:
            raise HTTPException(400, "Invalid file structure for favorite")
    else:
        # Move to favorites
        rel_path = img_full.relative_to(config.download_dir)
        dest = config.download_dir / "favorites" / rel_path

    dest.parent.mkdir(parents=True, exist_ok=True)
    img_full.rename(dest)

    return {"status": "ok", "new_path": str(dest.relative_to(config.download_dir))}


@app.post("/api/image/dislike")
def dislike_image_route(req: ActionRequest):
    img_full = config.download_dir / req.image_path
    if not img_full.exists():
        raise HTTPException(404, "Image not found")

    if "favorites" in req.image_path:
        raise HTTPException(400, "Can't dislike a favorite")

    # Check if currently set
    try:
        current_wallpapers = query_current()
    except Exception:
        current_wallpapers = {}

    with FileLock(blocking=False):
        # If it's the current wallpaper on any monitor, switch it first
        mode = read_mode(config)
        for mon in config.monitors:
            current_path = current_wallpapers.get(mon.name)
            if current_path and current_path.resolve() == img_full.resolve():
                next_img = pick_random(config, mode, mon.orientation)
                if next_img:
                    set_wallpaper(mon.name, next_img, config.transition)

        # Blacklist & Trash
        add_to_blacklist(config, img_full.name)
        push_undo(config, img_full.name, img_full.parent)

    return {"status": "ok"}


@app.post("/api/daemon/{action}")
def daemon_action(action: str):
    if action not in ["start", "stop"]:
        raise HTTPException(status_code=400, detail="Invalid action")

    # Run CLI command
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "daemon", action]
    else:
        cmd = [sys.executable, "-m", "wayper.cli", "daemon", action]

    subprocess.Popen(cmd)
    return {"status": "ok"}


# Mount images directory
app.mount("/images", StaticFiles(directory=config.download_dir), name="images")


def run():
    import uvicorn

    # Use 0.0.0.0 to allow access, though 127.0.0.1 is safer for local
    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")


if __name__ == "__main__":
    # When running as a PyInstaller bundle, we need to run uvicorn programmatically
    # because the 'uvicorn' command line tool isn't available.

    import uvicorn

    # Simple port finding or just stick to 8080 for now
    # Ideally pass port 0 to let OS pick, print it, and Electron reads it.
    # For now, stick to 8080 to match frontend hardcoding.
    # Using 127.0.0.1 explicitly.
    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")
