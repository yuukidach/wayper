"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import base64
import logging
import random
from pathlib import Path

from .config import WayperConfig
from .image import generate_thumbnail
from .pool import (
    ImageMetadata,
    favorites_dir,
    list_blacklist,
    list_images,
    pool_dir,
)
from .state import ALL_PURITIES

log = logging.getLogger("wayper.ai")


def _collect_tag_groups(
    config: WayperConfig,
    metadata: dict[str, ImageMetadata],
) -> dict:
    """Split metadata into disliked, favorited, and pool groups with their tags."""
    blacklisted = {fn for _, fn in list_blacklist(config)}

    # Collect favorite filenames
    fav_files: set[str] = set()
    for purity in ALL_PURITIES:
        for orient in ("landscape", "portrait"):
            for img in list_images(favorites_dir(config, purity, orient)):
                fav_files.add(img.name)

    dislike_tags: list[list[str]] = []
    fav_tags: list[list[str]] = []
    pool_tags: list[list[str]] = []

    for filename, meta in metadata.items():
        tags = meta.get("tags", [])
        if not tags:
            continue
        if filename in blacklisted:
            dislike_tags.append(tags)
        elif filename in fav_files:
            fav_tags.append(tags)
        else:
            pool_tags.append(tags)

    # Sample pool if too large
    if len(pool_tags) > 200:
        pool_tags = random.sample(pool_tags, 200)

    return {
        "dislike": dislike_tags,
        "favorite": fav_tags,
        "pool": pool_tags,
    }


def _sample_thumbnails(
    config: WayperConfig,
    blacklisted_entries: list[tuple[int, str]],
    fav_files: list[Path],
    pool_files: list[Path],
) -> dict[str, list[str]]:
    """Sample and base64-encode thumbnails from each group.

    Returns dict with keys "dislike", "favorite", "pool", each a list of
    base64-encoded JPEG data URIs.
    """
    cache_dir = config.download_dir / ".thumbnails" / "_ai"

    def encode_images(paths: list[Path], limit: int) -> list[str]:
        results = []
        for p in paths[:limit]:
            thumb = generate_thumbnail(p, cache_dir, max_width=300)
            target = thumb if thumb else p
            try:
                data = target.read_bytes()
                b64 = base64.b64encode(data).decode()
                suffix = target.suffix.lower()
                mime = (
                    "image/jpeg" if suffix in (".jpg", ".jpeg") else f"image/{suffix.lstrip('.')}"
                )
                results.append(f"data:{mime};base64,{b64}")
            except OSError:
                continue
        return results

    # Dislike: most recent 20 by timestamp
    dislike_paths: list[Path] = []
    for _, fn in blacklisted_entries[:20]:
        found = False
        for purity in ALL_PURITIES:
            for orient in ("landscape", "portrait"):
                candidate = pool_dir(config, purity, orient) / fn
                if candidate.exists():
                    dislike_paths.append(candidate)
                    found = True
                    break
            if found:
                break
        # Also check trash if not found in pool
        if not found:
            from .state import find_in_trash

            trashed = find_in_trash(config, fn)
            if trashed:
                dislike_paths.append(trashed)

    # Favorites: random 20
    fav_sample = random.sample(fav_files, min(20, len(fav_files))) if fav_files else []

    # Pool: random 10
    pool_sample = random.sample(pool_files, min(10, len(pool_files))) if pool_files else []

    return {
        "dislike": encode_images(dislike_paths, 20),
        "favorite": encode_images(fav_sample, 20),
        "pool": encode_images(pool_sample, 10),
    }
