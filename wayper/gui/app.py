"""NSApplication setup with menu bar and activation policy."""

from __future__ import annotations

import objc
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyRegular,
    NSEventModifierFlagCommand,
    NSEventModifierFlagShift,
    NSMenu,
    NSMenuItem,
)
from Foundation import NSObject

from ..config import WayperConfig
from .main_window import MainWindowController


class AppDelegate(NSObject):

    def initWithController_(self, controller):
        self = objc.super(AppDelegate, self).init()
        if self is None:
            return None
        self._controller = controller
        return self

    def applicationShouldTerminateAfterLastWindowClosed_(self, app):
        return True

    def applicationWillTerminate_(self, notification):
        self._controller.cleanup()


class WayperApp:

    @staticmethod
    def launch(config: WayperConfig) -> None:
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyRegular)

        controller = MainWindowController.alloc().initWithConfig_(config)

        delegate = AppDelegate.alloc().initWithController_(controller)
        app.setDelegate_(delegate)

        _build_menu(app, controller)

        controller.window.makeKeyAndOrderFront_(None)
        app.activateIgnoringOtherApps_(True)
        app.run()


def _build_menu(app: NSApplication, controller: MainWindowController) -> None:
    menubar = NSMenu.alloc().init()

    # App menu
    app_menu = NSMenu.alloc().initWithTitle_("Wayper")
    app_menu.addItemWithTitle_action_keyEquivalent_("About Wayper", "orderFrontStandardAboutPanel:", "")
    app_menu.addItem_(NSMenuItem.separatorItem())
    app_menu.addItemWithTitle_action_keyEquivalent_("Quit Wayper", "terminate:", "q")

    app_item = NSMenuItem.alloc().init()
    app_item.setSubmenu_(app_menu)
    menubar.addItem_(app_item)

    # Edit menu
    edit_menu = NSMenu.alloc().initWithTitle_("Edit")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Cut", "cut:", "x")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Copy", "copy:", "c")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Paste", "paste:", "v")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Select All", "selectAll:", "a")

    edit_item = NSMenuItem.alloc().init()
    edit_item.setSubmenu_(edit_menu)
    menubar.addItem_(edit_item)

    # View menu
    view_menu = NSMenu.alloc().initWithTitle_("View")

    browse_item = view_menu.addItemWithTitle_action_keyEquivalent_("Browse", "showBrowse:", "1")
    browse_item.setTarget_(controller)

    actions_item = view_menu.addItemWithTitle_action_keyEquivalent_("Quick Actions", "showActions:", "2")
    actions_item.setTarget_(controller)

    view_mi = NSMenuItem.alloc().init()
    view_mi.setSubmenu_(view_menu)
    menubar.addItem_(view_mi)

    # Wallpaper menu
    wp_menu = NSMenu.alloc().initWithTitle_("Wallpaper")

    next_item = wp_menu.addItemWithTitle_action_keyEquivalent_("Next", "menuNext:", "n")
    next_item.setTarget_(controller)

    prev_item = wp_menu.addItemWithTitle_action_keyEquivalent_("Previous", "menuPrev:", "p")
    prev_item.setTarget_(controller)

    wp_menu.addItem_(NSMenuItem.separatorItem())

    fav_item = wp_menu.addItemWithTitle_action_keyEquivalent_("Favorite", "menuFav:", "f")
    fav_item.setTarget_(controller)
    fav_item.setKeyEquivalentModifierMask_(NSEventModifierFlagCommand | NSEventModifierFlagShift)

    wp_mi = NSMenuItem.alloc().init()
    wp_mi.setSubmenu_(wp_menu)
    menubar.addItem_(wp_mi)

    # Window menu
    window_menu = NSMenu.alloc().initWithTitle_("Window")
    window_menu.addItemWithTitle_action_keyEquivalent_("Minimize", "performMiniaturize:", "m")
    window_menu.addItemWithTitle_action_keyEquivalent_("Zoom", "performZoom:", "")
    window_menu.addItemWithTitle_action_keyEquivalent_("Close", "performClose:", "w")

    window_item = NSMenuItem.alloc().init()
    window_item.setSubmenu_(window_menu)
    menubar.addItem_(window_item)
    app.setWindowsMenu_(window_menu)

    app.setMainMenu_(menubar)
