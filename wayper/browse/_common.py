"""Shared helpers for browse UI implementations."""

from __future__ import annotations

from pathlib import Path

from ..config import WayperConfig
from ..pool import favorites_dir, list_blacklist, list_images, pool_dir


def get_orient(img_path: Path) -> str:
    """Detect orientation from parent directory name or image dimensions."""
    if "portrait" in str(img_path.parent):
        return "portrait"
    if "landscape" in str(img_path.parent):
        return "landscape"
    try:
        from PIL import Image

        img = Image.open(img_path)
        return "portrait" if img.height > img.width else "landscape"
    except Exception:
        return "landscape"


def get_images(category: str, mode: str, config: WayperConfig) -> list[Path]:
    """Collect images for category and mode."""
    images: list[Path] = []
    if category == "favorites":
        for orient in ("landscape", "portrait"):
            images.extend(list_images(favorites_dir(config, mode, orient)))
    elif category == "disliked":
        images.extend(list_images(config.trash_dir / mode))
    else:
        for orient in ("landscape", "portrait"):
            images.extend(list_images(pool_dir(config, mode, orient)))
    return sorted(images, key=lambda p: p.stat().st_mtime, reverse=True)


def get_blocklist_only(images: list[Path], config: WayperConfig) -> list[str]:
    """Build list of blacklisted names that have no corresponding trash file."""
    trash_names = {p.name for p in images}
    return [name for _ts, name in list_blacklist(config) if name not in trash_names]


def wallhaven_url(img_path: Path) -> str:
    """Build Wallhaven URL from image path."""
    wall_id = img_path.stem.replace("wallhaven-", "")
    return f"https://wallhaven.cc/w/{wall_id}"
