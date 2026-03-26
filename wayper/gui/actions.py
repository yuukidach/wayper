"""Shared wallpaper action logic used by both GTK4 and macOS GUI."""

from __future__ import annotations

import webbrowser
from pathlib import Path

from ..backend import (
    find_monitor,
    get_context,
    get_focused_monitor,
    query_current,
    set_wallpaper,
)
from ..browse._common import wallhaven_url
from ..config import NO_TRANSITION, MonitorConfig, WayperConfig
from ..history import go_prev, pick_next
from ..history import push as push_history
from ..pool import add_to_blacklist, favorites_dir, pick_random, pool_dir, remove_from_blacklist
from ..state import pop_undo, push_undo, read_mode, restore_from_trash


def _resolve_context(
    config: WayperConfig, monitor: str | None = None
) -> tuple[str | None, MonitorConfig | None, Path | None]:
    """Resolve monitor context, optionally overriding the focused monitor."""
    if monitor:
        mon_cfg = find_monitor(config, monitor)
        current = query_current()
        img = current.get(monitor)
        return monitor, mon_cfg, img
    return get_context(config)


def do_next(config: WayperConfig, monitor: str | None = None) -> None:
    """Pick next wallpaper from history/pool and apply it."""
    mon, mon_cfg, _ = _resolve_context(config, monitor)
    if not mon_cfg:
        return
    img = pick_next(config, mon, mon_cfg.orientation)
    if img:
        set_wallpaper(mon, img, config.transition)


def do_prev(config: WayperConfig, monitor: str | None = None) -> None:
    """Go back to previous wallpaper in history."""
    mon, mon_cfg, _ = _resolve_context(config, monitor)
    if not mon_cfg:
        return
    img = go_prev(config, mon)
    if img:
        set_wallpaper(mon, img, config.transition)


def do_favorite(config: WayperConfig, monitor: str | None = None) -> None:
    """Move current wallpaper to favorites."""
    mon, mon_cfg, img = _resolve_context(config, monitor)
    if not img or not mon_cfg:
        return
    if "favorites" in str(img):
        return
    mode = read_mode(config)
    dest_dir = favorites_dir(config, mode, mon_cfg.orientation)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / img.name
    img.rename(dest)
    set_wallpaper(mon, dest, NO_TRANSITION)


def do_unfavorite(config: WayperConfig, monitor: str | None = None) -> None:
    """Move current wallpaper back to pool from favorites."""
    mon, mon_cfg, img = _resolve_context(config, monitor)
    if not img or not mon_cfg:
        return
    if "favorites" not in str(img):
        return
    mode = read_mode(config)
    dest_dir = pool_dir(config, mode, mon_cfg.orientation)
    dest = dest_dir / img.name
    img.rename(dest)
    set_wallpaper(mon, dest, NO_TRANSITION)


def do_dislike(config: WayperConfig, monitor: str | None = None) -> None:
    """Blacklist current wallpaper and show a random replacement."""
    mon, mon_cfg, img = _resolve_context(config, monitor)
    if not img or not mon_cfg:
        return
    if "favorites" in str(img):
        return
    mode = read_mode(config)
    next_img = pick_random(config, mode, mon_cfg.orientation)
    if next_img:
        set_wallpaper(mon, next_img, config.transition)
        push_history(config, mon, next_img)
    add_to_blacklist(config, img.name)
    push_undo(config, img.name, img.parent)


def do_undislike(config: WayperConfig, monitor: str | None = None) -> None:
    """Undo last dislike: restore from trash and remove from blacklist."""
    entry = pop_undo(config)
    if not entry:
        return
    filename, orig_dir = entry
    restored = restore_from_trash(config, filename, orig_dir)
    remove_from_blacklist(config, filename)
    if restored:
        target = monitor or get_focused_monitor()
        if target:
            set_wallpaper(target, restored, config.transition)


def do_open_wallhaven(current_path) -> None:
    """Open the Wallhaven page for the current wallpaper."""
    if current_path:
        webbrowser.open(wallhaven_url(current_path))
