"""Catppuccin Mocha color palette for AppKit."""

from __future__ import annotations

from AppKit import NSColor
from Quartz import CGColorCreateGenericRGB


def _rgb(r: int, g: int, b: int) -> NSColor:
    return NSColor.colorWithSRGBRed_green_blue_alpha_(r / 255, g / 255, b / 255, 1.0)


def _cg(r: int, g: int, b: int):
    return CGColorCreateGenericRGB(r / 255, g / 255, b / 255, 1.0)


C_BASE = _rgb(0x1E, 0x1E, 0x2E)
C_OVERLAY = _rgb(0x6C, 0x70, 0x86)
C_TEXT = _rgb(0xCD, 0xD6, 0xF4)
C_SUBTEXT = _rgb(0xA6, 0xAD, 0xC8)
C_BLUE = _rgb(0x89, 0xB4, 0xFA)
C_GREEN = _rgb(0xA6, 0xE3, 0xA1)
C_RED = _rgb(0xF3, 0x8B, 0xA8)
C_SURFACE = _rgb(0x31, 0x32, 0x44)
C_MANTLE = _rgb(0x18, 0x18, 0x25)
C_SURFACE1 = _rgb(0x45, 0x47, 0x5A)
C_SURFACE2 = _rgb(0x58, 0x5B, 0x70)
C_PEACH = _rgb(0xFA, 0xB3, 0x87)
C_TEAL = _rgb(0x94, 0xE2, 0xD5)

# Pre-computed CGColors for layer backgrounds
C_BASE_CG = _cg(0x1E, 0x1E, 0x2E)
C_SURFACE_CG = _cg(0x31, 0x32, 0x44)
C_MANTLE_CG = _cg(0x18, 0x18, 0x25)
C_SURFACE1_CG = _cg(0x45, 0x47, 0x5A)
