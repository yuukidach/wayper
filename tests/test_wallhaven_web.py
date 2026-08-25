from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from wayper.config import WayperConfig
from wayper.wallhaven_web import WallhavenWeb, _can_sync_favorites


class WallhavenWebTest(unittest.TestCase):
    def test_nodriver_login_fills_form_without_send_keys(self) -> None:
        tab = SimpleNamespace(
            select=AsyncMock(side_effect=[object(), object(), object()]),
            evaluate=AsyncMock(return_value=True),
            sleep=AsyncMock(),
            target=SimpleNamespace(url="https://wallhaven.cc/user/test-user"),
        )
        cookie = SimpleNamespace(
            name="session",
            value="cookie-value",
            domain="wallhaven.cc",
            path="/",
        )
        browser = SimpleNamespace(
            get=AsyncMock(return_value=tab),
            cookies=SimpleNamespace(get_all=AsyncMock(return_value=[cookie])),
            stop=MagicMock(),
        )
        nodriver = SimpleNamespace(start=AsyncMock(return_value=browser))
        client = WallhavenWeb("test-user", "test-password")
        try:
            with (
                patch.dict(sys.modules, {"nodriver": nodriver}),
                patch("wayper.wallhaven_web._find_chrome", return_value="/path/to/chrome"),
                patch.object(client, "_verify_session", return_value=True),
                patch.object(client, "_save_cookies") as save_cookies,
            ):
                logged_in = asyncio.run(client._nodriver_login_async())
        finally:
            client.close()

        self.assertTrue(logged_in)
        expression = tab.evaluate.await_args.args[0]
        self.assertIn("form.requestSubmit()", expression)
        self.assertEqual(tab.select.await_count, 3)
        self.assertEqual(tab.sleep.await_count, 1)
        save_cookies.assert_called_once_with()
        browser.stop.assert_called_once_with()

    def test_parse_fav_button_add_state_with_nested_add_link(self) -> None:
        html = """
        <meta name="csrf-token" content="token">
        <section id="fav-button" class="button add-button">
          <a class="item add-fav" href="/wallpaper/favorite/abc123">Add</a>
        </section>
        """

        client = WallhavenWeb("user", "pass")
        try:
            url, is_faved = client._parse_fav_button(html)
        finally:
            client.close()

        self.assertEqual(url, "https://wallhaven.cc/wallpaper/favorite/abc123")
        self.assertIs(is_faved, False)

    def test_parse_fav_button_favorited_state_with_direct_link(self) -> None:
        html = """
        <a class="button" href="https://wallhaven.cc/wallpaper/favorite/abc123"
           id="fav-button">
          Favorite
        </a>
        """

        client = WallhavenWeb("user", "pass")
        try:
            url, is_faved = client._parse_fav_button(html)
        finally:
            client.close()

        self.assertEqual(url, "https://wallhaven.cc/wallpaper/favorite/abc123")
        self.assertIs(is_faved, True)

    def test_parse_fav_button_ignores_favorites_count_overlay(self) -> None:
        html = """
        <dd>
          <a class="overlay-anchor" data-href="https://wallhaven.cc/wallpaper/fav/abc123">
            8
          </a>
        </dd>
        """

        client = WallhavenWeb("user", "pass")
        try:
            url, is_faved = client._parse_fav_button(html)
        finally:
            client.close()

        self.assertIsNone(url)
        self.assertIsNone(is_faved)

    def test_can_sync_favorites_with_password(self) -> None:
        config = WayperConfig(
            wallhaven_username="user",
            wallhaven_password="pass",
            download_dir=Path("/tmp/wayper-test"),
        )

        self.assertIs(_can_sync_favorites(config), True)

    def test_can_sync_favorites_requires_username(self) -> None:
        with patch("wayper.wallhaven_web.find_spec", return_value=object()):
            config = WayperConfig(download_dir=Path("/tmp/wayper-test"))

            self.assertIs(_can_sync_favorites(config), False)

    def test_can_sync_favorites_with_browser_cookie_support(self) -> None:
        with patch("wayper.wallhaven_web.find_spec", return_value=object()):
            config = WayperConfig(
                wallhaven_username="user",
                download_dir=Path("/tmp/wayper-test"),
            )

            self.assertIs(_can_sync_favorites(config), True)


if __name__ == "__main__":
    unittest.main()
