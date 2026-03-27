"""Daemon: main loop with signal handling, PID file, greeter updates."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import time
from pathlib import Path

from .backend import ensure_ready, is_locked, set_wallpaper
from .config import WayperConfig
from .history import push_many
from .pool import (
    count_images,
    disk_usage_mb,
    enforce_quota,
    ensure_directories,
    favorites_dir,
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


def is_daemon_running(config: WayperConfig) -> tuple[bool, int | None]:
    """Check if daemon is alive. Returns (running, pid)."""
    if not config.pid_file.exists():
        return False, None
    try:
        pid = int(config.pid_file.read_text().strip())
        os.kill(pid, 0)
        return True, pid
    except (ValueError, ProcessLookupError, OSError):
        return False, None


def compute_daemon_state(config: WayperConfig) -> tuple[bool, str, int, int, int]:
    """Compute daemon state tuple: (running, mode, pool_count, fav_count, disk_mb_rounded)."""
    running, _ = is_daemon_running(config)
    mode = read_mode(config)
    pool_count = sum(count_images(pool_dir(config, mode, o)) for o in ("landscape", "portrait"))
    fav_count = sum(count_images(favorites_dir(config, mode, o)) for o in ("landscape", "portrait"))
    disk_mb = disk_usage_mb(config)
    return running, mode, pool_count, fav_count, round(disk_mb)


def signal_daemon(config: WayperConfig, sig: int) -> bool:
    """Send a signal to the running daemon. Returns True if sent."""
    running, pid = is_daemon_running(config)
    if running and pid:
        os.kill(pid, sig)
        return True
    return False


def read_last_rotation(config: WayperConfig) -> float | None:
    """Read the timestamp of the last wallpaper rotation. Returns None if missing/invalid."""
    path = config.download_dir / ".last_rotation"
    try:
        return float(path.read_text().strip())
    except (FileNotFoundError, ValueError, OSError):
        return None


def set_all_wallpapers(config: WayperConfig, mode: str) -> None:
    """Set wallpaper on all configured monitors."""
    history_items: list[tuple[str, Path]] = []
    for mon in config.monitors:
        img = pick_random(config, mode, mon.orientation)
        if img:
            set_wallpaper(mon.name, img, config.transition)
            history_items.append((mon.name, img))
    push_many(config, history_items)


def update_greeter(config: WayperConfig) -> None:
    """Update greeter wallpaper from SFW landscape pool."""
    if not config.greeter.image:
        return

    import random

    from .pool import list_images

    sfw_landscape = pool_dir(config, "sfw", "landscape")
    images = list_images(sfw_landscape)
    if not images:
        return

    img = random.choice(images)
    try:
        cmd = ["sudo", "-S", "cp", str(img), str(config.greeter.image)]
        pwd = config.greeter.sudo_password
        if pwd:
            subprocess.run(
                cmd,
                input=pwd.encode(),
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


async def run_daemon(config: WayperConfig) -> None:
    global _change_now, _reload_mode

    ensure_directories(config)
    ensure_ready()
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

            # Check lock state at start of cycle
            if config.pause_on_lock and is_locked():
                log.info("Session locked, waiting before rotation")
                while config.pause_on_lock and is_locked():
                    if _change_now or _reload_mode:
                        break
                    await asyncio.sleep(5)

                if _change_now or _reload_mode:
                    continue

            mode = read_mode(config)

            # Set wallpapers immediately
            set_all_wallpapers(config, mode)
            (config.download_dir / ".last_rotation").write_text(str(time.time()))

            # Download if needed
            if should_download(config, mode):
                orientations = {m.orientation for m in config.monitors}
                await asyncio.gather(
                    *(client.download_for(o, mode) for o in orientations)
                )

            enforce_quota(config)
            prune_blacklist(config)

            # Greeter update
            greeter_count += 1
            if greeter_count >= config.greeter.interval:
                update_greeter(config)
                greeter_count = 0

            # Interruptible sleep
            remaining = config.interval
            while remaining > 0:
                if _change_now or _reload_mode:
                    break

                # Pause if locked
                if config.pause_on_lock and is_locked():
                    log.info("Session locked, pausing timer")
                    while config.pause_on_lock and is_locked():
                        if _change_now or _reload_mode:
                            break
                        await asyncio.sleep(5)
                    log.info("Session unlocked, resuming timer")

                    if _change_now or _reload_mode:
                        break

                await asyncio.sleep(1)
                remaining -= 1
    except (KeyboardInterrupt, SystemExit):
        log.info("Daemon shutting down")
    finally:
        await client.close()
        remove_pid_file(config)
