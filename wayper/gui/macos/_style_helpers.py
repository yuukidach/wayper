"""Reusable visual styling helpers for the macOS GUI."""

from __future__ import annotations

from AppKit import (
    NSFont,
    NSMakeRect,
    NSTextField,
    NSView,
)
from Quartz import CABasicAnimation, CGColorCreateGenericRGB, CGSizeMake

from .colors import C_BLUE, C_MANTLE_CG, C_SURFACE1_CG


def make_section_box(title: str, content_views: list) -> NSView:
    """Create a grouped section container with rounded background, border, and title.

    Every content view is pinned leading/trailing so it stretches to fill the box.
    """
    _H_PAD = 16
    _V_PAD = 12

    box = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 100))
    box.setWantsLayer_(True)
    box.layer().setBackgroundColor_(C_MANTLE_CG)
    box.layer().setCornerRadius_(10)
    box.layer().setBorderWidth_(1)
    box.layer().setBorderColor_(C_SURFACE1_CG)
    box.setTranslatesAutoresizingMaskIntoConstraints_(False)

    title_lbl = NSTextField.labelWithString_(title)
    title_lbl.setFont_(NSFont.systemFontOfSize_weight_(13, 0.3))
    title_lbl.setTextColor_(C_BLUE)
    title_lbl.setTranslatesAutoresizingMaskIntoConstraints_(False)
    box.addSubview_(title_lbl)

    constraints = [
        title_lbl.topAnchor().constraintEqualToAnchor_constant_(box.topAnchor(), _V_PAD),
        title_lbl.leadingAnchor().constraintEqualToAnchor_constant_(box.leadingAnchor(), _H_PAD),
    ]

    prev = title_lbl
    for view in content_views:
        view.setTranslatesAutoresizingMaskIntoConstraints_(False)
        box.addSubview_(view)
        constraints.extend(
            [
                view.topAnchor().constraintEqualToAnchor_constant_(prev.bottomAnchor(), 10),
                view.leadingAnchor().constraintEqualToAnchor_constant_(box.leadingAnchor(), _H_PAD),
                view.trailingAnchor().constraintEqualToAnchor_constant_(
                    box.trailingAnchor(), -_H_PAD
                ),
            ]
        )
        prev = view

    constraints.append(
        prev.bottomAnchor().constraintEqualToAnchor_constant_(box.bottomAnchor(), -_V_PAD)
    )
    box.addConstraints_(constraints)
    return box


def apply_card_shadow(view: NSView) -> None:
    """Apply a subtle drop shadow to a layer-backed view."""
    view.setWantsLayer_(True)
    layer = view.layer()
    layer.setShadowColor_(CGColorCreateGenericRGB(0, 0, 0, 1.0))
    layer.setShadowOpacity_(0.35)
    layer.setShadowRadius_(10)
    layer.setShadowOffset_(CGSizeMake(0, -3))
    layer.setMasksToBounds_(False)


def fade_in(view: NSView, duration: float = 0.25) -> None:
    """Run a fade-in animation on a layer-backed view."""
    view.setWantsLayer_(True)
    anim = CABasicAnimation.animationWithKeyPath_("opacity")
    anim.setFromValue_(0.0)
    anim.setToValue_(1.0)
    anim.setDuration_(duration)
    view.layer().addAnimation_forKey_(anim, "fadeIn")
