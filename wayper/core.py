"""Unified business logic for wallpaper operations.

All state-modifying operations live here. CLI, API, and MCP are thin wrappers.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .backend import (
    FileLock,
    find_monitor,
    get_context,
    get_focused_monitor,
    query_current,
    set_wallpaper,
)
from .config import NO_TRANSITION, WayperConfig
from .history import go_prev, pick_next
from .history import push as push_history
from .pool import (
    add_to_blacklist,
    favorites_dir,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from .state import (
    orientation_from_path,
    pop_undo,
    purity_from_path,
    push_undo,
    read_mode,
    restore_from_trash,
)

log = logging.getLogger("wayper.core")


@dataclass
class CoreResult:
    """Result of a core wallpaper operation."""

    action: str
    ok: bool = True
    monitor: str | None = None
    image: Path | None = None
    status: str | None = None
    error: str | None = None
    extra: dict = field(default_factory=dict)


def _resolve_monitor(
    config: WayperConfig, monitor: str | None
) -> tuple[str | None, object | None, Path | None]:
    """Resolve monitor name to (monitor, mon_cfg, current_img)."""
    if monitor is None:
        return get_context(config)
    mon_cfg = find_monitor(config, monitor)
    current = query_current()
    return monitor, mon_cfg, current.get(monitor)


def _update_monitors_for_moved_image(config: WayperConfig, old_path: Path, new_path: Path) -> None:
    """If any monitor is showing old_path, update it to new_path (no transition)."""
    try:
        current = query_current()
    except Exception:
        return
    for mon_name, cur in current.items():
        if cur and cur.resolve() == old_path.resolve():
            set_wallpaper(mon_name, new_path, NO_TRANSITION)


def _replace_on_all_monitors(config: WayperConfig, banned_img: Path, purities: set[str]) -> None:
    """Replace banned_img on any monitor currently showing it."""
    try:
        current = query_current()
    except Exception:
        return
    for mon in config.monitors:
        cur = current.get(mon.name)
        if cur and cur.resolve() == banned_img.resolve():
            next_img = pick_random(config, purities, mon.orientation, exclude=banned_img)
            if next_img:
                set_wallpaper(mon.name, next_img, config.transition)
                push_history(config, mon.name, next_img)


def do_next(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Switch to next wallpaper (forward history or random pick)."""
    t0 = time.monotonic()
    monitor, mon_cfg, _ = _resolve_monitor(config, monitor)
    t_resolve = time.monotonic() - t0
    if not mon_cfg:
        log.warning("next: no monitor config found (%.0fms)", t_resolve * 1000)
        return CoreResult(action="next", ok=False, error="No monitor config found")

    img = pick_next(config, monitor, mon_cfg.orientation)
    t_pick = time.monotonic() - t0
    if not img:
        log.warning("next: no images available for %s (%.0fms)", monitor, t_pick * 1000)
        return CoreResult(action="next", ok=False, error="No images available")

    set_wallpaper(monitor, img, config.transition)
    t_total = time.monotonic() - t0
    log.info(
        "next: %s → %s (resolve=%.0fms pick=%.0fms total=%.0fms)",
        monitor,
        img.name,
        t_resolve * 1000,
        (t_pick - t_resolve) * 1000,
        t_total * 1000,
    )
    return CoreResult(action="next", monitor=monitor, image=img)


def do_prev(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Go back to previous wallpaper in history."""
    monitor, mon_cfg, _ = _resolve_monitor(config, monitor)
    if not mon_cfg:
        log.warning("prev: no monitor config found")
        return CoreResult(action="prev", ok=False, error="No monitor config found")

    img = go_prev(config, monitor)
    if not img:
        return CoreResult(action="prev", ok=True, status="at_oldest")

    set_wallpaper(monitor, img, config.transition)
    log.info("prev: %s → %s", monitor, img.name)
    return CoreResult(action="prev", monitor=monitor, image=img)


def do_fav(
    config: WayperConfig,
    monitor: str | None = None,
    open_url: bool = False,
    *,
    image: Path | None = None,
) -> CoreResult:
    """Favorite a wallpaper.

    If `image` is given, operate on that path directly.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action="fav", ok=False, error="No current wallpaper")

        if "favorites" in str(img):
            return CoreResult(action="fav", ok=True, status="already_favorite")

        purity = purity_from_path(config, img)
        orientation = orientation_from_path(config, img)
        dest_dir = favorites_dir(config, purity, orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        # Update wallpaper display if this image is currently shown
        if image is not None:
            _update_monitors_for_moved_image(config, img, dest)
        else:
            set_wallpaper(monitor, dest, NO_TRANSITION)

    from .wallhaven_web import wallhaven_web_fav

    wallhaven_web_fav(config, dest.name)

    if open_url:
        import webbrowser

        from .wallhaven import wallhaven_url

        webbrowser.open(wallhaven_url(img))

    return CoreResult(action="fav", monitor=monitor, image=dest, extra={"opened": open_url})


def do_unfav(
    config: WayperConfig,
    monitor: str | None = None,
    *,
    image: Path | None = None,
) -> CoreResult:
    """Remove a wallpaper from favorites.

    If `image` is given, operate on that path directly.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action="unfav", ok=False, error="No current wallpaper")

        if "favorites" not in str(img):
            return CoreResult(action="unfav", ok=True, status="not_favorite")

        purity = purity_from_path(config, img)
        orientation = orientation_from_path(config, img)
        dest_dir = pool_dir(config, purity, orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        if image is not None:
            _update_monitors_for_moved_image(config, img, dest)
        else:
            set_wallpaper(monitor, dest, NO_TRANSITION)

    from .wallhaven_web import wallhaven_web_unfav

    wallhaven_web_unfav(config, dest.name)

    return CoreResult(action="unfav", monitor=monitor, image=dest)


def do_ban(
    config: WayperConfig,
    monitor: str | None = None,
    clear_thumbnail: Callable[[str], None] | None = None,
    *,
    image: Path | None = None,
) -> CoreResult:
    """Ban a wallpaper: blacklist, trash, switch to next.

    If `image` is given, operate on that path directly and replace it on
    any monitor currently showing it.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action="ban", ok=False, error="No current wallpaper")

        # If in favorites, move back to pool first
        if "favorites" in str(img):
            purity = purity_from_path(config, img)
            orientation = orientation_from_path(config, img)
            dest_dir = pool_dir(config, purity, orientation)
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / img.name
            img.rename(dest)
            img = dest

        # Replace on affected monitors
        purities = read_mode(config)
        if image is not None:
            _replace_on_all_monitors(config, img, purities)
        else:
            next_img = pick_random(config, purities, mon_cfg.orientation, exclude=img)
            if next_img:
                set_wallpaper(monitor, next_img, config.transition)
                push_history(config, monitor, next_img)

        add_to_blacklist(config, img.name)
        push_undo(config, img.name, img.parent)

        if clear_thumbnail:
            try:
                rel = img.relative_to(config.download_dir)
                clear_thumbnail(str(rel))
            except ValueError:
                pass

    from .wallhaven_web import wallhaven_web_unfav

    wallhaven_web_unfav(config, img.name)

    log.info("ban: %s → trashed %s", monitor, img.name)
    return CoreResult(action="ban", monitor=monitor, image=img)


def do_unban(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Undo the last ban: restore from trash, remove from blacklist."""
    with FileLock():
        entry = pop_undo(config)
        if not entry:
            return CoreResult(action="unban", ok=True, status="nothing_to_undo")

        filename, orig_dir = entry
        restored = restore_from_trash(config, filename, orig_dir)
        remove_from_blacklist(config, filename)

        if restored:
            if monitor is None:
                monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, config.transition)
            return CoreResult(action="unban", monitor=monitor, image=restored)

        return CoreResult(
            action="unban",
            ok=True,
            status="file_missing",
            extra={"note": "blacklist entry removed but file not found in trash"},
        )
