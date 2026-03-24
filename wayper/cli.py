"""CLI entry point."""

from __future__ import annotations

import asyncio
import json as json_mod
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

import click

from .backend import find_monitor, get_focused_monitor, query_current, set_wallpaper
from .config import TransitionConfig, load_config
from .notify import notify
from .pool import (
    add_to_blacklist,
    count_images,
    ensure_directories,
    favorites_dir,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from .state import pop_undo, push_undo, read_mode, restore_from_trash, write_mode


def _lock_path() -> Path:
    return Path("/tmp/wayper.lock")


class _FileLock:
    """Simple flock-based file lock for state-modifying commands."""

    def __init__(self) -> None:
        self._fd: int | None = None

    def __enter__(self) -> "_FileLock":
        import fcntl
        self._fd = os.open(str(_lock_path()), os.O_WRONLY | os.O_CREAT)
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self._fd)
            self._fd = None
            raise SystemExit(0)
        return self

    def __exit__(self, *_: object) -> None:
        if self._fd is not None:
            os.close(self._fd)


def _get_context(config):
    """Get focused monitor, its config, and current image."""
    monitor = get_focused_monitor()
    mon_cfg = find_monitor(config, monitor)
    current = query_current()
    img = current.get(monitor) if monitor else None
    return monitor, mon_cfg, img


@click.group()
@click.option("--json", "use_json", is_flag=True, help="Output in JSON format.")
@click.option("--config", "config_path", type=click.Path(exists=True), default=None)
@click.pass_context
def cli(ctx, use_json, config_path):
    """Wayper - Wayland wallpaper manager."""
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_config(Path(config_path) if config_path else None)
    ctx.obj["json"] = use_json


@cli.command()
@click.pass_context
def daemon(ctx):
    """Run the wallpaper daemon (download loop + rotation)."""
    config = ctx.obj["config"]
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    from .daemon import run_daemon
    asyncio.run(run_daemon(config))


@cli.command("next")
@click.pass_context
def next_cmd(ctx):
    """Change wallpaper on the focused monitor."""
    config = ctx.obj["config"]
    monitor, mon_cfg, _ = _get_context(config)
    if not mon_cfg:
        click.echo("No monitor config found", err=True)
        raise SystemExit(1)

    mode = read_mode(config)
    img = pick_random(config, mode, mon_cfg.orientation)
    if img:
        set_wallpaper(monitor, img, config.transition)
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "next", "monitor": monitor, "image": str(img)}))
        else:
            notify("Wallpaper", "Next wallpaper")


@cli.command()
@click.option("--open", "open_url", is_flag=True, help="Open on Wallhaven.")
@click.pass_context
def fav(ctx, open_url):
    """Favorite the current wallpaper."""
    config = ctx.obj["config"]
    with _FileLock():
        monitor, mon_cfg, img = _get_context(config)
        if not img or not mon_cfg:
            click.echo("No current wallpaper", err=True)
            raise SystemExit(1)

        if "favorites" in str(img):
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "fav", "status": "already_favorite"}))
            else:
                notify("Wallpaper", "Already in favorites")
            return

        mode = read_mode(config)
        dest_dir = favorites_dir(config, mode, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        # Re-set wallpaper with no transition so it doesn't flash
        set_wallpaper(monitor, dest, TransitionConfig(type="none", duration=0, fps=60))

        if open_url:
            wall_id = img.stem.replace("wallhaven-", "")
            subprocess.Popen(
                ["xdg-open", f"https://wallhaven.cc/w/{wall_id}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )

        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "fav", "image": str(dest), "opened": open_url}))
        else:
            msg = "Saved & opened on Wallhaven" if open_url else "Saved to favorites"
            notify("Wallpaper", msg)


@cli.command()
@click.pass_context
def unfav(ctx):
    """Remove current wallpaper from favorites."""
    config = ctx.obj["config"]
    with _FileLock():
        monitor, mon_cfg, img = _get_context(config)
        if not img or not mon_cfg:
            click.echo("No current wallpaper", err=True)
            raise SystemExit(1)

        if "favorites" not in str(img):
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "unfav", "status": "not_favorite"}))
            else:
                notify("Wallpaper", "Not a favorite")
            return

        mode = read_mode(config)
        dest_dir = pool_dir(config, mode, mon_cfg.orientation)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, TransitionConfig(type="none", duration=0, fps=60))

        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "unfav", "image": str(dest)}))
        else:
            notify("Wallpaper", "Removed from favorites")


@cli.command()
@click.pass_context
def dislike(ctx):
    """Blacklist current wallpaper and switch to a new one."""
    config = ctx.obj["config"]
    with _FileLock():
        monitor, mon_cfg, img = _get_context(config)
        if not img or not mon_cfg:
            click.echo("No current wallpaper", err=True)
            raise SystemExit(1)

        if "favorites" in str(img):
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "dislike", "status": "is_favorite"}))
            else:
                notify("Wallpaper", "Can't dislike a favorite")
            return

        # Switch wallpaper first for instant feedback
        mode = read_mode(config)
        next_img = pick_random(config, mode, mon_cfg.orientation)
        if next_img:
            set_wallpaper(monitor, next_img, config.transition)

        # Bookkeeping
        add_to_blacklist(config, img.name)
        push_undo(config, img.name, img.parent)

        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "dislike", "image": str(img)}))
        else:
            notify("Wallpaper", "Disliked")


@cli.command()
@click.pass_context
def undislike(ctx):
    """Undo the last dislike."""
    config = ctx.obj["config"]
    with _FileLock():
        entry = pop_undo(config)
        if not entry:
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "undislike", "status": "nothing_to_undo"}))
            else:
                notify("Wallpaper", "Nothing to undo")
            return

        filename, orig_dir = entry
        restored = restore_from_trash(config, filename, orig_dir)
        remove_from_blacklist(config, filename)

        if restored:
            monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, config.transition)
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "undislike", "image": str(restored)}))
            else:
                notify("Wallpaper", f"Restored: {filename}")
        else:
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"action": "undislike", "status": "file_missing"}))
            else:
                notify("Wallpaper", "Can't restore (file missing)")


@cli.command()
@click.argument("new_mode", required=False, type=click.Choice(["sfw", "nsfw"]))
@click.pass_context
def mode(ctx, new_mode):
    """Show or switch SFW/NSFW mode."""
    config = ctx.obj["config"]
    current = read_mode(config)

    if new_mode is None:
        # Toggle
        new_mode = "sfw" if current == "nsfw" else "nsfw"

    write_mode(config, new_mode)

    # Signal daemon if running
    if config.pid_file.exists():
        try:
            pid = int(config.pid_file.read_text().strip())
            os.kill(pid, signal.SIGUSR2)
        except (ValueError, ProcessLookupError, OSError):
            pass

    if ctx.obj["json"]:
        click.echo(json_mod.dumps({"action": "mode", "mode": new_mode}))
    else:
        notify("Wallpaper", f"Mode: {new_mode}")


@cli.command()
@click.pass_context
def status(ctx):
    """Show current wallpapers, mode, and pool counts."""
    config = ctx.obj["config"]
    current_mode = read_mode(config)
    current = query_current()

    monitors_info = []
    for mon in config.monitors:
        img = current.get(mon.name)
        pc = count_images(pool_dir(config, current_mode, mon.orientation))
        fc = count_images(favorites_dir(config, current_mode, mon.orientation))
        monitors_info.append({
            "name": mon.name,
            "orientation": mon.orientation,
            "image": str(img) if img else None,
            "pool_count": pc,
            "favorites_count": fc,
        })

    # Disk usage
    total_bytes = sum(
        f.stat().st_size
        for f in config.download_dir.rglob("*")
        if f.is_file()
    ) if config.download_dir.exists() else 0
    disk_mb = total_bytes / 1024 / 1024

    # Daemon status
    daemon_running = False
    if config.pid_file.exists():
        try:
            pid = int(config.pid_file.read_text().strip())
            os.kill(pid, 0)
            daemon_running = True
        except (ValueError, ProcessLookupError, OSError):
            pass

    if ctx.obj["json"]:
        click.echo(json_mod.dumps({
            "mode": current_mode,
            "daemon": daemon_running,
            "disk_mb": round(disk_mb, 1),
            "quota_mb": config.quota_mb,
            "monitors": monitors_info,
        }, indent=2))
    else:
        click.echo(f"Mode: {current_mode}")
        click.echo(f"Daemon: {'running' if daemon_running else 'stopped'}")
        click.echo(f"Disk: {disk_mb:.0f} MB / {config.quota_mb} MB")
        for m in monitors_info:
            click.echo(f"  {m['name']} ({m['orientation']}): {m['image'] or 'none'}")
            click.echo(f"    Pool: {m['pool_count']}, Favorites: {m['favorites_count']}")
