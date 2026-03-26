"""Quick actions panel: current wallpaper preview + next/prev/fav/dislike."""

from __future__ import annotations

import webbrowser
from pathlib import Path

import objc
from AppKit import (
    NSBezelStyleAccessoryBarAction,
    NSButton,
    NSFont,
    NSImage,
    NSImageScaleProportionallyUpOrDown,
    NSImageView,
    NSMakeRect,
    NSStackView,
    NSStackViewGravityCenter,
    NSStackViewGravityLeading,
    NSStackViewGravityTrailing,
    NSTextField,
    NSTimer,
    NSUserInterfaceLayoutOrientationHorizontal,
    NSUserInterfaceLayoutOrientationVertical,
    NSView,
)
from Foundation import NSObject
from Quartz import CGColorCreateGenericRGB

from ..backend import get_context, get_focused_monitor, query_current, set_wallpaper
from ..browse._common import wallhaven_url
from ..config import NO_TRANSITION, WayperConfig
from ..history import go_prev, pick_next, push as push_history
from ..pool import add_to_blacklist, favorites_dir, pick_random, pool_dir, remove_from_blacklist
from ..state import pop_undo, push_undo, read_mode, restore_from_trash
from .colors import C_BLUE, C_GREEN, C_TEXT


class ActionsPanelController(NSObject):
    """Quick actions: preview current wallpaper + action buttons."""

    def initWithConfig_(self, config):
        self = objc.super(ActionsPanelController, self).init()
        if self is None:
            return None
        self.config = config
        self._current_path: Path | None = None
        self._current_monitor: str | None = None
        self._timer: NSTimer | None = None
        self.view = self._build_ui()
        self._refresh()
        return self

    def _build_ui(self) -> NSView:
        root = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 600))
        root.setWantsLayer_(True)

        stack = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 700, 550))
        stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        stack.setSpacing_(16)
        stack.setTranslatesAutoresizingMaskIntoConstraints_(False)

        self._preview = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 0, 700, 400))
        self._preview.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        self._preview.setWantsLayer_(True)
        self._preview.layer().setCornerRadius_(12)
        self._preview.layer().setBackgroundColor_(CGColorCreateGenericRGB(0, 0, 0, 1))
        self._preview.setContentHuggingPriority_forOrientation_(1, 1)
        self._preview.setContentHuggingPriority_forOrientation_(1, 0)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 1)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 0)
        self._preview.setTranslatesAutoresizingMaskIntoConstraints_(False)
        stack.addView_inGravity_(self._preview, NSStackViewGravityLeading)

        # Info labels
        info_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 24))
        info_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        info_bar.setSpacing_(12)

        self._monitor_label = NSTextField.labelWithString_("")
        self._monitor_label.setTextColor_(C_BLUE)
        self._monitor_label.setFont_(NSFont.boldSystemFontOfSize_(13))
        info_bar.addView_inGravity_(self._monitor_label, NSStackViewGravityLeading)

        self._filename_label = NSTextField.labelWithString_("")
        self._filename_label.setTextColor_(C_TEXT)
        self._filename_label.setFont_(NSFont.systemFontOfSize_(12))
        info_bar.addView_inGravity_(self._filename_label, NSStackViewGravityLeading)

        self._fav_label = NSTextField.labelWithString_("")
        self._fav_label.setTextColor_(C_GREEN)
        self._fav_label.setFont_(NSFont.systemFontOfSize_(12))
        info_bar.addView_inGravity_(self._fav_label, NSStackViewGravityTrailing)

        stack.addView_inGravity_(info_bar, NSStackViewGravityLeading)

        # Action buttons
        btn_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 36))
        btn_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        btn_bar.setSpacing_(12)

        self._btn_prev = self._make_btn("Prev", "doPrev:")
        self._btn_next = self._make_btn("Next", "doNext:")
        self._btn_fav = self._make_btn("Fav", "doFav:")
        self._btn_unfav = self._make_btn("Unfav", "doUnfav:")
        self._btn_dislike = self._make_btn("Dislike", "doDislike:")
        self._btn_undo = self._make_btn("Undo Dislike", "doUndislike:")
        self._btn_open = self._make_btn("Open", "doOpen:")

        for b in (self._btn_prev, self._btn_next, self._btn_fav, self._btn_unfav,
                  self._btn_dislike, self._btn_undo, self._btn_open):
            btn_bar.addView_inGravity_(b, NSStackViewGravityCenter)

        stack.addView_inGravity_(btn_bar, NSStackViewGravityCenter)

        root.addSubview_(stack)
        root.addConstraints_([
            stack.topAnchor().constraintEqualToAnchor_constant_(root.topAnchor(), 20),
            stack.leadingAnchor().constraintEqualToAnchor_constant_(root.leadingAnchor(), 20),
            stack.trailingAnchor().constraintEqualToAnchor_constant_(root.trailingAnchor(), -20),
            stack.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -20),

            self._preview.leadingAnchor().constraintEqualToAnchor_(stack.leadingAnchor()),
            self._preview.trailingAnchor().constraintEqualToAnchor_(stack.trailingAnchor()),
        ])

        return root

    def _make_btn(self, title: str, action: str) -> NSButton:
        btn = NSButton.buttonWithTitle_target_action_(title, self, action)
        btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
        return btn

    # ── Refresh with change detection ──

    def _refresh(self):
        current = query_current()
        monitor = get_focused_monitor()
        if not monitor or monitor not in current:
            for name, path in current.items():
                if path:
                    monitor = name
                    break

        img = current.get(monitor) if monitor else None

        # Skip UI update if nothing changed
        if img == self._current_path and monitor == self._current_monitor:
            return

        self._current_monitor = monitor
        self._current_path = img

        if img and img.exists():
            ns_img = NSImage.alloc().initByReferencingFile_(str(img))
            self._preview.setImage_(ns_img)
        else:
            self._preview.setImage_(None)

        self._monitor_label.setStringValue_(monitor or "\u2014")
        self._filename_label.setStringValue_(img.name if img else "No wallpaper")
        is_fav = img and "favorites" in str(img)
        self._fav_label.setStringValue_("Favorite" if is_fav else "")

        self._btn_fav.setHidden_(bool(is_fav))
        self._btn_unfav.setHidden_(not is_fav)

    def startPolling(self):
        if self._timer:
            return
        self._timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            3.0, self, "pollRefresh:", None, True,
        )

    def stopPolling(self):
        if self._timer:
            self._timer.invalidate()
            self._timer = None

    @objc.typedSelector(b"v@:@")
    def pollRefresh_(self, timer):
        self._refresh()

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def doNext_(self, sender):
        monitor, mon_cfg, _ = get_context(self.config)
        if not mon_cfg:
            return
        img = pick_next(self.config, monitor, mon_cfg.orientation)
        if img:
            set_wallpaper(monitor, img, self.config.transition)
        self._current_path = None  # force refresh
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doPrev_(self, sender):
        monitor, mon_cfg, _ = get_context(self.config)
        if not mon_cfg:
            return
        img = go_prev(self.config, monitor)
        if img:
            set_wallpaper(monitor, img, self.config.transition)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doFav_(self, sender):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" in str(img):
            return
        mode = read_mode(self.config)
        dest_dir = favorites_dir(self.config, mode, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doUnfav_(self, sender):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" not in str(img):
            return
        mode = read_mode(self.config)
        dest_dir = pool_dir(self.config, mode, mon_cfg.orientation)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doDislike_(self, sender):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" in str(img):
            return
        mode = read_mode(self.config)
        next_img = pick_random(self.config, mode, mon_cfg.orientation)
        if next_img:
            set_wallpaper(monitor, next_img, self.config.transition)
            push_history(self.config, monitor, next_img)
        add_to_blacklist(self.config, img.name)
        push_undo(self.config, img.name, img.parent)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doUndislike_(self, sender):
        entry = pop_undo(self.config)
        if not entry:
            return
        filename, orig_dir = entry
        restored = restore_from_trash(self.config, filename, orig_dir)
        remove_from_blacklist(self.config, filename)
        if restored:
            monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, self.config.transition)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doOpen_(self, sender):
        if self._current_path:
            webbrowser.open(wallhaven_url(self._current_path))

    # ── Keyboard ──

    def handleKeyDown_(self, event) -> bool:
        chars = event.charactersIgnoringModifiers()
        if not chars:
            return False
        key = chars[0]
        actions = {
            "n": lambda: self.doNext_(None),
            "p": lambda: self.doPrev_(None),
            "f": lambda: self.doFav_(None),
            "u": lambda: self.doUnfav_(None),
            "x": lambda: self.doDislike_(None),
            "z": lambda: self.doUndislike_(None),
            "o": lambda: self.doOpen_(None),
        }
        if key in actions:
            actions[key]()
            return True
        return False
