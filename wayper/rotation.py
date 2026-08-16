"""Automatic wallpaper rotation owned by the desktop application."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from .backend import ensure_ready, is_locked, set_wallpaper
from .config import CONFIG_FILE, WayperConfig, load_config
from .history import push_many
from .lock import FileLock
from .pool import (
    enforce_quota,
    ensure_directories,
    pick_random,
    pool_dir,
    prune_blacklist,
    should_download,
)
from .state import read_last_wallpaper_change, read_mode, record_wallpaper_change
from .wallhaven import WallhavenClient

log = logging.getLogger("wayper.rotation")

FAVORITES_SYNC_INTERVAL = 12
ROTATION_POLL_INTERVAL = 0.1 if os.name == "nt" else 1.0
LOCK_POLL_INTERVAL = 0.5 if os.name == "nt" else 5.0


def _file_mtime(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def seconds_until_next_rotation(config: WayperConfig, now: float | None = None) -> float:
    """Return seconds left before the next automatic rotation is due."""
    if config.interval <= 0:
        return 0.0
    last_rotation = read_last_wallpaper_change(config)
    if last_rotation is None:
        return 0.0
    elapsed = max(0.0, (time.time() if now is None else now) - last_rotation)
    return max(0.0, config.interval - elapsed)


def set_all_wallpapers(config: WayperConfig, purities: set[str]) -> None:
    """Set a wallpaper on every configured monitor."""
    with FileLock():
        history_items: list[tuple[str, Path]] = []
        for monitor in config.monitors:
            image = pick_random(config, purities, monitor.orientation)
            if image:
                set_wallpaper(monitor.name, image, config.transition)
                history_items.append((monitor.name, image))
        push_many(config, history_items)
        record_wallpaper_change(config)


def update_greeter(config: WayperConfig) -> None:
    """Update the configured greeter wallpaper from the SFW landscape pool."""
    if not config.greeter.image:
        return

    import random

    from .pool import list_images

    images = list_images(pool_dir(config, "sfw", "landscape"))
    if not images:
        return

    image = random.choice(images)
    try:
        command = ["sudo", "-S", "cp", str(image), str(config.greeter.image)]
        password = config.greeter.sudo_password
        if password:
            subprocess.run(
                command,
                input=password.encode(),
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.run(
                command,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception:
        log.debug("Could not update greeter wallpaper", exc_info=True)


async def _download_pending(
    client: WallhavenClient,
    config: WayperConfig,
    purities: set[str],
) -> None:
    try:
        download_map = should_download(config, purities)
        orientations = {monitor.orientation for monitor in config.monitors}
        tasks = [
            client.download_for(orientation, purity)
            for purity, needed in download_map.items()
            if needed
            for orientation in orientations
        ]
        if tasks:
            await asyncio.gather(*tasks)
    except Exception as exc:
        log.warning("Background download failed: %s", exc)


async def _sync_favorites(client: WallhavenClient, config: WayperConfig) -> None:
    try:
        _, remote_files = await client.sync_remote_favorites()
        from .wallhaven_web import push_local_favorites

        await asyncio.to_thread(push_local_favorites, config, remote_files)
    except Exception as exc:
        log.warning("Background favorites sync failed: %s", exc)


async def _update_greeter(config: WayperConfig) -> None:
    try:
        await asyncio.to_thread(update_greeter, config)
    except Exception as exc:
        log.warning("Background greeter update failed: %s", exc)


class AutoRotationService:
    """Run automatic rotation inside the GUI backend process.

    The service deliberately has no PID file or signal protocol. FastAPI owns its
    lifecycle, while file mtimes keep changes made by the standalone CLI visible.
    """

    def __init__(self, config_loader: Callable[[], WayperConfig] = load_config) -> None:
        self._config_loader = config_loader
        self._task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Queue[None] | None = None
        self._stopping = False
        self._paused = False
        self._reload_requested = False
        self._config_mtime = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def snapshot(self, config: WayperConfig) -> dict[str, bool]:
        return {
            "auto_rotation": self.running and not self._paused and config.interval > 0,
            "rotation_paused": self._paused,
        }

    async def start(self) -> None:
        if self.running:
            return
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="wayper-auto-rotation")

    async def stop(self) -> None:
        task = self._task
        if task is None:
            return
        self._stopping = True
        self._notify()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None
            self._loop = None
            self._wake = None

    def pause(self) -> None:
        self._paused = True
        self._notify()

    def resume(self) -> None:
        self._paused = False
        self._notify()

    def request_reload(self) -> None:
        self._reload_requested = True
        self._notify()

    def wake(self) -> None:
        self._notify()

    def _notify(self) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._enqueue_wake)

    def _enqueue_wake(self) -> None:
        if self._wake is None or self._wake.full():
            return
        self._wake.put_nowait(None)

    async def _sleep_or_wake(self, timeout: float) -> None:
        if self._wake is None:
            return
        try:
            await asyncio.wait_for(self._wake.get(), timeout=timeout)
        except TimeoutError:
            pass

    async def _prepare_client(self, config: WayperConfig) -> WallhavenClient:
        client = WallhavenClient(config)
        try:
            await asyncio.to_thread(client.refresh_cloud_tags)
            from .wallhaven_web import merge_cloud_blacklists_into_config

            await asyncio.to_thread(merge_cloud_blacklists_into_config, config)
        except Exception as exc:
            log.warning("Could not refresh Wallhaven account state: %s", exc)
        return client

    async def _reload_if_needed(
        self,
        config: WayperConfig,
        client: WallhavenClient,
    ) -> tuple[WayperConfig, WallhavenClient, bool]:
        config_mtime = _file_mtime(CONFIG_FILE)
        config_changed = self._reload_requested or config_mtime != self._config_mtime
        if not config_changed:
            return config, client, False

        self._reload_requested = False
        self._config_mtime = config_mtime
        new_config = await asyncio.to_thread(self._config_loader)
        await asyncio.to_thread(ensure_directories, new_config)
        new_client = await self._prepare_client(new_config)
        await client.close()
        log.info("Automatic rotation configuration reloaded")
        return new_config, new_client, True

    async def _wait_for_turn(
        self,
        config: WayperConfig,
        client: WallhavenClient,
    ) -> tuple[WayperConfig, WallhavenClient, bool]:
        logged_disabled = False
        did_reload = False
        while not self._stopping:
            config, client, reloaded = await self._reload_if_needed(config, client)
            if reloaded:
                logged_disabled = False
                did_reload = True

            if self._paused:
                await self._sleep_or_wake(LOCK_POLL_INTERVAL)
                continue

            if config.interval <= 0:
                if not logged_disabled:
                    log.info("Automatic rotation disabled (interval=0)")
                    logged_disabled = True
                await self._sleep_or_wake(LOCK_POLL_INTERVAL)
                continue

            remaining = seconds_until_next_rotation(config)
            if remaining <= 0:
                return config, client, did_reload

            await self._sleep_or_wake(min(ROTATION_POLL_INTERVAL, remaining))

        return config, client, False

    async def _run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Queue(maxsize=1)
        client: WallhavenClient | None = None
        favorites_sync_count = FAVORITES_SYNC_INTERVAL
        greeter_count = 0
        download_task: asyncio.Task[None] | None = None
        sync_task: asyncio.Task[None] | None = None
        greeter_task: asyncio.Task[None] | None = None

        try:
            config = await asyncio.to_thread(self._config_loader)
            await asyncio.to_thread(ensure_directories, config)
            await asyncio.to_thread(ensure_ready)
            self._config_mtime = _file_mtime(CONFIG_FILE)
            client = await self._prepare_client(config)
            log.info("Automatic rotation service started")

            while not self._stopping:
                config, client, reloaded = await self._wait_for_turn(config, client)
                if self._stopping:
                    break
                if reloaded:
                    favorites_sync_count = FAVORITES_SYNC_INTERVAL

                if config.pause_on_lock and await asyncio.to_thread(is_locked):
                    log.info("Session locked; automatic rotation is waiting")
                    while config.pause_on_lock and await asyncio.to_thread(is_locked):
                        config, client, _ = await self._reload_if_needed(config, client)
                        await self._sleep_or_wake(LOCK_POLL_INTERVAL)
                        if self._stopping:
                            break
                    continue

                purities = read_mode(config)
                await asyncio.to_thread(set_all_wallpapers, config, purities)

                if download_task is None or download_task.done():
                    download_task = asyncio.create_task(_download_pending(client, config, purities))
                else:
                    log.info("Skipping downloads because the previous batch is still running")

                await asyncio.to_thread(enforce_quota, config)
                await asyncio.to_thread(prune_blacklist, config)

                favorites_sync_count += 1
                if favorites_sync_count >= FAVORITES_SYNC_INTERVAL:
                    if sync_task is None or sync_task.done():
                        sync_task = asyncio.create_task(_sync_favorites(client, config))
                    else:
                        log.info("Skipping favorites sync because the previous sync is running")
                    favorites_sync_count = 0

                greeter_count += 1
                if greeter_count >= config.greeter.interval:
                    if greeter_task is None or greeter_task.done():
                        greeter_task = asyncio.create_task(_update_greeter(config))
                    else:
                        log.info("Skipping greeter update because the previous update is running")
                    greeter_count = 0
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Automatic rotation service stopped unexpectedly")
        finally:
            pending = [
                task
                for task in (download_task, sync_task, greeter_task)
                if task is not None and not task.done()
            ]
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if client is not None:
                await client.close()
            log.info("Automatic rotation service stopped")
