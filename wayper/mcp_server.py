"""MCP server for wayper — exposes wallpaper control as AI-callable tools."""

from __future__ import annotations

import signal
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .backend import (
    FileLock,
    find_monitor,
    get_context,
    get_focused_monitor,
    notify,
    query_current,
    set_wallpaper,
)
from .config import NO_TRANSITION, load_config
from .daemon import is_daemon_running, signal_daemon
from .history import go_prev, pick_next
from .history import push as push_history
from .pool import (
    add_to_blacklist,
    count_images,
    disk_usage_mb,
    favorites_dir,
    load_metadata,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from .state import pop_undo, push_undo, read_mode, restore_from_trash, write_mode

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
        pc = count_images(pool_dir(config, current_mode, mon.orientation))
        fc = count_images(favorites_dir(config, current_mode, mon.orientation))
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
    """Change wallpaper. If monitor is not specified, uses the focused monitor.

    Args:
        monitor: Monitor name (e.g. "DP-1"). If None, uses focused monitor.
    """
    config = _config()
    if monitor is None:
        monitor = get_focused_monitor()
    mon_cfg = find_monitor(config, monitor)
    if not mon_cfg:
        return {"error": f"No config for monitor {monitor}"}

    img = pick_next(config, monitor, mon_cfg.orientation)
    if not img:
        return {"error": "No images available"}

    set_wallpaper(monitor, img, config.transition)
    notify("Wallpaper", "Next wallpaper")
    return {"action": "next", "monitor": monitor, "image": str(img)}


@mcp.tool()
def prev_wallpaper(monitor: str | None = None) -> dict:
    """Go back to the previous wallpaper.

    Args:
        monitor: Monitor name (e.g. "DP-1"). If None, uses focused monitor.
    """
    config = _config()
    if monitor is None:
        monitor = get_focused_monitor()

    img = go_prev(config, monitor)
    if not img:
        return {"status": "at_oldest"}

    set_wallpaper(monitor, img, config.transition)
    notify("Wallpaper", "Previous wallpaper")
    return {"action": "prev", "monitor": monitor, "image": str(img)}


@mcp.tool()
def fav(open_url: bool = False) -> dict:
    """Favorite the current wallpaper on the focused monitor.

    Args:
        open_url: If True, also open the wallpaper on Wallhaven in browser.
    """
    config = _config()
    with FileLock():
        monitor, mon_cfg, img = get_context(config)
        if not img or not mon_cfg:
            return {"error": "No current wallpaper"}

        if "favorites" in str(img):
            return {"status": "already_favorite"}

        mode = read_mode(config)
        dest_dir = favorites_dir(config, mode, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)

        if open_url:
            import webbrowser

            from .browse._common import wallhaven_url

            webbrowser.open(wallhaven_url(img))

        notify("Wallpaper", "Saved to favorites")
        return {"action": "fav", "image": str(dest), "opened": open_url}


@mcp.tool()
def unfav() -> dict:
    """Remove the current wallpaper from favorites, moving it back to the pool."""
    config = _config()
    with FileLock():
        monitor, mon_cfg, img = get_context(config)
        if not img or not mon_cfg:
            return {"error": "No current wallpaper"}

        if "favorites" not in str(img):
            return {"status": "not_favorite"}

        mode = read_mode(config)
        dest_dir = pool_dir(config, mode, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)
        notify("Wallpaper", "Removed from favorites")
        return {"action": "unfav", "image": str(dest)}


@mcp.tool()
def dislike() -> dict:
    """Blacklist the current wallpaper and switch to a new one. Can be undone with undislike."""
    config = _config()
    with FileLock():
        monitor, mon_cfg, img = get_context(config)
        if not img or not mon_cfg:
            return {"error": "No current wallpaper"}

        if "favorites" in str(img):
            return {"error": "Can't dislike a favorite"}

        mode = read_mode(config)
        next_img = pick_random(config, mode, mon_cfg.orientation)
        if next_img:
            set_wallpaper(monitor, next_img, config.transition)
            push_history(config, monitor, next_img)

        add_to_blacklist(config, img.name)
        push_undo(config, img.name, img.parent)
        notify("Wallpaper", "Disliked")
        return {"action": "dislike", "image": str(img)}


@mcp.tool()
def undislike() -> dict:
    """Undo the last dislike, restoring the wallpaper from trash."""
    config = _config()
    with FileLock():
        entry = pop_undo(config)
        if not entry:
            return {"status": "nothing_to_undo"}

        filename, orig_dir = entry
        restored = restore_from_trash(config, filename, orig_dir)
        remove_from_blacklist(config, filename)

        if restored:
            monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, config.transition)
            notify("Wallpaper", f"Restored: {filename}")
            return {"action": "undislike", "image": str(restored)}
        return {"status": "file_missing"}


@mcp.tool()
def set_mode(mode: str | None = None) -> dict:
    """Switch wallpaper mode between SFW and NSFW. Toggles if no mode specified.

    Args:
        mode: "sfw" or "nsfw". If None, toggles the current mode.
    """
    config = _config()
    current = read_mode(config)

    if mode is None:
        mode = "sfw" if current == "nsfw" else "nsfw"
    elif mode not in ("sfw", "nsfw"):
        return {"error": f"Invalid mode: {mode}. Use 'sfw' or 'nsfw'."}

    write_mode(config, mode)

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
