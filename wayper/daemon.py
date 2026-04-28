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
from .config import WayperConfig, load_config
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
from .util import atomic_write
from .wallhaven import WallhavenClient

log = logging.getLogger("wayper")

FAV_SYNC_INTERVAL = 12  # sync remote favorites every ~12 rotation cycles

_change_now = False
_reload_mode = False
_wake: asyncio.Event | None = None


def _on_usr1(*_: object) -> None:
    global _change_now
    _change_now = True
    if _wake:
        _wake.set()


def _on_usr2(*_: object) -> None:
    global _reload_mode
    _reload_mode = True
    if _wake:
        _wake.set()


_reload_config = False


def _on_hup(*_: object) -> None:
    global _reload_config
    _reload_config = True
    if _wake:
        _wake.set()


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
        # Reap zombie if daemon was our child (started by API server)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass  # not our child — started by CLI or another process
        os.kill(pid, 0)
        return True, pid
    except (ValueError, ProcessLookupError, OSError):
        return False, None


def compute_daemon_state(config: WayperConfig) -> tuple[bool, set[str], int, int, int]:
    """Compute daemon state tuple: (running, purities, pool_count, fav_count, disk_mb_rounded)."""
    running, _ = is_daemon_running(config)
    purities = read_mode(config)
    pool_count = 0
    fav_count = 0
    for purity in purities:
        for o in ("landscape", "portrait"):
            pool_count += count_images(pool_dir(config, purity, o))
            fav_count += count_images(favorites_dir(config, purity, o))
    disk_mb = disk_usage_mb(config)
    return running, purities, pool_count, fav_count, round(disk_mb)


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


def set_all_wallpapers(config: WayperConfig, purities: set[str]) -> None:
    """Set wallpaper on all configured monitors."""
    history_items: list[tuple[str, Path]] = []
    for mon in config.monitors:
        img = pick_random(config, purities, mon.orientation)
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


async def _do_downloads(client: WallhavenClient, config: WayperConfig, purities: set[str]) -> None:
    """Run pending downloads in the background. Logs any errors."""
    try:
        download_map = should_download(config, purities)
        tasks = []
        orientations = {m.orientation for m in config.monitors}
        for purity, needs in download_map.items():
            if needs:
                for o in orientations:
                    tasks.append(client.download_for(o, purity))
        if tasks:
            await asyncio.gather(*tasks)
    except Exception as e:
        log.warning("Background download failed: %s", e)


async def _do_fav_sync(client: WallhavenClient, config: WayperConfig) -> None:
    """Sync remote favorites and push local ones. Logs any errors."""
    try:
        _, remote_files = await client.sync_remote_favorites()
        from .wallhaven_web import push_local_favorites

        await asyncio.to_thread(push_local_favorites, config, remote_files)
    except Exception as e:
        log.warning("Background favorites sync failed: %s", e)


async def _do_greeter(config: WayperConfig) -> None:
    """Update greeter wallpaper in a thread. Logs any errors."""
    try:
        await asyncio.to_thread(update_greeter, config)
    except Exception as e:
        log.warning("Background greeter update failed: %s", e)


async def run_daemon(config: WayperConfig) -> None:
    global _change_now, _reload_mode, _reload_config, _wake

    from .logging import setup_logging

    setup_logging()
    ensure_directories(config)
    ensure_ready()
    write_pid_file(config)

    _wake = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGUSR1, _on_usr1)
    loop.add_signal_handler(signal.SIGUSR2, _on_usr2)
    loop.add_signal_handler(signal.SIGHUP, _on_hup)

    log.info("Daemon started (PID %d)", os.getpid())

    client = WallhavenClient(config)
    await asyncio.to_thread(client.refresh_cloud_tags)
    from .wallhaven_web import merge_cloud_blacklists_into_config

    await asyncio.to_thread(merge_cloud_blacklists_into_config, config)
    greeter_count = 0
    fav_sync_count = FAV_SYNC_INTERVAL  # trigger sync on first cycle

    async def reload_config_if_needed() -> None:
        """Reload config and replace client if SIGHUP was received."""
        global _reload_config
        nonlocal config, client, fav_sync_count
        if not _reload_config:
            return
        _reload_config = False
        config = load_config()
        old, client = client, WallhavenClient(config)
        await asyncio.to_thread(client.refresh_cloud_tags)
        await asyncio.to_thread(merge_cloud_blacklists_into_config, config)
        await old.close()
        fav_sync_count = FAV_SYNC_INTERVAL  # trigger sync on next cycle
        log.info("Configuration reloaded")

    download_task: asyncio.Task | None = None
    sync_task: asyncio.Task | None = None
    greeter_task: asyncio.Task | None = None

    try:
        while True:
            _change_now = False
            await reload_config_if_needed()

            if _reload_mode:
                _reload_mode = False

            # Check lock state at start of cycle
            if config.pause_on_lock and is_locked():
                log.info("Session locked, waiting before rotation")
                while config.pause_on_lock and is_locked():
                    if _change_now or _reload_mode:
                        break
                    if _reload_config:
                        await reload_config_if_needed()
                    _wake.clear()
                    try:
                        await asyncio.wait_for(_wake.wait(), timeout=5)
                    except TimeoutError:
                        pass

                if _change_now or _reload_mode:
                    continue

            cycle_start = time.monotonic()
            purities = read_mode(config)

            # Set wallpapers immediately — fast, must not block on slow tasks
            set_all_wallpapers(config, purities)
            atomic_write(config.download_dir / ".last_rotation", str(time.time()))

            # Spawn downloads in background; skip if previous still running
            if download_task is None or download_task.done():
                download_task = asyncio.create_task(_do_downloads(client, config, purities))
            else:
                log.info("skip downloads: previous task still running")

            # Quick local-only maintenance — safe to run inline
            enforce_quota(config)
            prune_blacklist(config)

            # Spawn favorites sync in background; skip if previous still running.
            # Reset counter even on skip so we wait a full interval before retrying
            # instead of re-checking every cycle.
            fav_sync_count += 1
            if fav_sync_count >= FAV_SYNC_INTERVAL:
                if sync_task is None or sync_task.done():
                    sync_task = asyncio.create_task(_do_fav_sync(client, config))
                else:
                    log.info("skip fav sync: previous task still running")
                fav_sync_count = 0

            # Spawn greeter update in background; skip if previous still running.
            # Reset counter even on skip (same reason as fav sync above).
            greeter_count += 1
            if greeter_count >= config.greeter.interval:
                if greeter_task is None or greeter_task.done():
                    greeter_task = asyncio.create_task(_do_greeter(config))
                else:
                    log.info("skip greeter update: previous task still running")
                greeter_count = 0

            # Deadline-based sleep — accounts for time already spent in this cycle
            if config.interval <= 0:
                # No auto-rotation: wait indefinitely for a signal
                log.info("Auto-rotation disabled (interval=0), waiting for signal")
                while not _change_now and not _reload_mode:
                    await reload_config_if_needed()
                    _wake.clear()
                    try:
                        await asyncio.wait_for(_wake.wait(), timeout=5)
                    except TimeoutError:
                        pass
            else:
                deadline = cycle_start + config.interval
                while True:
                    if _change_now or _reload_mode:
                        break
                    await reload_config_if_needed()

                    # Pause if locked — extend deadline by the locked duration
                    if config.pause_on_lock and is_locked():
                        log.info("Session locked, pausing timer")
                        lock_start = time.monotonic()
                        while config.pause_on_lock and is_locked():
                            if _change_now or _reload_mode:
                                break
                            if _reload_config:
                                await reload_config_if_needed()
                            _wake.clear()
                            try:
                                await asyncio.wait_for(_wake.wait(), timeout=5)
                            except TimeoutError:
                                pass
                        deadline += time.monotonic() - lock_start
                        log.info("Session unlocked, resuming timer")

                        if _change_now or _reload_mode:
                            break

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break

                    _wake.clear()
                    try:
                        await asyncio.wait_for(_wake.wait(), timeout=min(1.0, remaining))
                    except TimeoutError:
                        pass
    except (KeyboardInterrupt, SystemExit):
        log.info("Daemon shutting down")
    finally:
        for t in (download_task, sync_task, greeter_task):
            if t is not None and not t.done():
                t.cancel()
        await client.close()
        remove_pid_file(config)
