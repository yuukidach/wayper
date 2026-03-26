"""CLI entry point."""

from __future__ import annotations

import asyncio
import json as json_mod
import logging
import signal
import sys
from pathlib import Path

import click

from .backend import (
    FileLock,
    get_context,
    get_focused_monitor,
    notify,
    query_current,
    set_wallpaper,
)
from .config import NO_TRANSITION, load_config
from .history import go_prev, pick_next
from .history import push as push_history
from .pool import (
    add_to_blacklist,
    count_images,
    favorites_dir,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from .state import pop_undo, push_undo, read_mode, restore_from_trash, write_mode


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
    monitor, mon_cfg, _ = get_context(config)
    if not mon_cfg:
        click.echo("No monitor config found", err=True)
        raise SystemExit(1)

    img = pick_next(config, monitor, mon_cfg.orientation)
    if img:
        set_wallpaper(monitor, img, config.transition)
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "next", "monitor": monitor, "image": str(img)}))
        else:
            notify("Wallpaper", "Next wallpaper")


@cli.command("prev")
@click.pass_context
def prev_cmd(ctx):
    """Go back to the previous wallpaper."""
    config = ctx.obj["config"]
    monitor, mon_cfg, _ = get_context(config)
    if not mon_cfg:
        click.echo("No monitor config found", err=True)
        raise SystemExit(1)

    img = go_prev(config, monitor)
    if img:
        set_wallpaper(monitor, img, config.transition)
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "prev", "monitor": monitor, "image": str(img)}))
        else:
            notify("Wallpaper", "Previous wallpaper")
    else:
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "prev", "status": "at_oldest"}))
        else:
            notify("Wallpaper", "Already at oldest")


@cli.command()
@click.option("--open", "open_url", is_flag=True, help="Open on Wallhaven.")
@click.pass_context
def fav(ctx, open_url):
    """Favorite the current wallpaper."""
    config = ctx.obj["config"]
    with FileLock(blocking=False):
        monitor, mon_cfg, img = get_context(config)
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
        set_wallpaper(monitor, dest, NO_TRANSITION)

        if open_url:
            import webbrowser

            from .browse._common import wallhaven_url

            webbrowser.open(wallhaven_url(img))

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
    with FileLock(blocking=False):
        monitor, mon_cfg, img = get_context(config)
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
        set_wallpaper(monitor, dest, NO_TRANSITION)

        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"action": "unfav", "image": str(dest)}))
        else:
            notify("Wallpaper", "Removed from favorites")


@cli.command()
@click.pass_context
def dislike(ctx):
    """Blacklist current wallpaper and switch to a new one."""
    config = ctx.obj["config"]
    with FileLock(blocking=False):
        monitor, mon_cfg, img = get_context(config)
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
            push_history(config, monitor, next_img)

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
    with FileLock(blocking=False):
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

    from .daemon import signal_daemon

    signal_daemon(config, signal.SIGUSR2)

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
        monitors_info.append(
            {
                "name": mon.name,
                "orientation": mon.orientation,
                "image": str(img) if img else None,
                "pool_count": pc,
                "favorites_count": fc,
            }
        )

    from .daemon import is_daemon_running
    from .pool import disk_usage_mb

    disk_mb = disk_usage_mb(config)
    daemon_running, _ = is_daemon_running(config)

    if ctx.obj["json"]:
        click.echo(
            json_mod.dumps(
                {
                    "mode": current_mode,
                    "daemon": daemon_running,
                    "disk_mb": round(disk_mb, 1),
                    "quota_mb": config.quota_mb,
                    "monitors": monitors_info,
                },
                indent=2,
            )
        )
    else:
        click.echo(f"Mode: {current_mode}")
        click.echo(f"Daemon: {'running' if daemon_running else 'stopped'}")
        click.echo(f"Disk: {disk_mb:.0f} MB / {config.quota_mb} MB")
        for m in monitors_info:
            click.echo(f"  {m['name']} ({m['orientation']}): {m['image'] or 'none'}")
            click.echo(f"    Pool: {m['pool_count']}, Favorites: {m['favorites_count']}")


@cli.command()
def setup():
    """Install .app bundle (macOS) or .desktop entry (Linux)."""
    import shutil

    if sys.platform == "darwin":
        _setup_macos_app()
    else:
        gui_bin = shutil.which("wayper-gui") or str(Path(sys.executable).parent / "wayper-gui")
        desktop = Path.home() / ".local/share/applications/wayper.desktop"
        desktop.parent.mkdir(parents=True, exist_ok=True)
        desktop.write_text(
            "[Desktop Entry]\n"
            "Name=Wayper\n"
            f"Exec={gui_bin}\n"
            "Icon=preferences-desktop-wallpaper\n"
            "Type=Application\n"
            "Categories=Utility;\n"
        )
        click.echo(f"Installed {desktop}")


def _setup_macos_app() -> None:
    import shutil

    gui_bin = shutil.which("wayper-gui") or str(Path(sys.executable).parent / "wayper-gui")
    app_dir = Path.home() / "Applications" / "Wayper.app"
    contents = app_dir / "Contents"
    macos_dir = contents / "MacOS"
    resources = contents / "Resources"

    macos_dir.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)

    # Launcher script
    launcher = macos_dir / "Wayper"
    launcher.write_text(f'#!/bin/bash\nexec "{gui_bin}"\n')
    launcher.chmod(0o755)

    # Info.plist
    (contents / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
        ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n<dict>\n'
        "  <key>CFBundleName</key><string>Wayper</string>\n"
        "  <key>CFBundleDisplayName</key><string>Wayper</string>\n"
        "  <key>CFBundleIdentifier</key>"
        "<string>io.github.yuukidach.wayper</string>\n"
        "  <key>CFBundleVersion</key><string>1.0</string>\n"
        "  <key>CFBundleExecutable</key><string>Wayper</string>\n"
        "  <key>CFBundleIconFile</key><string>icon</string>\n"
        "  <key>CFBundlePackageType</key><string>APPL</string>\n"
        "  <key>NSHighResolutionCapable</key><true/>\n"
        "</dict>\n</plist>\n"
    )

    # Copy icon if available
    icon_src = Path(__file__).parent.parent / "assets" / "icon.icns"
    if icon_src.exists():
        shutil.copy2(icon_src, resources / "icon.icns")

    click.echo(f"Installed {app_dir}")
