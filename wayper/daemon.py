"""Daemon: main loop with signal handling, PID file, greeter updates."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess

from .config import WayperConfig
from .backend import set_wallpaper
from .pool import (
    count_images,
    enforce_quota,
    ensure_directories,
    pick_random,
    pool_dir,
    prune_blacklist,
    should_download,
)
from .state import read_mode
from .wallhaven import WallhavenClient

log = logging.getLogger("wayper")

_change_now = False
_reload_mode = False


def _on_usr1(*_: object) -> None:
    global _change_now
    _change_now = True


def _on_usr2(*_: object) -> None:
    global _reload_mode
    _reload_mode = True


def write_pid_file(config: WayperConfig) -> None:
    config.pid_file.parent.mkdir(parents=True, exist_ok=True)
    config.pid_file.write_text(str(os.getpid()))


def remove_pid_file(config: WayperConfig) -> None:
    config.pid_file.unlink(missing_ok=True)


def set_all_wallpapers(config: WayperConfig, mode: str) -> None:
    """Set wallpaper on all configured monitors."""
    for mon in config.monitors:
        img = pick_random(config, mode, mon.orientation)
        if img:
            set_wallpaper(mon.name, img, config.transition)


def update_greeter(config: WayperConfig) -> None:
    """Update greeter wallpaper from SFW landscape pool."""
    if not config.greeter.image:
        return

    from .pool import list_images
    import random

    sfw_landscape = pool_dir(config, "sfw", "landscape")
    images = list_images(sfw_landscape)
    if not images:
        return

    img = random.choice(images)
    try:
        cmd = ["sudo", "-S", "cp", str(img), str(config.greeter.image)]
        pwd = config.greeter.sudo_password
        if pwd:
            subprocess.run(cmd, input=pwd.encode(), check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.run(cmd, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


async def run_daemon(config: WayperConfig) -> None:
    global _change_now, _reload_mode

    ensure_directories(config)
    write_pid_file(config)

    signal.signal(signal.SIGUSR1, _on_usr1)
    signal.signal(signal.SIGUSR2, _on_usr2)

    log.info("Daemon started (PID %d)", os.getpid())

    client = WallhavenClient(config)
    greeter_count = 0

    try:
        while True:
            _change_now = False

            if _reload_mode:
                _reload_mode = False

            mode = read_mode(config)

            # Set wallpapers immediately
            set_all_wallpapers(config, mode)

            # Download if needed
            if should_download(config, mode):
                await asyncio.gather(
                    client.download_for("landscape", mode),
                    client.download_for("portrait", mode),
                )

            enforce_quota(config)
            prune_blacklist(config)

            # Greeter update
            greeter_count += 1
            if greeter_count >= config.greeter.interval:
                update_greeter(config)
                greeter_count = 0

            # Interruptible sleep
            for _ in range(config.interval):
                if _change_now or _reload_mode:
                    break
                await asyncio.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        log.info("Daemon shutting down")
    finally:
        await client.close()
        remove_pid_file(config)
