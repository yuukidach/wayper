from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from wayper.backend.macos import MacOSBackend
from wayper.config import NO_TRANSITION


class FakeScreen:
    def __init__(self, display_id: str) -> None:
        self.display_id = display_id

    def deviceDescription(self) -> dict[str, str]:
        return {"NSScreenNumber": self.display_id}


def test_set_wallpaper_targets_only_requested_display(tmp_path: Path) -> None:
    first = FakeScreen("10")
    second = FakeScreen("20")
    workspace = MagicMock()
    workspace.desktopImageOptionsForScreen_.return_value = {"placement": "fill"}
    workspace.setDesktopImageURL_forScreen_options_error_.return_value = (True, None)
    image = tmp_path / "wallpaper.jpg"
    screens_api = MagicMock()
    screens_api.screens.return_value = [first, second]
    workspace_api = MagicMock()
    workspace_api.sharedWorkspace.return_value = workspace
    url_api = MagicMock()
    url_api.fileURLWithPath_.return_value = "file-url"

    with (
        patch("wayper.backend.macos._HAS_APPKIT", True),
        patch("wayper.backend.macos.NSScreen", screens_api, create=True),
        patch("wayper.backend.macos.NSWorkspace", workspace_api, create=True),
        patch("wayper.backend.macos.NSURL", url_api, create=True),
    ):
        MacOSBackend().set_wallpaper("20", image, NO_TRANSITION)

    url_api.fileURLWithPath_.assert_called_once_with(str(image.resolve()))
    workspace.desktopImageOptionsForScreen_.assert_called_once_with(second)
    workspace.setDesktopImageURL_forScreen_options_error_.assert_called_once_with(
        "file-url",
        second,
        {"placement": "fill"},
        None,
    )


def test_set_wallpaper_does_not_touch_other_displays_when_target_is_missing(
    tmp_path: Path,
) -> None:
    workspace = MagicMock()
    screens_api = MagicMock()
    screens_api.screens.return_value = [FakeScreen("10")]
    workspace_api = MagicMock()
    workspace_api.sharedWorkspace.return_value = workspace

    with (
        patch("wayper.backend.macos._HAS_APPKIT", True),
        patch("wayper.backend.macos.NSScreen", screens_api, create=True),
        patch("wayper.backend.macos.NSWorkspace", workspace_api, create=True),
    ):
        MacOSBackend().set_wallpaper("20", tmp_path / "wallpaper.jpg", NO_TRANSITION)

    workspace.setDesktopImageURL_forScreen_options_error_.assert_not_called()
