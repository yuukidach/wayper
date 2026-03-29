"""Wallpaper history tracking with back/forward navigation."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import WayperConfig

MAX_HISTORY = 50


def _load(config: WayperConfig) -> dict:
    try:
        return json.loads(config.history_file.read_text())
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        return {}


def _save(config: WayperConfig, data: dict) -> None:
    tmp = config.history_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, config.history_file)


def _monitor_data(data: dict, monitor: str) -> dict:
    if monitor not in data:
        data[monitor] = {"entries": [], "position": -1}
    return data[monitor]


def _push_to(data: dict, monitor: str, image: Path) -> None:
    md = _monitor_data(data, monitor)
    entries = md["entries"]
    pos = md["position"]

    if 0 <= pos < len(entries) - 1:
        entries[:] = entries[: pos + 1]

    path_str = str(image)
    if entries and entries[-1] == path_str:
        return

    entries.append(path_str)
    if len(entries) > MAX_HISTORY:
        entries[:] = entries[-MAX_HISTORY:]
    md["position"] = len(entries) - 1


def push(config: WayperConfig, monitor: str, image: Path) -> None:
    """Record a new wallpaper. Truncates any forward history."""
    data = _load(config)
    _push_to(data, monitor, image)
    _save(config, data)


def push_many(config: WayperConfig, items: list[tuple[str, Path]]) -> None:
    """Record wallpapers for multiple monitors in a single read-write cycle."""
    if not items:
        return
    data = _load(config)
    for monitor, image in items:
        _push_to(data, monitor, image)
    _save(config, data)


def _navigate(config: WayperConfig, monitor: str, direction: int) -> Path | None:
    data = _load(config)
    md = _monitor_data(data, monitor)
    entries = md["entries"]
    pos = md["position"]

    candidate = pos + direction
    while 0 <= candidate < len(entries):
        p = Path(entries[candidate])
        if p.exists():
            md["position"] = candidate
            _save(config, data)
            return p
        candidate += direction

    return None


def pick_next(config: WayperConfig, monitor: str, orientation: str) -> Path | None:
    """Try forward history, then pick random. Pushes to history if new."""
    from .pool import pick_random
    from .state import read_mode

    img = go_next(config, monitor)
    if img:
        return img

    purities = read_mode(config)
    img = pick_random(config, purities, orientation)
    if img:
        push(config, monitor, img)
    return img


def go_prev(config: WayperConfig, monitor: str) -> Path | None:
    """Move back one step. Returns image path or None if at start."""
    return _navigate(config, monitor, -1)


def go_next(config: WayperConfig, monitor: str) -> Path | None:
    """Move forward one step. Returns image path or None if at end."""
    return _navigate(config, monitor, +1)
