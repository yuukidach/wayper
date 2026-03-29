"""CLI entry point."""

from __future__ import annotations

import asyncio
import json as json_mod
import logging
import signal
import subprocess
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
    should_download,
)
from .state import (
    ALL_PURITIES,
    pop_undo,
    purity_from_path,
    push_undo,
    read_mode,
    restore_from_trash,
    toggle_base,
    toggle_purity,
    write_mode,
)


@click.group()
@click.option("--json", "use_json", is_flag=True, help="Output in JSON format.")
@click.option("--config", "config_path", type=click.Path(exists=True), default=None)
@click.pass_context
def cli(ctx, use_json, config_path):
    """Wayper - Wayland wallpaper manager."""
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_config(Path(config_path) if config_path else None)
    ctx.obj["json"] = use_json


@cli.group(invoke_without_command=True)
@click.pass_context
def daemon(ctx):
    """Run the wallpaper daemon (download loop + rotation).

    Bare 'wayper daemon' runs in foreground.
    'wayper daemon start' runs in background.
    'wayper daemon stop' stops the background daemon.
    """
    if ctx.invoked_subcommand is None:
        config = ctx.obj["config"]
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%H:%M:%S",
        )
        from .daemon import run_daemon

        asyncio.run(run_daemon(config))


@daemon.command()
@click.pass_context
def start(ctx):
    """Start the daemon in the background."""
    config = ctx.obj["config"]
    from .daemon import is_daemon_running

    running, pid = is_daemon_running(config)
    if running:
        click.echo(f"Daemon already running (PID {pid})")
        return

    if config.pid_file.exists():
        try:
            config.pid_file.unlink()
            click.echo("Removed stale PID file.")
        except OSError as e:
            click.echo(f"Warning: Could not remove stale PID file: {e}", err=True)

    # Spawn the bare 'daemon' command detached
    # We use Popen with start_new_session=True to detach fully
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "daemon"]
    else:
        cmd = [sys.executable, "-m", "wayper.cli", "daemon"]

    with open("/tmp/wayper-daemon.log", "w") as f:
        subprocess.Popen(cmd, start_new_session=True, stdout=f, stderr=f, stdin=subprocess.DEVNULL)
    click.echo("Daemon started in background.")


@daemon.command()
@click.pass_context
def stop(ctx):
    """Stop the background daemon."""
    config = ctx.obj["config"]
    from .daemon import is_daemon_running

    running, pid = is_daemon_running(config)
    if not running:
        click.echo("Daemon is not running")
        return

    if pid:
        try:
            import os

            os.kill(pid, signal.SIGTERM)
            click.echo(f"Stopped daemon (PID {pid})")
        except ProcessLookupError:
            click.echo("Daemon process not found (stale PID file?)")
            # Cleanup stale pid file?
            # The next run will overwrite it, or is_daemon_running handles it.
            # remove_pid_file is in daemon.py, not easily accessible here without import.
            pass


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

    # Trigger download with same probability as daemon
    purities = read_mode(config)
    download_map = should_download(config, purities)
    to_download = [p for p, needs in download_map.items() if needs]
    if to_download:
        from .wallhaven import WallhavenClient

        async def _download():
            client = WallhavenClient(config)
            try:
                tasks = []
                for purity in to_download:
                    tasks.append(client.download_for("landscape", purity))
                    tasks.append(client.download_for("portrait", purity))
                await asyncio.gather(*tasks)
            finally:
                await client.close()

        asyncio.run(_download())


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

        purity = purity_from_path(config, img)
        dest_dir = favorites_dir(config, purity, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        # Re-set wallpaper with no transition so it doesn't flash
        set_wallpaper(monitor, dest, NO_TRANSITION)

        if open_url:
            import webbrowser

            from .wallhaven import wallhaven_url

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

        purity = purity_from_path(config, img)
        dest_dir = pool_dir(config, purity, mon_cfg.orientation)
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
        purities = read_mode(config)
        next_img = pick_random(config, purities, mon_cfg.orientation)
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
@click.argument("new_mode", required=False)
@click.pass_context
def mode(ctx, new_mode):
    """Show or switch purity mode.

    No argument toggles sfw/nsfw. 'sketchy' toggles sketchy on/off.
    Comma-separated values set exact combination (e.g. sfw,sketchy).
    """
    config = ctx.obj["config"]
    current = read_mode(config)

    if new_mode is None:
        result = toggle_base(current)
    elif new_mode == "sketchy":
        result = toggle_purity(current, "sketchy")
    elif "," in new_mode:
        result = {p.strip() for p in new_mode.split(",") if p.strip() in ALL_PURITIES}
        if not result:
            click.echo("Invalid mode. Use: sfw, sketchy, nsfw", err=True)
            raise SystemExit(1)
    elif new_mode in ("sfw", "nsfw"):
        result = current.copy()
        result.discard("sfw")
        result.discard("nsfw")
        result.add(new_mode)
        if not result:
            result.add(new_mode)
    else:
        click.echo(f"Unknown mode: {new_mode}. Use: sfw, sketchy, nsfw", err=True)
        raise SystemExit(1)

    write_mode(config, result)

    from .daemon import signal_daemon

    signal_daemon(config, signal.SIGUSR2)

    label = ", ".join(p for p in ALL_PURITIES if p in result)
    if ctx.obj["json"]:
        click.echo(json_mod.dumps({"action": "mode", "mode": sorted(result)}))
    else:
        notify("Wallpaper", f"Mode: {label}")


@cli.command()
@click.pass_context
def status(ctx):
    """Show current wallpapers, mode, and pool counts."""
    config = ctx.obj["config"]
    current_purities = read_mode(config)
    current = query_current()

    monitors_info = []
    for mon in config.monitors:
        img = current.get(mon.name)
        pc = sum(count_images(pool_dir(config, p, mon.orientation)) for p in current_purities)
        fc = sum(count_images(favorites_dir(config, p, mon.orientation)) for p in current_purities)
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
                    "mode": sorted(current_purities),
                    "daemon": daemon_running,
                    "disk_mb": round(disk_mb, 1),
                    "quota_mb": config.quota_mb,
                    "monitors": monitors_info,
                },
                indent=2,
            )
        )
    else:
        mode_label = ", ".join(p for p in ALL_PURITIES if p in current_purities)
        click.echo(f"Mode: {mode_label}")
        click.echo(f"Daemon: {'running' if daemon_running else 'stopped'}")
        click.echo(f"Disk: {disk_mb:.0f} MB / {config.quota_mb} MB")
        for m in monitors_info:
            click.echo(f"  {m['name']} ({m['orientation']}): {m['image'] or 'none'}")
            click.echo(f"    Pool: {m['pool_count']}, Favorites: {m['favorites_count']}")


@cli.command()
def setup():
    """Install .desktop entry (Linux)."""
    import shutil

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


if __name__ == "__main__":
    cli()
