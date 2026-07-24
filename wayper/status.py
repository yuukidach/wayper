"""Read-only application status shared by CLI, MCP, and HTTP adapters."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path

from .backend import query_current
from .config import WayperConfig
from .daemon import is_daemon_running
from .pool import count_images, disk_usage_mb, favorites_dir, pool_dir
from .state import read_mode


def library_counts(
    config: WayperConfig,
    purities: Iterable[str],
    orientations: Iterable[str],
    *,
    count: Callable[[Path], int] | None = None,
) -> tuple[int, int]:
    """Return pool and favorite image counts for a library slice."""
    counter = count_images if count is None else count
    directory_keys = tuple(
        (purity, orientation) for purity in purities for orientation in orientations
    )
    pool_count = sum(counter(pool_dir(config, *key)) for key in directory_keys)
    favorite_count = sum(counter(favorites_dir(config, *key)) for key in directory_keys)
    return pool_count, favorite_count


def status_snapshot(config: WayperConfig) -> dict[str, object]:
    """Collect the complete user-facing status without changing state."""
    purities = read_mode(config)
    current = query_current()
    monitors = []
    for monitor in config.monitors:
        pool_count, favorite_count = library_counts(
            config,
            purities,
            (monitor.orientation,),
        )
        image = current.get(monitor.name)
        monitors.append(
            {
                "name": monitor.name,
                "orientation": monitor.orientation,
                "image": str(image) if image else None,
                "pool_count": pool_count,
                "favorites_count": favorite_count,
            }
        )

    daemon_running, _ = is_daemon_running(config)
    return {
        "mode": sorted(purities),
        "daemon": daemon_running,
        "disk_mb": round(disk_usage_mb(config), 1),
        "quota_mb": config.quota_mb,
        "monitors": monitors,
    }
