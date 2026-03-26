"""GTK4 application entry point."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gtk

from ...config import WayperConfig
from .css import CSS


class WayperGtkApp(Gtk.Application):
    """GTK4 Wayper GUI application."""

    _css_applied = False

    def __init__(self, config: WayperConfig):
        super().__init__(application_id="io.github.yuukidach.wayper.gui")
        self._config = config

    def do_activate(self):
        if not WayperGtkApp._css_applied:
            css = Gtk.CssProvider()
            css.load_from_data(CSS)
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                css,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
            )
            WayperGtkApp._css_applied = True

        from .main_window import MainWindow

        win = MainWindow(config=self._config, application=self)
        win.present()

    def do_startup(self):
        Gtk.Application.do_startup(self)
        self.set_accels_for_action("win.close", ["<Control>q"])


def run(config: WayperConfig):
    app = WayperGtkApp(config=config)
    app.run()
