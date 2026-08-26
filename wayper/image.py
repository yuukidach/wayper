"""Image validation, resize/crop, and thumbnail generation using Pillow."""

from __future__ import annotations

import logging
from pathlib import Path

from PIL import Image

log = logging.getLogger("wayper.image")


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
    try:
        if thumb.exists() and thumb.stat().st_mtime >= source.stat().st_mtime:
            return thumb
    except OSError:
        pass

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
            img.save(thumb, format="JPEG", quality=80)
        return thumb
    except Exception:
        log.debug("thumbnail generation failed for %s", source, exc_info=True)
        return None


def resize_crop(path: Path, width: int, height: int) -> bool:
    """Resize to fill target dimensions, center-crop to exact size.

    Equivalent to: magick img -resize WxH^ -gravity center -extent WxH img
    """
    try:
        with Image.open(path) as img:
            if img.mode not in ("RGB",):
                img = img.convert("RGB")

            scale = max(width / img.width, height / img.height)
            new_w = round(img.width * scale)
            new_h = round(img.height * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)

            left = (new_w - width) // 2
            top = (new_h - height) // 2
            img = img.crop((left, top, left + width, top + height))

            # Preserve format based on extension
            fmt = "JPEG" if path.suffix.lower() in (".jpg", ".jpeg") else "PNG"
            save_kwargs = {"quality": 95} if fmt == "JPEG" else {}
            img.save(path, format=fmt, **save_kwargs)
        return True
    except Exception:
        return False
