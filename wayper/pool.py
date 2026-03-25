"""Pool management: directory helpers, blacklist, quota enforcement."""

from __future__ import annotations

import random
from pathlib import Path

from .config import WayperConfig

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def list_images(directory: Path) -> list[Path]:
    """List all image files in a directory."""
    if not directory.exists():
        return []
    return [f for f in directory.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS]


def count_images(directory: Path) -> int:
    return len(list_images(directory))


def pool_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / mode / orientation


def favorites_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / "favorites" / mode / orientation


def pick_random(config: WayperConfig, mode: str, orientation: str) -> Path | None:
    """Pick a random image from pool + favorites."""
    images = list_images(pool_dir(config, mode, orientation))
    images += list_images(favorites_dir(config, mode, orientation))
    return random.choice(images) if images else None


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


def is_blacklisted(config: WayperConfig, filename: str) -> bool:
    bf = config.blacklist_file
    if not bf.exists():
        return False
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[1] == filename:
            return True
    return False


def add_to_blacklist(config: WayperConfig, filename: str) -> None:
    import time
    with open(config.blacklist_file, "a") as f:
        f.write(f"{int(time.time())} {filename}\n")


def remove_from_blacklist(config: WayperConfig, filename: str) -> None:
    bf = config.blacklist_file
    if not bf.exists():
        return
    lines = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if not (len(parts) == 2 and parts[1] == filename):
            lines.append(line)
    bf.write_text("\n".join(lines) + "\n" if lines else "")


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
    bf.write_text("\n".join(lines) + "\n" if lines else "")


def enforce_quota(config: WayperConfig) -> None:
    """Delete oldest non-favorite images until under quota."""
    for purity in ("sfw", "nsfw"):
        pdir = config.download_dir / purity
        if not pdir.exists():
            continue
        quota_bytes = config.quota_mb * 1024 * 1024 // 2  # half per purity

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


def should_download(config: WayperConfig, mode: str) -> bool:
    """True if any pool is below target or 20% random chance."""
    for orient in ("portrait", "landscape"):
        if count_images(pool_dir(config, mode, orient)) < config.pool_target:
            return True
    return random.random() < 0.2


def ensure_directories(config: WayperConfig) -> None:
    """Create all required directories."""
    for purity in ("sfw", "nsfw"):
        for orient in ("portrait", "landscape"):
            pool_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
            favorites_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
    for purity in ("sfw", "nsfw"):
        (config.trash_dir / purity).mkdir(parents=True, exist_ok=True)
