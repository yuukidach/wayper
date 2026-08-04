"""Regression tests for the Windows application icon."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

WINDOWS_ICON = Path(__file__).parents[1] / "assets" / "icon.ico"
EXPECTED_SIZES = {
    (16, 16),
    (20, 20),
    (24, 24),
    (32, 32),
    (40, 40),
    (48, 48),
    (64, 64),
    (128, 128),
    (256, 256),
}


def test_windows_icon_fills_each_taskbar_size() -> None:
    with Image.open(WINDOWS_ICON) as icon:
        assert icon.ico.sizes() == EXPECTED_SIZES

        for size in EXPECTED_SIZES:
            frame = icon.ico.getimage(size).convert("RGBA")
            assert frame.getchannel("A").getbbox() == (0, 0, *size)
