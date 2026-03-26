"""GTK4 GUI package — shared widget helpers."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402


def populate_tags(container: Gtk.FlowBox, tag_names: list[str]) -> None:
    """Clear a FlowBox and fill it with styled tag labels."""
    while child := container.get_first_child():
        container.remove(child)
    for name in tag_names:
        lbl = Gtk.Label(label=name)
        lbl.add_css_class("wallhaven-tag")
        container.append(lbl)
