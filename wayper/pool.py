"""Pool management: directory helpers, blacklist, quota enforcement."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import TypedDict

from .config import WayperConfig
from .state import ALL_PURITIES
from .util import atomic_write

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class ImageMetadata(TypedDict, total=False):
    id: str
    tags: list[str]
    category: str
    purity: str
    resolution: str
    ratio: str
    views: int
    favorites: int
    url: str
    source: str
    colors: list[str]
    file_size: int
    file_type: str
    uploader: str
    created_at: str
    downloaded_at: int


def extract_tag_names(tags: list) -> list[str]:
    """Extract tag name strings from Wallhaven's mixed tag format."""
    if not tags:
        return []
    if isinstance(tags[0], dict):
        return [t.get("name", "") for t in tags]
    return list(tags)


def list_images(directory: Path) -> list[Path]:
    """List all image files in a directory."""
    if not directory.exists():
        return []
    return [f for f in directory.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS]


def count_images(directory: Path) -> int:
    return len(list_images(directory))


def disk_usage_mb(config: WayperConfig) -> float:
    """Disk usage of pool + favorites images in MB (excludes trash, cache, state files)."""
    total = 0
    for purity in ALL_PURITIES:
        # Pool dirs
        for orient in ("landscape", "portrait"):
            d = config.download_dir / purity / orient
            if d.is_dir():
                total += sum(f.stat().st_size for f in d.iterdir() if f.is_file())
        # Favorites dirs
        for orient in ("landscape", "portrait"):
            d = config.download_dir / "favorites" / purity / orient
            if d.is_dir():
                total += sum(f.stat().st_size for f in d.iterdir() if f.is_file())
    return total / 1024 / 1024


def pool_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / mode / orientation


def favorites_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / "favorites" / mode / orientation


def _matches_exclude_combo(filename: str, metadata: dict, combos: list[list[str]]) -> bool:
    """Return True if image's tags match any exclude combo rule."""
    entry = metadata.get(filename)
    if not entry:
        return False
    tag_set = set(extract_tag_names(entry.get("tags", [])))
    return any(all(t in tag_set for t in combo) for combo in combos)


def purge_combo_matches(config: WayperConfig) -> list[str]:
    """Blocklist+trash pool images matching exclude_combos. Returns purged filenames."""
    import logging

    from .state import push_undo

    combos = config.wallhaven.exclude_combos
    if not combos:
        return []

    metadata = load_metadata(config)
    if not metadata:
        return []

    log = logging.getLogger("wayper.pool")
    purged: list[str] = []

    for purity in ALL_PURITIES:
        for orient in ("landscape", "portrait"):
            for img in list_images(pool_dir(config, purity, orient)):
                if _matches_exclude_combo(img.name, metadata, combos):
                    add_to_blacklist(config, img.name)
                    push_undo(config, img.name, img.parent)
                    purged.append(img.name)

    if purged:
        log.info("Purged %d combo-matching images: %s", len(purged), purged)
    return purged


def pick_random(
    config: WayperConfig,
    purities: set[str],
    orientation: str,
    exclude: Path | None = None,
) -> Path | None:
    """Pick a random image: choose a random purity first (equal weight), then a random image."""
    import random as _rand

    combos = config.wallhaven.exclude_combos
    metadata = load_metadata(config) if combos else {}
    bl = _blacklist_set(config)

    active = [p for p in ALL_PURITIES if p in purities]
    if not active:
        return None
    _rand.shuffle(active)
    for purity in active:
        images = list_images(pool_dir(config, purity, orientation))
        images += list_images(favorites_dir(config, purity, orientation))
        if exclude:
            images = [img for img in images if img != exclude]
        if bl:
            images = [img for img in images if img.name not in bl]
        if combos:
            images = [
                img for img in images if not _matches_exclude_combo(img.name, metadata, combos)
            ]
        if images:
            return _rand.choice(images)
    return None


def list_blacklist(config: WayperConfig) -> list[tuple[int, str]]:
    """Return all blacklist entries as (timestamp, filename) sorted newest-first."""
    bf = config.blacklist_file
    if not bf.exists():
        return []
    entries = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit():
            entries.append((int(parts[0]), parts[1]))
    entries.sort(key=lambda e: e[0], reverse=True)
    return entries


_bl_cache: set[str] | None = None
_bl_mtime: float = 0


def _blacklist_set(config: WayperConfig) -> set[str]:
    """Return cached set of blacklisted filenames, refreshing on file change."""
    global _bl_cache, _bl_mtime
    bf = config.blacklist_file
    try:
        mtime = bf.stat().st_mtime
    except OSError:
        return set()
    if _bl_cache is None or mtime != _bl_mtime:
        _bl_cache = set()
        for line in bf.read_text().splitlines():
            parts = line.split(maxsplit=1)
            if len(parts) == 2:
                _bl_cache.add(parts[1])
        _bl_mtime = mtime
    return _bl_cache


def is_blacklisted(config: WayperConfig, filename: str) -> bool:
    return filename in _blacklist_set(config)


def add_to_blacklist(config: WayperConfig, filename: str) -> None:
    import time

    with open(config.blacklist_file, "a") as f:
        f.write(f"{int(time.time())} {filename}\n")
    global _bl_cache
    _bl_cache = None


def remove_from_blacklist(config: WayperConfig, filename: str) -> None:
    bf = config.blacklist_file
    if not bf.exists():
        return
    lines = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if not (len(parts) == 2 and parts[1] == filename):
            lines.append(line)
    atomic_write(bf, "\n".join(lines) + "\n" if lines else "")
    global _bl_cache
    _bl_cache = None


def prune_blacklist(config: WayperConfig) -> None:
    """Remove blacklist entries older than TTL."""
    import time

    bf = config.blacklist_file
    if not bf.exists():
        return
    cutoff = int(time.time()) - config.blacklist_ttl_days * 86400
    lines = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) >= cutoff:
            lines.append(line)
    atomic_write(bf, "\n".join(lines) + "\n" if lines else "")


def enforce_quota(config: WayperConfig) -> None:
    """Delete oldest non-favorite images until under quota."""
    for purity in ALL_PURITIES:
        pdir = config.download_dir / purity
        if not pdir.exists():
            continue
        quota_bytes = config.quota_mb * 1024 * 1024 // len(ALL_PURITIES)

        all_images = sorted(
            [f for f in pdir.rglob("*") if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS],
            key=lambda f: f.stat().st_mtime,
        )
        total = sum(f.stat().st_size for f in all_images)

        for img in all_images:
            if total <= quota_bytes:
                break
            size = img.stat().st_size
            img.unlink()
            total -= size


def should_download(config: WayperConfig, purities: set[str]) -> dict[str, bool]:
    """Return dict of {purity: needs_download} for each active purity."""
    result = {}
    for purity in purities:
        needs = False
        for orient in ("portrait", "landscape"):
            if count_images(pool_dir(config, purity, orient)) < config.pool_target:
                needs = True
                break
        if not needs:
            needs = random.random() < 0.2
        result[purity] = needs
    return result


def save_metadata(config: WayperConfig, filename: str, item: dict) -> None:
    """Persist Wallhaven metadata for a downloaded image."""
    import time

    mf = config.metadata_file
    data: dict = json.loads(mf.read_text()) if mf.exists() else {}
    tags = item.get("tags") or []
    uploader = item.get("uploader") or {}
    data[filename] = {
        "id": item.get("id", ""),
        "tags": extract_tag_names(tags),
        "category": item.get("category", ""),
        "purity": item.get("purity", ""),
        "resolution": item.get("resolution", ""),
        "ratio": item.get("ratio", ""),
        "views": item.get("views", 0),
        "favorites": item.get("favorites", 0),
        "url": item.get("url", ""),
        "source": item.get("source", ""),
        "colors": item.get("colors", []),
        "file_size": item.get("file_size", 0),
        "file_type": item.get("file_type", ""),
        "uploader": uploader.get("username", "") if isinstance(uploader, dict) else uploader,
        "created_at": item.get("created_at", ""),
        "downloaded_at": int(time.time()),
    }
    atomic_write(mf, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def load_metadata(config: WayperConfig) -> dict[str, ImageMetadata]:
    """Load all saved metadata."""
    mf = config.metadata_file
    if not mf.exists():
        return {}
    return json.loads(mf.read_text())


def ensure_directories(config: WayperConfig) -> None:
    """Create all required directories."""
    for purity in ALL_PURITIES:
        for orient in ("portrait", "landscape"):
            pool_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
            favorites_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
    # System trash is managed by the OS — no need to create trash directories
