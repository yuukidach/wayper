"""MCP server for wayper — exposes wallpaper control as AI-callable tools."""

from __future__ import annotations

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .backend import get_context, notify
from .catalog import ImageCatalog
from .config import load_config
from .core import do_ban, do_fav, do_next, do_prev, do_unban, do_unfav
from .daemon import request_mode_reload
from .lock import FileLock
from .pool import (
    IMAGE_EXTENSIONS,
    favorite_filenames,
    favorites_dir,
    list_blacklist,
    load_metadata,
    pool_dir,
)
from .state import ALL_PURITIES, read_mode, write_mode
from .status import status_snapshot
from .tags import normalize_tag

mcp = FastMCP("wayper")


def _config():
    return load_config()


def _is_managed_wallpaper(config, path: Path) -> bool:
    """Return whether a path is a regular wallpaper in a managed live directory."""
    if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
        return False
    for purity in ALL_PURITIES:
        for orientation in ("landscape", "portrait"):
            if path.parent == pool_dir(config, purity, orientation).resolve():
                return True
            if path.parent == favorites_dir(config, purity, orientation).resolve():
                return True
    return False


@mcp.tool()
def status() -> dict:
    """Get current wallpaper status: mode, daemon state, disk usage, and per-monitor info."""
    return status_snapshot(_config())


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

    request_mode_reload(config)

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

    if not _is_managed_wallpaper(config, path):
        return {"error": f"Path is not a managed wallpaper image: {image_path}"}

    if add_to_blacklist_flag:
        # A blacklisted image is an explicit dislike, so it must follow the
        # normal Ban path: system trash + undo + feedback, rather than a
        # permanent unlink that bypasses core state.
        result = do_ban(config, image=path, wait_remote=False)
        if not result.ok:
            return {"error": result.error}
        return {
            "action": "delete",
            "image": image_path,
            "blacklisted": True,
        }

    with FileLock():
        if not path.is_file():
            return {"error": f"File not found: {image_path}"}
        path.unlink()

    return {
        "action": "delete",
        "image": image_path,
        "blacklisted": False,
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


def _collect_favorites(config=None) -> set[str]:
    """Collect favorite filenames across all purities and orientations."""
    return favorite_filenames(config or _config())


def _build_catalog(purity: str | None = None) -> ImageCatalog:
    config = _config()
    purities = [value.strip() for value in purity.split(",") if value.strip()] if purity else None
    return ImageCatalog(
        load_metadata(config),
        (filename for _, filename in list_blacklist(config)),
        _collect_favorites(config),
        purities=purities,
    )


def _build_tag_counts(
    purity: str | None = None,
) -> tuple[dict[str, int], dict[str, int], dict[str, int], dict]:
    """Build per-tag ban/kept/fav counters. Returns (banned, kept, fav, summary).

    Args:
        purity: Comma-separated purity filter (e.g. "nsfw" or "sfw, sketchy").
                If None, includes all purities.
    """
    catalog = _build_catalog(purity)
    banned, kept, favorites = catalog.tag_counts()
    return dict(banned), dict(kept), dict(favorites), catalog.summary


@mcp.tool()
def tag_stats_top(top: int = 30, group: str = "banned", purity: str | None = None) -> dict:
    """Get the most frequent tags in a group, with ban/kept/fav counts for each.

    Args:
        top: Number of tags to return (default 30).
        group: Which group to sort by — "banned", "kept", or "favorites".
        purity: Comma-separated purity filter (e.g. "nsfw" or "sfw, sketchy"). All if omitted.
    """
    tag_banned, tag_kept, tag_fav, summary = _build_tag_counts(purity)

    if group == "banned":
        source = tag_banned
    elif group == "favorites":
        source = tag_fav
    else:
        source = tag_kept

    sorted_tags = sorted(source.items(), key=lambda x: -x[1])[:top]
    results = []
    for t, _ in sorted_tags:
        results.append(
            {
                "tag": t,
                "banned": tag_banned.get(t, 0),
                "kept": tag_kept.get(t, 0),
                "favorites": tag_fav.get(t, 0),
            }
        )
    return {"top": results, "group": group, "summary": summary}


@mcp.tool()
def tag_stats_lookup(tags: str, purity: str | None = None) -> dict:
    """Look up exact ban/kept/fav counts for specific tags.

    Args:
        tags: Comma-separated tag names to look up (e.g. "nude,brunette,MetArt").
        purity: Comma-separated purity filter (e.g. "nsfw"). All if omitted.
    """
    tag_banned, tag_kept, tag_fav, summary = _build_tag_counts(purity)

    # Case-insensitive lookup
    query_tags = [t.strip() for t in tags.split(",") if t.strip()]
    results = []
    for qt in query_tags:
        canonical = normalize_tag(qt)
        results.append(
            {
                "tag": canonical,
                "banned": tag_banned.get(canonical, 0),
                "kept": tag_kept.get(canonical, 0),
                "favorites": tag_fav.get(canonical, 0),
            }
        )
    return {"tags": results, "summary": summary}


@mcp.tool()
def tag_stats_combo(combo: str, purity: str | None = None) -> dict:
    """Check how many banned/kept/fav images match ALL specified tags simultaneously.

    Args:
        combo: Comma-separated tags (e.g. "nude,MetArt"). Returns precision score.
        purity: Comma-separated purity filter (e.g. "nsfw"). All if omitted.
    """
    catalog = _build_catalog(purity)
    combo_tags = [t.strip() for t in combo.split(",") if t.strip()]
    stats = catalog.combo_stats(combo_tags)

    return {
        "combo": combo_tags,
        "banned": stats.banned,
        "kept": stats.kept,
        "favorites": stats.favorites,
        "precision": round(stats.precision, 3),
    }


@mcp.tool()
def uploader_stats_lookup(uploaders: str, purity: str | None = None) -> dict:
    """Look up exact ban/kept/fav counts for specific uploaders.

    Args:
        uploaders: Comma-separated uploader names to look up.
        purity: Comma-separated purity filter (e.g. "nsfw"). All if omitted.
    """
    catalog = _build_catalog(purity)
    query_uploaders = [u.strip() for u in uploaders.split(",") if u.strip()]
    results = []
    for uploader in query_uploaders:
        stats = catalog.uploader_stats(uploader)
        results.append(
            {
                "uploader": catalog.display_uploader(uploader),
                "banned": stats.banned,
                "kept": stats.kept,
                "favorites": stats.favorites,
                "precision": round(stats.precision, 3),
            }
        )

    return {"uploaders": results}


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
