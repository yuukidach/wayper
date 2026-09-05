"""Image validation and thumbnail generation using Pillow."""

from __future__ import annotations

import logging
import tempfile
import threading
from pathlib import Path

from PIL import Image

log = logging.getLogger("wayper.image")


_thumbnail_locks = tuple(threading.Lock() for _ in range(64))


def _cached_derivative_is_fresh(source: Path, derivative: Path) -> bool:
    try:
        return derivative.exists() and derivative.stat().st_mtime >= source.stat().st_mtime
    except OSError:
        return False


def _atomic_jpeg_save(image: Image.Image, target: Path, *, quality: int) -> None:
    """Publish a complete JPEG in one rename so FileResponse never sees a partial file."""
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            image.save(output, format="JPEG", quality=quality)
        temporary.replace(target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def validate_image(path: Path) -> bool:
    """Fully decode image to detect corruption. Returns True if valid."""
    try:
        with Image.open(path) as img:
            img.load()
        return True
    except Exception:
        return False


def generate_thumbnail(
    source: Path,
    cache_dir: Path,
    max_width: int = 400,
    max_height: int | None = None,
) -> Path | None:
    """Generate a JPEG thumbnail preserving aspect ratio (only downscales).

    Returns the thumbnail path on success, None on failure.
    Skips regeneration if a cached thumbnail with newer mtime exists.
    """
    thumb = cache_dir / (source.stem + ".jpg")
    if _cached_derivative_is_fresh(source, thumb):
        return thumb

    lock = _thumbnail_locks[hash(thumb) % len(_thumbnail_locks)]
    with lock:
        # The first requester may have completed while this one was waiting.
        if _cached_derivative_is_fresh(source, thumb):
            return thumb

        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as img:
                height_limit = max_height if max_height is not None else max_width * 4
                if img.width <= max_width and img.height <= height_limit:
                    return None  # already small enough, serve original
                # JPEG can select a smaller decoder resolution before allocating
                # the full raster. This matters for unusually large wallpapers.
                if img.format == "JPEG":
                    img.draft("RGB", (max_width, height_limit))
                if img.mode != "RGB":
                    img = img.convert("RGB")
                img.thumbnail((max_width, height_limit), Image.LANCZOS)
                _atomic_jpeg_save(img, thumb, quality=80)
            return thumb
        except Exception:
            log.debug("thumbnail generation failed for %s", source, exc_info=True)
            return None
