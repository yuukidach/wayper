"""Catppuccin Mocha color palette for AppKit."""

from __future__ import annotations

from AppKit import NSColor


def _rgb(r: int, g: int, b: int) -> NSColor:
    return NSColor.colorWithSRGBRed_green_blue_alpha_(r / 255, g / 255, b / 255, 1.0)


C_BASE = _rgb(0x1E, 0x1E, 0x2E)
C_OVERLAY = _rgb(0x6C, 0x70, 0x86)
C_TEXT = _rgb(0xCD, 0xD6, 0xF4)
C_SUBTEXT = _rgb(0xA6, 0xAD, 0xC8)
C_BLUE = _rgb(0x89, 0xB4, 0xFA)
C_GREEN = _rgb(0xA6, 0xE3, 0xA1)
C_RED = _rgb(0xF3, 0x8B, 0xA8)
