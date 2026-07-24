from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from wayper.catalog import ImageCatalog
from wayper.config import WayperConfig
from wayper.server.config_service import apply_config_updates, config_payload


class CatalogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.metadata = {
            "ban.jpg": {"tags": ["Woman", "portrait"], "purity": "sfw", "uploader": "Alice"},
            "keep.jpg": {"tags": ["women", "night"], "purity": "sfw", "uploader": "Alice"},
            "other.jpg": {"tags": ["night"], "purity": "nsfw", "uploader": "Bob"},
        }

    def test_catalog_normalizes_once_and_applies_purity_filter(self) -> None:
        catalog = ImageCatalog(self.metadata, {"ban.jpg"}, {"keep.jpg"}, purities={"sfw"})

        self.assertEqual(len(catalog), 2)
        self.assertEqual(catalog.tag_stats("WOMAN").banned, 1)
        self.assertEqual(catalog.tag_stats("women").kept, 1)
        self.assertEqual(catalog.combo_stats(["women", "night"]).kept, 1)
        self.assertEqual(catalog.combo_stats(["night"]).kept, 1)
        self.assertEqual(catalog.summary["total_favorites"], 1)

    def test_search_preserves_exact_and_suggestion_modes(self) -> None:
        catalog = ImageCatalog(self.metadata)

        self.assertEqual(catalog.search(tags=["woman"]).matches, ("ban.jpg", "keep.jpg"))
        self.assertEqual(catalog.search(uploader="alice").matches, ("ban.jpg", "keep.jpg"))
        result = catalog.search(query="night")
        self.assertEqual(result.matches, ("keep.jpg", "other.jpg"))
        self.assertIn("night", result.tag_suggestions)

    def test_empty_purity_filter_keeps_optional_filter_unrestricted(self) -> None:
        self.assertEqual(len(ImageCatalog(self.metadata, purities=[])), len(self.metadata))


class ConfigServiceTest(unittest.TestCase):
    def test_updates_are_normalized_and_payload_hides_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td), api_key="secret")
            target = Path(td) / "library"
            changes = apply_config_updates(
                config,
                {
                    "interval_min": 7,
                    "proxy": "  ",
                    "blacklist_ttl_days": -3,
                    "download_dir": str(target),
                    "wallhaven": {
                        "exclude_tags": ["Art", "art"],
                        "exclude_uploaders": ["Alice", "alice"],
                        "batch_size": 0,
                    },
                },
                resolve_download_dir=lambda value: Path(value),
            )

        self.assertTrue(changes.download_dir_changed)
        self.assertTrue(changes.exclude_tags_changed)
        self.assertTrue(changes.exclude_uploaders_changed)
        self.assertEqual(config.interval, 420)
        self.assertIsNone(config.proxy)
        self.assertEqual(config.blacklist_ttl_days, 0)
        self.assertEqual(config.wallhaven.exclude_tags, ["Art"])
        self.assertEqual(config.wallhaven.exclude_uploaders, ["Alice"])
        self.assertEqual(config.wallhaven.batch_size, 1)
        self.assertTrue(config_payload(config, {"sfw"})["has_api_key"])
        self.assertNotIn("api_key", config_payload(config, {"sfw"}))


if __name__ == "__main__":
    unittest.main()
