"""Wallhaven online browse panel for macOS: search, preview, and download."""

from __future__ import annotations

import asyncio
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor

import httpx
import objc
from AppKit import (
    NSBezelStyleRounded,
    NSButton,
    NSCenterTextAlignment,
    NSCollectionView,
    NSCollectionViewFlowLayout,
    NSCollectionViewItem,
    NSCompositingOperationSourceOver,
    NSFont,
    NSImage,
    NSImageScaleProportionallyUpOrDown,
    NSImageView,
    NSLeftTextAlignment,
    NSLineBreakByTruncatingTail,
    NSLineBreakByWordWrapping,
    NSMakeRect,
    NSMakeSize,
    NSPopUpButton,
    NSProgressIndicator,
    NSProgressIndicatorSpinningStyle,
    NSScrollView,
    NSSearchField,
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
from Foundation import NSEdgeInsets, NSIndexPath, NSObject

from ...browse._common import format_size
from ...config import WayperConfig
from ...image import resize_crop
from ...pool import extract_tag_names, favorites_dir, is_blacklisted, pool_dir, save_metadata
from ...state import read_mode
from ...wallhaven import WallhavenClient
from ._style_helpers import fade_in
from .colors import C_BASE, C_BLUE, C_GREEN, C_MANTLE_CG, C_OVERLAY, C_SURFACE_CG, C_TEXT

THUMB_SIZE = 200
ITEM_IDENTIFIER = "wallhaven_thumb"

SORT_LABELS = ("Toplist", "Random", "Hot", "Date Added", "Views", "Favorites")
SORT_KEYS = ("toplist", "random", "hot", "date_added", "views", "favorites")


class WallhavenThumbItem(NSCollectionViewItem):
    """Collection view cell showing a Wallhaven thumbnail and resolution label."""

    def loadView(self):
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, THUMB_SIZE, THUMB_SIZE + 24))
        container.setWantsLayer_(True)
        container.layer().setCornerRadius_(8)

        iv = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 24, THUMB_SIZE, THUMB_SIZE))
        iv.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        iv.setWantsLayer_(True)
        iv.layer().setCornerRadius_(6)
        iv.layer().setMasksToBounds_(True)
        iv.layer().setBackgroundColor_(C_SURFACE_CG)
        container.addSubview_(iv)

        label = NSTextField.labelWithString_("")
        label.setFrame_(NSMakeRect(0, 2, THUMB_SIZE, 18))
        label.setAlignment_(NSCenterTextAlignment)
        label.setFont_(NSFont.systemFontOfSize_(11))
        label.setTextColor_(C_TEXT)
        label.setLineBreakMode_(NSLineBreakByTruncatingTail)
        container.addSubview_(label)

        self.setView_(container)
        self._imageView = iv
        self._label = label

    def setSelected_(self, selected):
        objc.super(WallhavenThumbItem, self).setSelected_(selected)
        layer = self.view().layer()
        if selected:
            layer.setBorderWidth_(2)
            layer.setBorderColor_(C_BLUE.CGColor())
        else:
            layer.setBorderWidth_(0)

    def configureWithImage_resolution_(self, image, resolution):
        self._imageView.setImage_(image)
        self._label.setStringValue_(resolution)


class WallhavenPanelController(NSObject):
    """Browse and download wallpapers from Wallhaven (AppKit)."""

    def initWithConfig_(self, config: WayperConfig):
        self = objc.super(WallhavenPanelController, self).init()
        if self is None:
            return None
        self.config = config
        self._client = WallhavenClient(config)
        self._sync_http = httpx.Client(proxy=config.proxy, timeout=15)
        self._thumb_pool = ThreadPoolExecutor(max_workers=4)
        self._results: list[dict] = []
        self._page: int = 1
        self._searching: bool = False
        self._selected_item: dict | None = None
        self._thumb_cache_dir = config.download_dir / ".thumb_cache"
        self._thumb_cache_dir.mkdir(parents=True, exist_ok=True)
        self._thumb_images: dict[str, NSImage] = {}
        self._debounce_timer: NSTimer | None = None
        self.view = self._build_ui()
        return self

    # ── UI Construction ──

    def _build_ui(self) -> NSView:
        root = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 1100, 650))
        root.setWantsLayer_(True)

        # ── Search bar (top) ──
        search_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 1000, 32))
        search_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        search_bar.setSpacing_(8)
        search_bar.setTranslatesAutoresizingMaskIntoConstraints_(False)
        search_bar.setContentHuggingPriority_forOrientation_(999, 1)
        search_bar.setWantsLayer_(True)
        search_bar.layer().setBackgroundColor_(C_MANTLE_CG)
        search_bar.layer().setCornerRadius_(8)

        self._search_field = NSSearchField.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 28))
        self._search_field.setPlaceholderString_("Search Wallhaven...")
        self._search_field.setTarget_(self)
        self._search_field.setAction_("onSearchAction:")
        self._search_field.setDelegate_(self)
        search_bar.addView_inGravity_(self._search_field, NSStackViewGravityLeading)

        self._sort_popup = NSPopUpButton.alloc().initWithFrame_pullsDown_(
            NSMakeRect(0, 0, 120, 28), False
        )
        for label in SORT_LABELS:
            self._sort_popup.addItemWithTitle_(label)
        self._sort_popup.selectItemAtIndex_(0)
        self._sort_popup.setTarget_(self)
        self._sort_popup.setAction_("onSortChanged:")
        search_bar.addView_inGravity_(self._sort_popup, NSStackViewGravityLeading)

        search_btn = NSButton.buttonWithTitle_target_action_("Search", self, "onSearchAction:")
        search_btn.setBezelStyle_(NSBezelStyleRounded)
        search_btn.setContentTintColor_(C_BLUE)
        search_bar.addView_inGravity_(search_btn, NSStackViewGravityLeading)

        root.addSubview_(search_bar)

        # ── Left: Collection view (thumbnail grid) ──
        layout = NSCollectionViewFlowLayout.alloc().init()
        layout.setItemSize_(NSMakeSize(THUMB_SIZE, THUMB_SIZE + 24))
        layout.setMinimumInteritemSpacing_(8)
        layout.setMinimumLineSpacing_(8)
        layout.setSectionInset_((12, 12, 12, 12))

        self._cv = NSCollectionView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 550))
        self._cv.setCollectionViewLayout_(layout)
        self._cv.setDataSource_(self)
        self._cv.setDelegate_(self)
        self._cv.setBackgroundColors_([C_BASE])
        self._cv.setSelectable_(True)
        self._cv.registerClass_forItemWithIdentifier_(WallhavenThumbItem, ITEM_IDENTIFIER)

        scroll = NSScrollView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 550))
        scroll.setDocumentView_(self._cv)
        scroll.setHasVerticalScroller_(True)
        scroll.setDrawsBackground_(False)
        scroll.setTranslatesAutoresizingMaskIntoConstraints_(False)

        # Bottom bar (status + spinner + load more)
        bottom_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 28))
        bottom_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        bottom_bar.setSpacing_(8)
        bottom_bar.setTranslatesAutoresizingMaskIntoConstraints_(False)
        bottom_bar.setContentHuggingPriority_forOrientation_(999, 1)

        self._status_label = NSTextField.labelWithString_("Search to browse Wallhaven")
        self._status_label.setTextColor_(C_OVERLAY)
        self._status_label.setFont_(NSFont.systemFontOfSize_(11))
        bottom_bar.addView_inGravity_(self._status_label, NSStackViewGravityLeading)

        self._spinner = NSProgressIndicator.alloc().initWithFrame_(NSMakeRect(0, 0, 16, 16))
        self._spinner.setStyle_(NSProgressIndicatorSpinningStyle)
        self._spinner.setControlSize_(1)  # NSControlSizeSmall
        self._spinner.setDisplayedWhenStopped_(False)
        bottom_bar.addView_inGravity_(self._spinner, NSStackViewGravityLeading)

        self._load_more_btn = NSButton.buttonWithTitle_target_action_(
            "Load more", self, "onLoadMore:"
        )
        self._load_more_btn.setBezelStyle_(NSBezelStyleRounded)
        self._load_more_btn.setContentTintColor_(C_BLUE)
        self._load_more_btn.setHidden_(True)
        bottom_bar.addView_inGravity_(self._load_more_btn, NSStackViewGravityTrailing)

        # Left column container
        left_col = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 580))
        left_col.setTranslatesAutoresizingMaskIntoConstraints_(False)
        left_col.addSubview_(scroll)
        left_col.addSubview_(bottom_bar)
        left_col.addConstraints_(
            [
                scroll.topAnchor().constraintEqualToAnchor_(left_col.topAnchor()),
                scroll.leadingAnchor().constraintEqualToAnchor_(left_col.leadingAnchor()),
                scroll.trailingAnchor().constraintEqualToAnchor_(left_col.trailingAnchor()),
                scroll.bottomAnchor().constraintEqualToAnchor_constant_(bottom_bar.topAnchor(), -4),
                bottom_bar.leadingAnchor().constraintEqualToAnchor_(left_col.leadingAnchor()),
                bottom_bar.trailingAnchor().constraintEqualToAnchor_(left_col.trailingAnchor()),
                bottom_bar.bottomAnchor().constraintEqualToAnchor_(left_col.bottomAnchor()),
                bottom_bar.heightAnchor().constraintEqualToConstant_(28),
            ]
        )

        root.addSubview_(left_col)

        # ── Right: Preview + metadata + actions ──
        right = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 580))
        right.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        right.setSpacing_(12)
        right.setTranslatesAutoresizingMaskIntoConstraints_(False)

        # Preview image
        self._preview = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 350))
        self._preview.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        self._preview.setWantsLayer_(True)
        self._preview.layer().setCornerRadius_(12)
        self._preview.layer().setBackgroundColor_(C_MANTLE_CG)
        self._preview.setContentHuggingPriority_forOrientation_(1, 1)
        self._preview.setContentHuggingPriority_forOrientation_(1, 0)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 1)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 0)
        self._preview.setTranslatesAutoresizingMaskIntoConstraints_(False)

        self._placeholder = NSTextField.labelWithString_("Select an image to preview")
        self._placeholder.setTextColor_(C_OVERLAY)
        self._placeholder.setFont_(NSFont.systemFontOfSize_(13))
        self._placeholder.setAlignment_(NSCenterTextAlignment)
        self._placeholder.setTranslatesAutoresizingMaskIntoConstraints_(False)
        self._preview.addSubview_(self._placeholder)

        right.addView_inGravity_(self._preview, NSStackViewGravityLeading)

        # Metadata labels
        self._meta_stack = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 80))
        self._meta_stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        self._meta_stack.setSpacing_(4)
        self._meta_stack.setContentHuggingPriority_forOrientation_(999, 1)
        self._meta_stack.setWantsLayer_(True)
        self._meta_stack.layer().setBackgroundColor_(C_MANTLE_CG)
        self._meta_stack.layer().setCornerRadius_(8)
        self._meta_stack.setEdgeInsets_(NSEdgeInsets(8, 12, 8, 12))

        self._res_label = NSTextField.labelWithString_("")
        self._res_label.setTextColor_(C_TEXT)
        self._res_label.setFont_(NSFont.systemFontOfSize_(12))
        self._res_label.setAlignment_(NSLeftTextAlignment)
        self._meta_stack.addView_inGravity_(self._res_label, NSStackViewGravityLeading)

        self._size_label = NSTextField.labelWithString_("")
        self._size_label.setTextColor_(C_TEXT)
        self._size_label.setFont_(NSFont.systemFontOfSize_(12))
        self._size_label.setAlignment_(NSLeftTextAlignment)
        self._meta_stack.addView_inGravity_(self._size_label, NSStackViewGravityLeading)

        self._views_label = NSTextField.labelWithString_("")
        self._views_label.setTextColor_(C_TEXT)
        self._views_label.setFont_(NSFont.systemFontOfSize_(12))
        self._views_label.setAlignment_(NSLeftTextAlignment)
        self._meta_stack.addView_inGravity_(self._views_label, NSStackViewGravityLeading)

        self._tags_label = NSTextField.labelWithString_("")
        self._tags_label.setTextColor_(C_OVERLAY)
        self._tags_label.setFont_(NSFont.systemFontOfSize_(11))
        self._tags_label.setAlignment_(NSLeftTextAlignment)
        self._tags_label.setLineBreakMode_(NSLineBreakByWordWrapping)
        self._tags_label.setPreferredMaxLayoutWidth_(500)
        self._meta_stack.addView_inGravity_(self._tags_label, NSStackViewGravityLeading)

        self._meta_stack.setHidden_(True)
        right.addView_inGravity_(self._meta_stack, NSStackViewGravityLeading)

        # Action buttons
        btn_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 32))
        btn_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        btn_bar.setSpacing_(8)
        btn_bar.setContentHuggingPriority_forOrientation_(999, 1)

        self._dl_btn = NSButton.buttonWithTitle_target_action_(
            "Download [Enter]", self, "doDownload:"
        )
        self._dl_btn.setBezelStyle_(NSBezelStyleRounded)
        self._dl_btn.setBezelColor_(C_GREEN)
        self._dl_btn.setContentTintColor_(C_GREEN)
        self._dl_btn.setEnabled_(False)
        btn_bar.addView_inGravity_(self._dl_btn, NSStackViewGravityCenter)

        self._open_btn = NSButton.buttonWithTitle_target_action_("Open URL [O]", self, "doOpenURL:")
        self._open_btn.setBezelStyle_(NSBezelStyleRounded)
        self._open_btn.setEnabled_(False)
        btn_bar.addView_inGravity_(self._open_btn, NSStackViewGravityCenter)

        self._dl_spinner = NSProgressIndicator.alloc().initWithFrame_(NSMakeRect(0, 0, 16, 16))
        self._dl_spinner.setStyle_(NSProgressIndicatorSpinningStyle)
        self._dl_spinner.setControlSize_(1)  # NSControlSizeSmall
        self._dl_spinner.setDisplayedWhenStopped_(False)
        btn_bar.addView_inGravity_(self._dl_spinner, NSStackViewGravityCenter)

        right.addView_inGravity_(btn_bar, NSStackViewGravityCenter)

        root.addSubview_(right)

        # ── Auto Layout ──
        root.addConstraints_(
            [
                # Search bar
                search_bar.topAnchor().constraintEqualToAnchor_constant_(root.topAnchor(), 8),
                search_bar.leadingAnchor().constraintEqualToAnchor_constant_(
                    root.leadingAnchor(), 12
                ),
                search_bar.trailingAnchor().constraintEqualToAnchor_constant_(
                    root.trailingAnchor(), -12
                ),
                search_bar.heightAnchor().constraintEqualToConstant_(32),
                # Left column
                left_col.topAnchor().constraintEqualToAnchor_constant_(
                    search_bar.bottomAnchor(), 8
                ),
                left_col.leadingAnchor().constraintEqualToAnchor_constant_(root.leadingAnchor(), 8),
                left_col.widthAnchor().constraintEqualToAnchor_multiplier_(root.widthAnchor(), 0.4),
                left_col.widthAnchor().constraintGreaterThanOrEqualToConstant_(300),
                left_col.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -8),
                # Right panel
                right.topAnchor().constraintEqualToAnchor_constant_(search_bar.bottomAnchor(), 8),
                right.leadingAnchor().constraintEqualToAnchor_constant_(
                    left_col.trailingAnchor(), 12
                ),
                right.trailingAnchor().constraintEqualToAnchor_constant_(
                    root.trailingAnchor(), -12
                ),
                right.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -8),
                # Preview fills right panel width
                self._preview.leadingAnchor().constraintEqualToAnchor_(right.leadingAnchor()),
                self._preview.trailingAnchor().constraintEqualToAnchor_(right.trailingAnchor()),
                # Placeholder centered in preview
                self._placeholder.centerXAnchor().constraintEqualToAnchor_(
                    self._preview.centerXAnchor()
                ),
                self._placeholder.centerYAnchor().constraintEqualToAnchor_(
                    self._preview.centerYAnchor()
                ),
            ]
        )

        return root

    # ── Search ──

    @objc.typedSelector(b"v@:@")
    def onSearchAction_(self, sender):
        """Immediate search on Enter or button click."""
        if self._debounce_timer is not None:
            self._debounce_timer.invalidate()
            self._debounce_timer = None
        self._do_search()

    @objc.typedSelector(b"v@:@")
    def onSortChanged_(self, sender):
        """Re-search when sort order changes."""
        if self._results:
            self._do_search()

    @objc.typedSelector(b"v@:@")
    def onLoadMore_(self, sender):
        """Load next page of results."""
        self._page += 1
        self._do_search(append=True)

    # NSSearchField delegate: debounce text changes
    def controlTextDidChange_(self, notification):
        if self._debounce_timer is not None:
            self._debounce_timer.invalidate()
        self._debounce_timer = (
            NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                0.5, self, "debounceSearch:", None, False
            )
        )

    @objc.typedSelector(b"v@:@")
    def debounceSearch_(self, timer):
        self._debounce_timer = None
        self._do_search()

    def _do_search(self, append: bool = False):
        if self._searching:
            return
        if not append:
            self._page = 1
            self._results.clear()

        self._searching = True
        self._spinner.startAnimation_(None)
        self._status_label.setStringValue_("Searching...")

        query = self._search_field.stringValue().strip()
        sort_idx = self._sort_popup.indexOfSelectedItem()
        sorting = SORT_KEYS[sort_idx] if 0 <= sort_idx < len(SORT_KEYS) else "toplist"
        mode = read_mode(self.config)
        page = self._page

        def _worker():
            try:
                results = asyncio.run(
                    self._client.search_with_meta(
                        query=query,
                        page=page,
                        purity=mode,
                        sorting=sorting,
                    )
                )
            except Exception:
                results = []
            wrapper = {"data": results, "append": append}
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "onResultsReady:", wrapper, False
            )

        threading.Thread(target=_worker, daemon=True).start()

    @objc.typedSelector(b"v@:@")
    def onResultsReady_(self, wrapper):
        data = wrapper["data"]
        append = wrapper["append"]

        self._searching = False
        self._spinner.stopAnimation_(None)

        if append:
            self._results.extend(data)
        else:
            self._results = data
            self._thumb_images.clear()

        self._cv.reloadData()

        n = len(self._results)
        self._status_label.setStringValue_(f"{n} result{'s' if n != 1 else ''}")
        self._load_more_btn.setHidden_(len(data) < 24)

        # Start loading thumbnails
        for item in data:
            thumb_url = item.get("thumbs", {}).get("small", "")
            wall_id = item.get("id", "")
            if thumb_url and wall_id:
                self._load_wallhaven_thumb(thumb_url, wall_id)

    # ── Thumbnail Loading ──

    def _load_wallhaven_thumb(self, url: str, wall_id: str):
        """Download and cache a Wallhaven thumbnail in the background."""
        cache_path = self._thumb_cache_dir / f"{wall_id}.jpg"

        def worker():
            try:
                if not cache_path.exists():
                    resp = self._sync_http.get(url)
                    resp.raise_for_status()
                    cache_path.write_bytes(resp.content)

                img = NSImage.alloc().initWithContentsOfFile_(str(cache_path))
                if img is None:
                    return

                # Crop to square and scale
                orig = img.size()
                side = min(orig.width, orig.height)
                thumb = NSImage.alloc().initWithSize_(NSMakeSize(THUMB_SIZE, THUMB_SIZE))
                thumb.lockFocus()
                img.drawInRect_fromRect_operation_fraction_(
                    NSMakeRect(0, 0, THUMB_SIZE, THUMB_SIZE),
                    NSMakeRect(
                        (orig.width - side) / 2,
                        (orig.height - side) / 2,
                        side,
                        side,
                    ),
                    NSCompositingOperationSourceOver,
                    1.0,
                )
                thumb.unlockFocus()

                result = {"wall_id": wall_id, "image": thumb}
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    "onThumbReady:", result, False
                )
            except Exception:
                pass

        self._thumb_pool.submit(worker)

    @objc.typedSelector(b"v@:@")
    def onThumbReady_(self, result):
        wall_id = result["wall_id"]
        image = result["image"]
        self._thumb_images[wall_id] = image

        # Find the index of this item and reload just that cell
        for i, item in enumerate(self._results):
            if item.get("id", "") == wall_id:
                ip_set = set()
                ip_set.add(NSIndexPath.indexPathForItem_inSection_(i, 0))
                self._cv.reloadItemsAtIndexPaths_(ip_set)
                break

    # ── NSCollectionViewDataSource ──

    def collectionView_numberOfItemsInSection_(self, cv, section):
        return len(self._results)

    def collectionView_itemForRepresentedObjectAtIndexPath_(self, cv, indexPath):
        cell = cv.makeItemWithIdentifier_forIndexPath_(ITEM_IDENTIFIER, indexPath)
        idx = indexPath.item()
        if 0 <= idx < len(self._results):
            item = self._results[idx]
            wall_id = item.get("id", "")
            res = item.get("resolution", "")
            thumb = self._thumb_images.get(wall_id)
            cell.configureWithImage_resolution_(thumb, res)
        return cell

    # ── NSCollectionViewDelegate ──

    def collectionView_didSelectItemsAtIndexPaths_(self, cv, indexPaths):
        for ip in indexPaths:
            idx = ip.item()
            if 0 <= idx < len(self._results):
                self._selected_item = self._results[idx]
                self._update_selection()

    def collectionView_didDeselectItemsAtIndexPaths_(self, cv, indexPaths):
        if not cv.selectionIndexPaths():
            self._selected_item = None
            self._update_selection()

    # ── Selection ──

    def _update_selection(self):
        item = self._selected_item
        if not item:
            self._preview.setImage_(None)
            self._placeholder.setHidden_(False)
            self._meta_stack.setHidden_(True)
            self._dl_btn.setEnabled_(False)
            self._open_btn.setEnabled_(False)
            return

        self._placeholder.setHidden_(True)
        self._dl_btn.setEnabled_(True)
        self._open_btn.setEnabled_(True)

        # Load large thumbnail in background
        large_url = item.get("thumbs", {}).get("large", "")
        wall_id = item.get("id", "")
        large_cache = self._thumb_cache_dir / f"{wall_id}_large.jpg"

        def _load_large():
            try:
                if not large_cache.exists():
                    resp = self._sync_http.get(large_url)
                    resp.raise_for_status()
                    large_cache.write_bytes(resp.content)
                img = NSImage.alloc().initWithContentsOfFile_(str(large_cache))
                if img:
                    result = {"image": img}
                    self.performSelectorOnMainThread_withObject_waitUntilDone_(
                        "onLargeThumbReady:", result, False
                    )
            except Exception:
                pass

        self._thumb_pool.submit(_load_large)

        # Update metadata
        res = item.get("resolution", "?")
        file_size = item.get("file_size", 0)
        views = item.get("views", 0)
        favs = item.get("favorites", 0)

        self._res_label.setStringValue_(f"Resolution: {res}")
        self._size_label.setStringValue_(f"Size: {format_size(file_size)}")
        self._views_label.setStringValue_(f"Views: {views:,}  |  Favs: {favs:,}")

        tag_names = extract_tag_names(item.get("tags", []))[:10]
        self._tags_label.setStringValue_(", ".join(tag_names) if tag_names else "")

        self._meta_stack.setHidden_(False)

    @objc.typedSelector(b"v@:@")
    def onLargeThumbReady_(self, result):
        image = result["image"]
        # Only update if the selection hasn't changed
        if self._selected_item is not None:
            self._preview.setImage_(image)
            fade_in(self._preview, 0.25)

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def doDownload_(self, sender):
        self._download_selected()

    @objc.typedSelector(b"v@:@")
    def doOpenURL_(self, sender):
        self._open_url()

    def _download_selected(self):
        item = self._selected_item
        if not item:
            return

        url = item.get("path", "")
        if not url:
            return

        filename = url.rsplit("/", 1)[-1]
        mode = read_mode(self.config)
        res = item.get("resolution", "1920x1080")
        w, h = (int(x) for x in res.split("x")) if "x" in res else (1920, 1080)
        orient = "portrait" if h > w else "landscape"
        dest_dir = pool_dir(self.config, mode, orient)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        # Check if already exists
        fav_dir = favorites_dir(self.config, mode, orient)
        if dest.exists() or (fav_dir / filename).exists():
            self._dl_btn.setTitle_("Already exists")
            self._schedule_button_reset()
            return

        if is_blacklisted(self.config, filename):
            self._dl_btn.setTitle_("Blacklisted")
            self._schedule_button_reset()
            return

        self._dl_btn.setEnabled_(False)
        self._dl_spinner.startAnimation_(None)

        def _worker():
            try:
                success = asyncio.run(self._client.download_image(url, dest))
                if success:
                    save_metadata(self.config, filename, item)
                    for m in self.config.monitors:
                        if m.orientation == orient:
                            resize_crop(dest, m.width, m.height)
                            break
                result = {"success": success}
            except Exception:
                result = {"success": False}
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "onDownloadDone:", result, False
            )

        threading.Thread(target=_worker, daemon=True).start()

    @objc.typedSelector(b"v@:@")
    def onDownloadDone_(self, result):
        self._dl_spinner.stopAnimation_(None)
        self._dl_btn.setEnabled_(True)
        if result["success"]:
            self._dl_btn.setTitle_("Downloaded!")
        else:
            self._dl_btn.setTitle_("Failed")
        self._schedule_button_reset()

    def _schedule_button_reset(self):
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            2.0, self, "resetDlButton:", None, False
        )

    @objc.typedSelector(b"v@:@")
    def resetDlButton_(self, timer):
        self._dl_btn.setTitle_("Download [Enter]")

    def _open_url(self):
        if self._selected_item:
            url = self._selected_item.get("url", "")
            if url:
                webbrowser.open(url)

    # ── Keyboard ──

    def handleKeyDown_(self, event) -> bool:
        chars = event.charactersIgnoringModifiers()
        if not chars:
            return False
        key = chars[0]
        if key == "\r":
            self._download_selected()
            return True
        if key == "o":
            self._open_url()
            return True
        if key == "/":
            self._search_field.becomeFirstResponder()
            return True
        return False

    # ── Cleanup ──

    def shutdown(self):
        self._thumb_pool.shutdown(wait=False)
        self._sync_http.close()
        if self._debounce_timer is not None:
            self._debounce_timer.invalidate()
            self._debounce_timer = None
