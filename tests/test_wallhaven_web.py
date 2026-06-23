from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from wayper.config import WayperConfig
from wayper.wallhaven_web import WallhavenWeb, _can_sync_favorites


class WallhavenWebTest(unittest.TestCase):
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
