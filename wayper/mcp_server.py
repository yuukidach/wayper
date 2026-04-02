"""MCP server for wayper — exposes wallpaper control as AI-callable tools."""

from __future__ import annotations

import signal
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .backend import get_context, notify, query_current
from .config import load_config
from .core import do_ban, do_fav, do_next, do_prev, do_unban, do_unfav
from .daemon import is_daemon_running, signal_daemon
from .pool import (
    add_to_blacklist,
    count_images,
    disk_usage_mb,
    favorites_dir,
    load_metadata,
    pool_dir,
)
from .state import read_mode, write_mode

mcp = FastMCP("wayper")


def _config():
    return load_config()


@mcp.tool()
def status() -> dict:
    """Get current wallpaper status: mode, daemon state, disk usage, and per-monitor info."""
    config = _config()
    current_mode = read_mode(config)
    current = query_current()

    monitors_info = []
    for mon in config.monitors:
        img = current.get(mon.name)
        pc = sum(count_images(pool_dir(config, p, mon.orientation)) for p in current_mode)
        fc = sum(count_images(favorites_dir(config, p, mon.orientation)) for p in current_mode)
        monitors_info.append(
            {
                "name": mon.name,
                "orientation": mon.orientation,
                "image": str(img) if img else None,
                "pool_count": pc,
                "favorites_count": fc,
            }
        )

    daemon_running, _ = is_daemon_running(config)

    return {
        "mode": current_mode,
        "daemon": daemon_running,
        "disk_mb": round(disk_usage_mb(config), 1),
        "quota_mb": config.quota_mb,
        "monitors": monitors_info,
    }


@mcp.tool()
def next_wallpaper(monitor: str | None = None) -> dict:
    """Change wallpaper. If monitor is not specified, uses the focused monitor."""
    config = _config()
    result = do_next(config, monitor)
    if not result.ok:
        return {"error": result.error}
    notify("Wallpaper", "Next wallpaper")
    return {"action": "next", "monitor": result.monitor, "image": str(result.image)}


@mcp.tool()
def prev_wallpaper(monitor: str | None = None) -> dict:
    """Go back to previous wallpaper in history."""
    config = _config()
    result = do_prev(config, monitor)
    if not result.ok:
        return {"error": result.error}
    if result.status == "at_oldest":
        return {"status": "at_oldest"}
    notify("Wallpaper", "Previous wallpaper")
    return {"action": "prev", "monitor": result.monitor, "image": str(result.image)}


@mcp.tool()
def fav(open_url: bool = False) -> dict:
    """Favorite the current wallpaper on the focused monitor."""
    config = _config()
    result = do_fav(config, open_url=open_url)
    if not result.ok:
        return {"error": result.error}
    if result.status:
        return {"status": result.status}
    notify("Wallpaper", "Saved to favorites")
    return {"action": "fav", "image": str(result.image), "opened": open_url}


@mcp.tool()
def unfav() -> dict:
    """Remove the current wallpaper from favorites, moving it back to the pool."""
    config = _config()
    result = do_unfav(config)
    if not result.ok:
        return {"error": result.error}
    if result.status:
        return {"status": result.status}
    notify("Wallpaper", "Removed from favorites")
    return {"action": "unfav", "image": str(result.image)}


@mcp.tool()
def ban() -> dict:
    """Ban the current wallpaper: blacklist and switch to a new one."""
    config = _config()
    result = do_ban(config)
    if not result.ok:
        return {"error": result.error}
    if result.status == "is_favorite":
        return {"error": "Can't ban a favorite"}
    notify("Wallpaper", "Banned")
    return {"action": "ban", "image": str(result.image)}


@mcp.tool()
def unban() -> dict:
    """Undo the last ban, restoring the wallpaper from trash."""
    config = _config()
    result = do_unban(config)
    if not result.ok:
        return {"error": result.error}
    if result.status == "nothing_to_undo":
        return {"status": "nothing_to_undo"}
    if result.status == "file_missing":
        return {"status": "file_missing"}
    notify("Wallpaper", f"Restored: {result.image.name if result.image else 'unknown'}")
    return {"action": "unban", "image": str(result.image)}


@mcp.tool()
def set_mode(mode: str | None = None) -> dict:
    """Switch wallpaper mode between SFW and NSFW. Toggles if no mode specified.

    Args:
        mode: "sfw" or "nsfw". If None, toggles the current mode.
    """
    config = _config()
    current = read_mode(config)

    if mode is None:
        mode = "sfw" if current == {"nsfw"} else "nsfw"
    elif mode not in ("sfw", "nsfw"):
        return {"error": f"Invalid mode: {mode}. Use 'sfw' or 'nsfw'."}

    write_mode(config, {mode})

    signal_daemon(config, signal.SIGUSR2)

    notify("Wallpaper", f"Mode: {mode}")
    return {"action": "mode", "mode": mode}


@mcp.tool()
def delete_wallpaper(image_path: str, add_to_blacklist_flag: bool = False) -> dict:
    """Delete a specific wallpaper file. Useful when a wallpaper has display issues.

    Args:
        image_path: Full path to the wallpaper image to delete.
        add_to_blacklist_flag: If True, also add to blacklist to prevent re-download.
    """
    config = _config()
    path = Path(image_path).resolve()

    # Validate path is within the wallpaper directory
    try:
        path.relative_to(config.download_dir.resolve())
    except ValueError:
        return {"error": f"Path is not within wallpaper directory: {image_path}"}

    if not path.exists():
        return {"error": f"File not found: {image_path}"}

    filename = path.name
    path.unlink()

    if add_to_blacklist_flag:
        add_to_blacklist(config, filename)

    return {
        "action": "delete",
        "image": image_path,
        "blacklisted": add_to_blacklist_flag,
    }


@mcp.tool()
def wallpaper_info(image_path: str | None = None) -> dict:
    """Get Wallhaven metadata (tags, category, views, favorites, colors, uploader, etc.)
    for a wallpaper. Defaults to the current wallpaper on the focused monitor.

    Args:
        image_path: Full path to image. If None, uses current wallpaper on focused monitor.
    """
    config = _config()
    if image_path:
        filename = Path(image_path).name
    else:
        _monitor, _mon_cfg, img = get_context(config)
        if not img:
            return {"error": "No current wallpaper"}
        filename = img.name

    meta = load_metadata(config).get(filename)
    if not meta:
        return {"filename": filename, "metadata": None}
    return {"filename": filename, "metadata": meta}


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
