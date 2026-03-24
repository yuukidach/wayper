"""Image validation and resize/crop using Pillow."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


def validate_image(path: Path) -> bool:
    """Fully decode image to detect corruption. Returns True if valid."""
    try:
        with Image.open(path) as img:
            img.load()
        return True
    except Exception:
        return False


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
