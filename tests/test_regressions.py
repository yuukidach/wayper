from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from wayper.config import MonitorConfig, WallhavenConfig, WayperConfig, load_config
from wayper.model_review import queue_model_review_item
from wayper.pool import hydrate_tag_details, load_metadata, pool_dir, save_metadata
from wayper.server.api import (
    ActionRequest,
    ModelReviewActionRequest,
    ModelReviewClearRequest,
    PreferenceFeedbackRequest,
    UnblockRequest,
    _readable_trash_image,
    app,
    ban_image_route,
    dislike_image_route,
    get_config_route,
    get_images_page,
    get_status,
    model_review_action_route,
    model_review_clear_route,
    model_review_route,
    preference_suggestion_feedback,
    preference_suggestions,
    remove_blocklist_entry,
    update_config_route,
)
from wayper.state import write_mode
from wayper.wallhaven import WallhavenClient


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.request = httpx.Request("GET", "https://wallhaven.test/search")
        self.response = httpx.Response(status_code, request=self.request)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "fake failure",
                request=self.request,
                response=self.response,
            )

    def json(self) -> dict:
        return self._payload


class _FakeAsyncClient:
    def __init__(self, pages: dict[int, _FakeResponse]) -> None:
        self.pages = pages

    async def get(self, _url: str, params: dict) -> _FakeResponse:
        return self.pages[int(params.get("page", 1))]

    async def aclose(self) -> None:
        pass


class RegressionTest(unittest.TestCase):
    def test_trash_permission_error_is_platform_neutral(self) -> None:
        config = WayperConfig()
        trashed = Path("/system-trash/image.jpg")

        with (
            patch("wayper.server.api.find_in_trash", return_value=trashed),
            patch("wayper.server.api.os.access", return_value=False),
            self.assertRaises(HTTPException) as error,
        ):
            _readable_trash_image(config, trashed.name)

        self.assertEqual(error.exception.status_code, 403)
        self.assertIn("system trash", error.exception.detail)
        self.assertNotIn("Full Disk Access", error.exception.detail)

    def test_image_page_exposes_orientation_and_portable_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "portrait" / "tall.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with patch("wayper.server.api.get_config", return_value=config):
                page = get_images_page(purity="sfw", orient="portrait")

        self.assertEqual(len(page.items), 1)
        self.assertEqual(page.items[0].path, "sfw/portrait/tall.jpg")
        self.assertEqual(page.items[0].orientation, "portrait")

    def test_wallhaven_search_keeps_smaller_originals_eligible(self) -> None:
        config = WayperConfig(
            monitors=[MonitorConfig("retina", 5120, 2880, "landscape")],
        )
        client = WallhavenClient(config)
        client.client.get = AsyncMock(
            return_value=_FakeResponse(200, {"data": [], "meta": {"last_page": 1}})
        )
        try:
            asyncio.run(client.search({"landscape"}, {"sfw"}))
        finally:
            asyncio.run(client.close())

        params = client.client.get.call_args.kwargs["params"]
        self.assertNotIn("atleast", params)

    def test_wallhaven_download_preserves_original_dimensions(self) -> None:
        from PIL import Image

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                monitors=[MonitorConfig("portrait", 144, 256, "portrait")],
                wallhaven=WallhavenConfig(batch_size=1),
            )
            item = {
                "id": "original",
                "path": "https://wallhaven.test/original.jpg",
                "favorites": 10,
                "purity": "sfw",
                "dimension_x": 1080,
                "dimension_y": 1920,
            }
            detail = {**item, "tags": [], "purity": "sfw", "category": "general"}
            client = WallhavenClient(config)
            client.search = AsyncMock(return_value=[item])
            client.wallpaper_info = AsyncMock(return_value=detail)

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (300, 400)).save(destination)
                return True

            client.download_image = AsyncMock(side_effect=download)
            try:
                asyncio.run(client.download_for({"portrait"}, {"sfw"}))
            finally:
                asyncio.run(client.close())

            destination = pool_dir(config, "sfw", "portrait") / "original.jpg"
            with Image.open(destination) as downloaded:
                dimensions = downloaded.size

        self.assertEqual(dimensions, (300, 400))

    def test_wallhaven_search_omits_resolution_without_matching_monitor(self) -> None:
        config = WayperConfig(
            monitors=[MonitorConfig("portrait", 2880, 5120, "portrait")],
        )
        client = WallhavenClient(config)
        client.client.get = AsyncMock(
            return_value=_FakeResponse(200, {"data": [], "meta": {"last_page": 1}})
        )
        try:
            asyncio.run(client.search({"landscape"}, {"sfw"}))
        finally:
            asyncio.run(client.close())

        params = client.client.get.call_args.kwargs["params"]
        self.assertNotIn("atleast", params)

    def test_wallhaven_auth_uses_header_instead_of_query_string(self) -> None:
        config = WayperConfig(api_key="secret-api-key")
        client = WallhavenClient(config)
        try:
            self.assertEqual(client.client.headers["X-API-Key"], "secret-api-key")
            client.client.get = AsyncMock(
                return_value=_FakeResponse(200, {"data": {"id": "abc123"}})
            )
            detail = asyncio.run(client.wallpaper_info("abc123", retries=0))
        finally:
            asyncio.run(client.close())

        self.assertEqual(detail["id"], "abc123")
        self.assertNotIn("params", client.client.get.call_args.kwargs)

    def test_blocklist_finds_recoverable_images_in_download_volume_trash(self) -> None:
        from wayper.server.api import _blocklist_payload
        from wayper.trash import find_in_trash, find_many_in_trash, restore_from_trash

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            mount = root / "external"
            download_dir = mount / "wallpapers"
            volume_trash = mount / ".Trash-1000" / "files"
            volume_info = volume_trash.parent / "info"
            download_dir.mkdir(parents=True)
            volume_trash.mkdir(parents=True)
            volume_info.mkdir()
            config = WayperConfig(download_dir=download_dir)
            config.blacklist_file.write_text("100 disliked.jpg\n101 banned.png\n")
            for filename in ("disliked.jpg", "banned.png"):
                (volume_trash / filename).touch()
                (volume_info / f"{filename}.trashinfo").touch()

            with (
                patch(
                    "wayper.trash._device_id",
                    side_effect=lambda path: 2 if mount in path.parents else 1,
                ),
                patch("wayper.trash.sys.platform", "linux"),
                patch("wayper.trash._mount_point", return_value=mount),
                patch("wayper.trash.os.getuid", return_value=1000, create=True),
            ):
                found = find_many_in_trash(config, {"disliked.jpg", "banned.png"})
                payload = _blocklist_payload(config)
                self.assertEqual(
                    find_in_trash(config, "disliked.jpg"),
                    volume_trash / "disliked.jpg",
                )
                restored = restore_from_trash(config, "disliked.jpg", download_dir / "restored")
                self.assertEqual(set(found), {"disliked.jpg", "banned.png"})
                self.assertEqual(payload["recoverable_count"], 2)
                self.assertTrue(all(entry["recoverable"] for entry in payload["entries"]))
                self.assertEqual(restored, download_dir / "restored" / "disliked.jpg")
                self.assertTrue(restored.exists())
                self.assertFalse((volume_info / "disliked.jpg.trashinfo").exists())

    def test_status_counts_follow_selected_monitor_orientation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                monitors=[
                    MonitorConfig("landscape-monitor", 1920, 1080, "landscape"),
                    MonitorConfig("portrait-monitor", 1080, 1920, "portrait"),
                ],
            )
            write_mode(config, {"sfw"})
            for orientation, suffix in (("landscape", "wide"), ("portrait", "tall")):
                pool = config.download_dir / "sfw" / orientation
                favorite = config.download_dir / "favorites" / "sfw" / orientation
                pool.mkdir(parents=True)
                favorite.mkdir(parents=True)
                (pool / f"{suffix}.jpg").touch()
                (favorite / f"{suffix}.jpg").touch()
                review = config.model_review_dir / "sfw" / orientation / f"{suffix}.jpg"
                review.parent.mkdir(parents=True)
                review.touch()
                queue_model_review_item(
                    config,
                    review,
                    purity="sfw",
                    orientation=orientation,
                    prediction={"probability": 0.99},
                    strategy="model",
                )

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch(
                    "wayper.server.api.rotation_service.snapshot",
                    return_value={"auto_rotation": True, "rotation_paused": False},
                ),
            ):
                landscape = get_status(monitor="landscape-monitor", include_recoverable=False)
                portrait = get_status(monitor="portrait-monitor", include_recoverable=False)
                unscoped = get_status(include_recoverable=False)

        self.assertEqual(landscape.monitor, "landscape-monitor")
        self.assertEqual(landscape.orientation, "landscape")
        self.assertEqual((landscape.pool_count, landscape.favorites_count), (1, 1))
        self.assertEqual(landscape.model_review_count, 1)
        self.assertEqual(portrait.monitor, "portrait-monitor")
        self.assertEqual(portrait.orientation, "portrait")
        self.assertEqual((portrait.pool_count, portrait.favorites_count), (1, 1))
        self.assertEqual(portrait.model_review_count, 1)
        self.assertIsNone(unscoped.monitor)
        self.assertEqual((unscoped.pool_count, unscoped.favorites_count), (2, 2))
        self.assertEqual(unscoped.model_review_count, 2)

    def test_unscoped_status_skips_unused_learning_snapshot(self) -> None:
        config = WayperConfig()
        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch(
                "wayper.server.api.rotation_service.snapshot",
                return_value={"auto_rotation": True, "rotation_paused": False},
            ),
            patch(
                "wayper.model_review.model_review_status",
                return_value={"pending_count": 0, "ready": True},
            ) as review_status,
        ):
            response = get_status(include_recoverable=False)

        self.assertTrue(response.model_filter_ready)
        review_status.assert_called_once_with(
            config,
            purities=None,
            orientation=None,
            include_learning=False,
        )

    def test_config_route_exposes_and_updates_wallhaven_batch_size(self) -> None:
        config = WayperConfig(wallhaven=WallhavenConfig(batch_size=7))

        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch("wayper.server.api.save_config") as save_config,
            patch("wayper.server.api.rotation_service.request_reload"),
            patch("wayper.server.api._cached_config", None),
            patch("wayper.server.api._cached_mtime", 0),
        ):
            response = get_config_route()
            update_config_route({"wallhaven": {"batch_size": 9}})

        self.assertEqual(response["wallhaven"]["batch_size"], 7)
        self.assertEqual(config.wallhaven.batch_size, 9)
        save_config.assert_called_once_with(config)

    def test_config_route_exposes_and_normalizes_filter_strategy(self) -> None:
        config = WayperConfig(wallhaven=WallhavenConfig(filter_strategy="rules"))

        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch("wayper.server.api.save_config"),
            patch("wayper.server.api.rotation_service.request_reload"),
            patch("wayper.server.api._cached_config", None),
            patch("wayper.server.api._cached_mtime", 0),
        ):
            update_config_route({"wallhaven": {"filter_mode": "both"}})
            response = get_config_route()

        self.assertEqual(config.wallhaven.filter_strategy, "rules+model")
        self.assertEqual(response["wallhaven"]["filter_strategy"], "rules+model")

    def test_config_load_clamps_wallhaven_batch_size_to_one(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.toml"
            path.write_text("[wallhaven]\nbatch_size = -2\n")

            config = load_config(path)

        self.assertEqual(config.wallhaven.batch_size, 1)

    def test_wallhaven_max_favorites_treats_failed_deep_pages_as_upper_bound(self) -> None:
        config = WayperConfig(
            api_key="test",
            wallhaven=WallhavenConfig(min_favorites=10),
        )
        client = WallhavenClient(config)
        asyncio.run(client.close())
        client.client = _FakeAsyncClient(
            {
                3: _FakeResponse(200, {"data": [{"favorites": 12}]}),
                4: _FakeResponse(200, {"data": [{"favorites": 9}]}),
                5: _FakeResponse(500),
            }
        )

        try:
            max_page = asyncio.run(client._max_favorites_page({}, 8, [{"favorites": 20}]))
        finally:
            asyncio.run(client.close())

        self.assertEqual(max_page, 3)

    def test_model_filter_fails_open_without_semantic_calibration(self) -> None:
        from wayper.model_review import list_model_review_items
        from wayper.preference_model import PreferenceModel, save_preference_model

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(filter_strategy="model", batch_size=1),
            )
            model = PreferenceModel(
                bias=-2.0,
                prior_log_odds=0.0,
                tag_weights={"likely block": 3.0},
                combo_weights={},
                context_weights={},
                trained_at="test",
                training_summary={},
                combo_min_support=20,
                max_combo_features=0,
            )
            save_preference_model(model, config.preference_model_file)
            item = {
                "id": "candidate",
                "path": "https://wallhaven.test/candidate.jpg",
                "favorites": 10,
                "purity": "sfw",
                "dimension_x": 1920,
                "dimension_y": 1080,
            }
            detail = {
                **item,
                "tags": [{"name": "likely block"}],
                "purity": "sfw",
                "category": "general",
            }
            client = WallhavenClient(config)
            client.search = AsyncMock(return_value=[item])
            client.wallpaper_info = AsyncMock(return_value=detail)

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"candidate")
                return True

            client.download_image = AsyncMock(side_effect=download)
            try:
                asyncio.run(client.download_for({"landscape"}, {"sfw"}))
            finally:
                asyncio.run(client.close())

            held = list_model_review_items(config)
            downloaded = (config.download_dir / "sfw" / "landscape" / "candidate.jpg").exists()

        self.assertEqual(held, [])
        self.assertTrue(downloaded)

    def test_model_filter_scoring_runs_outside_the_api_event_loop(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(filter_strategy="model", batch_size=1),
            )
            item = {
                "id": "candidate",
                "path": "https://wallhaven.test/candidate.jpg",
                "favorites": 10,
                "purity": "sfw",
                "dimension_x": 1920,
                "dimension_y": 1080,
            }
            detail = {**item, "tags": [{"name": "forest"}], "purity": "sfw"}
            client = WallhavenClient(config)
            client.search = AsyncMock(return_value=[item])
            client.wallpaper_info = AsyncMock(return_value=detail)
            score_threads: list[int] = []
            event_loop_thread = threading.get_ident()

            def score(_model, _metadata):
                score_threads.append(threading.get_ident())
                return False, None

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"candidate")
                return True

            client.download_image = AsyncMock(side_effect=download)
            try:
                with patch("wayper.preference_model.auto_filter_prediction", side_effect=score):
                    asyncio.run(
                        client.download_for(
                            {"landscape"},
                            {"sfw"},
                            model_filter_context=(object(), True, {}),
                        )
                    )
            finally:
                asyncio.run(client.close())

        self.assertEqual(len(score_threads), 1)
        self.assertNotEqual(score_threads[0], event_loop_thread)

    def test_background_download_uses_one_combined_batch_and_model_context(self) -> None:
        from wayper.rotation import _download_pending

        shared_context = (object(), True, {"ready": True})

        class FakeClient:
            def __init__(self) -> None:
                self.context_loads = 0
                self.received: list[object] = []

            def _model_filter_context(self):
                self.context_loads += 1
                return shared_context

            async def download_for(self, orientation, purity, *, model_filter_context):
                self.orientation = orientation
                self.purity = purity
                self.received.append(model_filter_context)

        config = WayperConfig(
            monitors=[
                MonitorConfig("wide", 1920, 1080, "landscape"),
                MonitorConfig("tall", 1080, 1920, "portrait"),
            ]
        )
        client = FakeClient()
        with patch("wayper.rotation.should_download", return_value=True):
            asyncio.run(_download_pending(client, config, {"sfw"}))

        self.assertEqual(client.context_loads, 1)
        self.assertEqual(len(client.received), 1)
        self.assertEqual(client.orientation, {"landscape", "portrait"})
        self.assertEqual(client.purity, {"sfw"})
        self.assertTrue(all(context is shared_context for context in client.received))

    def test_wallhaven_combines_search_scope(self) -> None:
        config = WayperConfig()
        client = WallhavenClient(config)
        client.client.get = AsyncMock(
            return_value=_FakeResponse(200, {"data": [], "meta": {"last_page": 1}})
        )
        try:
            asyncio.run(client.search({"portrait", "landscape"}, {"nsfw", "sfw"}))
        finally:
            asyncio.run(client.close())

        params = client.client.get.call_args.kwargs["params"]
        self.assertEqual(params["ratios"], "landscape,portrait")
        self.assertEqual(params["purity"], "101")

    def test_combined_download_batch_size_is_global(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(batch_size=2),
            )
            items = [
                {
                    "id": f"item-{index}",
                    "path": f"https://wallhaven.test/item-{index}.jpg",
                    "favorites": 10,
                    "purity": purity,
                    "dimension_x": width,
                    "dimension_y": height,
                }
                for index, (purity, width, height) in enumerate(
                    [
                        ("sfw", 1920, 1080),
                        ("nsfw", 1080, 1920),
                        ("sfw", 1080, 1920),
                        ("nsfw", 1920, 1080),
                    ]
                )
            ]
            client = WallhavenClient(config)
            client.search = AsyncMock(return_value=items)
            client.wallpaper_info = AsyncMock(
                side_effect=lambda item_id: next(item for item in items if item["id"] == item_id)
            )

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"candidate")
                return True

            client.download_image = AsyncMock(side_effect=download)
            try:
                asyncio.run(
                    client.download_for(
                        {"landscape", "portrait"},
                        {"sfw", "nsfw"},
                    )
                )
            finally:
                asyncio.run(client.close())

            downloaded = [
                path for path in config.download_dir.rglob("*.jpg") if "favorites" not in path.parts
            ]

        self.assertEqual(client.search.await_count, 1)
        self.assertEqual(client.wallpaper_info.await_count, 2)
        self.assertEqual(client.download_image.await_count, 2)
        self.assertEqual(len(downloaded), 2)

    def test_remote_favorite_fetches_complete_details_before_saving(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                api_key="test",
                wallhaven_username="tester",
                monitors=[],
            )
            listing = {
                "id": "abc123",
                "path": "https://wallhaven.test/wallhaven-abc123.jpg",
                "purity": "sfw",
                "resolution": "1920x1080",
            }
            detail = {
                **listing,
                "tags": [{"id": 5, "name": "forest", "category": "Nature"}],
                "uploader": {"username": "artist"},
            }
            client = WallhavenClient(config)

            async def get(url: str, params: dict | None = None) -> _FakeResponse:
                del params
                if url.endswith("/collections"):
                    return _FakeResponse(200, {"data": [{"id": 1}]})
                return _FakeResponse(
                    200,
                    {"data": [listing], "meta": {"last_page": 1}},
                )

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"favorite")
                return True

            client.client.get = AsyncMock(side_effect=get)
            client.wallpaper_info = AsyncMock(return_value=detail)
            client.download_image = AsyncMock(side_effect=download)
            try:
                synced, _ = asyncio.run(client.sync_remote_favorites())
            finally:
                asyncio.run(client.close())
            record = load_metadata(config)["wallhaven-abc123.jpg"]

        self.assertEqual(synced, 1)
        self.assertEqual(record["tags"], ["forest"])
        self.assertEqual(record["tag_details"][0]["category"], "Nature")
        self.assertTrue(record["metadata_complete"])

    def test_metadata_load_tolerates_trailing_data_and_save_repairs_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.metadata_file.write_text('{"old.jpg": {"tags": ["a"]}}\n trailing junk')

            self.assertEqual(load_metadata(config)["old.jpg"]["tags"], ["a"])

            save_metadata(
                config,
                "new.jpg",
                {
                    "id": "new",
                    "short_url": "https://whvn.cc/new",
                    "dimension_x": 1920,
                    "dimension_y": 1080,
                    "path": "https://wallhaven.test/new.jpg",
                    "thumbs": {"small": "https://wallhaven.test/new-small.jpg"},
                    "future_api_field": {"preserved": True},
                    "tags": [
                        {
                            "id": 7,
                            "name": "b",
                            "alias": "bee",
                            "category_id": 3,
                            "category": "Letters",
                            "purity": "sfw",
                        }
                    ],
                    "uploader": {"username": "user", "group": "User"},
                },
                complete=True,
                fetched_at=123,
            )

            repaired = json.loads(config.metadata_file.read_text())
            self.assertIn("old.jpg", repaired)
            self.assertEqual(repaired["new.jpg"]["tags"], ["b"])
            self.assertEqual(repaired["new.jpg"]["tag_details"][0]["alias"], "bee")
            self.assertEqual(repaired["new.jpg"]["uploader"], "user")
            self.assertEqual(repaired["new.jpg"]["uploader_details"]["group"], "User")
            self.assertEqual(repaired["new.jpg"]["dimension_x"], 1920)
            self.assertEqual(
                repaired["new.jpg"]["thumbs"]["small"], ("https://wallhaven.test/new-small.jpg")
            )
            self.assertTrue(repaired["new.jpg"]["metadata_complete"])
            self.assertTrue(repaired["new.jpg"]["tag_details_complete"])
            self.assertTrue(repaired["new.jpg"]["future_api_field"]["preserved"])
            self.assertEqual(repaired["new.jpg"]["metadata_fetched_at"], 123)

    def test_metadata_backfill_repairs_live_records_and_is_resumable(self) -> None:
        from wayper.core import do_backfill_metadata

        class FakeWallhavenClient:
            calls: list[str] = []

            def __init__(self, _config: WayperConfig) -> None:
                pass

            async def wallpaper_info(self, wallpaper_id: str, *, retries: int = 2) -> dict:
                self.calls.append(wallpaper_id)
                return {
                    "id": wallpaper_id,
                    "tags": [{"id": 1, "name": "forest", "category": "Nature"}],
                    "uploader": {"username": "artist"},
                }

            async def close(self) -> None:
                pass

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "wallhaven-abc123.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            config.metadata_file.write_text(json.dumps({image.name: {"id": "abc123", "tags": []}}))

            with patch("wayper.wallhaven.WallhavenClient", FakeWallhavenClient):
                first = asyncio.run(
                    do_backfill_metadata(
                        config,
                        missing_tags_only=True,
                        delay_seconds=0,
                    )
                )
                second = asyncio.run(
                    do_backfill_metadata(
                        config,
                        missing_tags_only=True,
                        delay_seconds=0,
                    )
                )

            record = load_metadata(config)[image.name]

        self.assertEqual(FakeWallhavenClient.calls, ["abc123"])
        self.assertEqual(first.extra["updated"], 1)
        self.assertEqual(second.extra["targeted"], 0)
        self.assertEqual(record["tags"], ["forest"])
        self.assertTrue(record["metadata_complete"])

    def test_metadata_hydration_propagates_known_tag_objects(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.metadata_file.write_text(
                json.dumps(
                    {
                        "complete.jpg": {
                            "tags": ["Forest"],
                            "tag_details": [
                                {
                                    "id": 7,
                                    "name": "Forest",
                                    "alias": "woodland",
                                    "category": "Nature",
                                }
                            ],
                        },
                        "legacy.jpg": {"tags": ["forest", "unknown"]},
                    }
                )
            )

            result = hydrate_tag_details(config)
            metadata = load_metadata(config)

        self.assertEqual(result["known_tags"], 1)
        self.assertEqual(metadata["legacy.jpg"]["tag_details"][0]["alias"], "woodland")
        self.assertFalse(metadata["legacy.jpg"]["tag_details_complete"])
        self.assertTrue(metadata["complete.jpg"]["tag_details_complete"])

    def test_metadata_backfill_records_unavailable_remote_images(self) -> None:
        from wayper.core import do_backfill_metadata, metadata_backfill_status

        class MissingWallhavenClient:
            def __init__(self, _config: WayperConfig) -> None:
                pass

            async def wallpaper_info(self, _wallpaper_id: str, *, retries: int = 2) -> dict:
                return {}

            async def close(self) -> None:
                pass

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "wallhaven-gone12.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with patch("wayper.wallhaven.WallhavenClient", MissingWallhavenClient):
                result = asyncio.run(do_backfill_metadata(config, delay_seconds=0))

            record = load_metadata(config)[image.name]
            status = metadata_backfill_status(config)

        self.assertEqual(result.extra["failed"], 1)
        self.assertEqual(result.extra["remaining"], 1)
        self.assertTrue(record["metadata_unavailable"])
        self.assertEqual(record["metadata_error"], "unavailable_or_request_failed")
        self.assertEqual(status["unavailable_records"], 1)

    def test_trash_routes_support_head_for_permission_probe(self) -> None:
        methods_by_path: dict[str, set[str]] = {}
        for route in app.routes:
            path = getattr(route, "path", "")
            methods = getattr(route, "methods", set()) or set()
            methods_by_path.setdefault(path, set()).update(methods)

        self.assertIn("HEAD", methods_by_path["/trash/{filename}"])
        self.assertIn("HEAD", methods_by_path["/trash-thumbnails/{filename}"])
        self.assertIn("GET", methods_by_path["/previews/{path:path}"])

    def test_review_preview_bounds_portrait_height(self) -> None:
        from PIL import Image

        from wayper.image import generate_thumbnail

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "portrait.jpg"
            Image.new("RGB", (1000, 3000), "navy").save(source, quality=80)
            preview = generate_thumbnail(
                source,
                root / "previews",
                max_width=1920,
                max_height=1920,
            )
            self.assertIsNotNone(preview)
            assert preview is not None
            with Image.open(preview) as image:
                size = image.size

        self.assertEqual(size, (640, 1920))

    def test_do_next_records_last_wallpaper_change(self) -> None:
        from wayper.core import do_next
        from wayper.state import read_last_wallpaper_change

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                monitors=[MonitorConfig("main", 1920, 1080, "landscape")],
            )
            image = config.download_dir / "sfw" / "landscape" / "next.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with (
                patch("wayper.core.pick_next", return_value=image),
                patch("wayper.core.set_wallpaper") as set_wallpaper,
                patch("wayper.state.time.time", return_value=1234.5),
            ):
                result = do_next(config, "main")

            self.assertTrue(result.ok)
            set_wallpaper.assert_called_once_with("main", image, config.transition)
            self.assertEqual(read_last_wallpaper_change(config), 1234.5)

    def test_seconds_until_next_rotation_uses_last_wallpaper_change(self) -> None:
        from wayper.rotation import seconds_until_next_rotation
        from wayper.state import record_wallpaper_change

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td), interval=300)
            record_wallpaper_change(config, when=1000.0)

            self.assertEqual(seconds_until_next_rotation(config, now=1175.0), 125.0)
            self.assertEqual(seconds_until_next_rotation(config, now=1400.0), 0.0)
            self.assertEqual(seconds_until_next_rotation(config, now=900.0), 300.0)

    def test_preference_suggestion_routes_are_review_only_and_record_keep_feedback(self) -> None:
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with patch("wayper.server.api.get_config", return_value=config):
                untrained = preference_suggestions(purity="sfw", orient="landscape")
                with patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    return_value={"items": [{"path": "sfw/landscape/candidate.jpg"}]},
                ):
                    response = preference_suggestion_feedback(
                        PreferenceFeedbackRequest(path="sfw/landscape/candidate.jpg", action="keep")
                    )

            feedback = load_preference_feedback(config)

        self.assertEqual(untrained["status"], "untrained")
        self.assertEqual(untrained["items"], [])
        self.assertEqual(response["status"], "ok")
        self.assertEqual(feedback["revision"], 1)
        self.assertEqual(feedback["events"][0]["action"], "keep")
        self.assertEqual(feedback["events"][0]["context"], "model_review")

    def test_preference_suggestion_route_caches_unchanged_ranking_state(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            ranked = {
                "status": "ready",
                "items": [{"path": "sfw/landscape/candidate.jpg"}],
            }

            def build_ranked(*_args, **_kwargs):
                return {
                    "status": ranked["status"],
                    "items": [dict(item) for item in ranked["items"]],
                }

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.server.api._get_metadata", return_value={}),
                patch(
                    "wayper.server.api._preference_learning_payload",
                    return_value={"status": "ready", "due": False},
                ),
                patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    side_effect=build_ranked,
                ) as build,
            ):
                first = preference_suggestions(purity="sfw", orient="landscape")
                first["items"].clear()
                second = preference_suggestions(purity="sfw", orient="landscape")
                config.metadata_file.write_text("{}")
                third = preference_suggestions(purity="sfw", orient="landscape")

        self.assertEqual(build.call_count, 2)
        self.assertEqual(len(second["items"]), 1)
        self.assertEqual(len(third["items"]), 1)

    def test_preference_suggestion_route_coalesces_same_scope(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            build_started = threading.Event()
            release_build = threading.Event()

            def build_ranked(*_args, **_kwargs):
                build_started.set()
                self.assertTrue(release_build.wait(timeout=2))
                return {"status": "ready", "items": []}

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.server.api._get_metadata", return_value={}),
                patch(
                    "wayper.server.api._preference_learning_payload",
                    return_value={"status": "ready", "due": False},
                ),
                patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    side_effect=build_ranked,
                ) as build,
                ThreadPoolExecutor(max_workers=2) as executor,
            ):
                first = executor.submit(
                    preference_suggestions,
                    purity="sfw",
                    orient="portrait",
                    limit=0,
                )
                self.assertTrue(build_started.wait(timeout=2))
                second = executor.submit(
                    preference_suggestions,
                    purity="sfw",
                    orient="portrait",
                    limit=0,
                )
                release_build.set()
                self.assertEqual(first.result(timeout=2)["status"], "ready")
                self.assertEqual(second.result(timeout=2)["status"], "ready")

        self.assertEqual(build.call_count, 1)

    def test_automatic_model_review_keep_moves_quarantine_to_pool_and_records_label(self) -> None:
        from wayper.model_review import queue_model_review_item
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(filter_strategy="model"),
            )
            image = config.model_review_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            queue_model_review_item(
                config,
                image,
                purity="sfw",
                orientation="landscape",
                prediction={"probability": 0.99, "threshold": 0.98},
                strategy="model",
            )

            with patch("wayper.server.api.get_config", return_value=config):
                pending = model_review_route(purity="sfw", orient="landscape")
                response = model_review_action_route(
                    ModelReviewActionRequest(
                        path=".model-review/sfw/landscape/candidate.jpg",
                        action="keep",
                    )
                )

            feedback = load_preference_feedback(config)

        self.assertEqual(len(pending["items"]), 1)
        self.assertTrue(pending["items"][0]["auto_filtered"])
        self.assertEqual(response["review"]["new_path"], "sfw/landscape/candidate.jpg")
        self.assertEqual(feedback["events"][0]["action"], "keep")
        self.assertEqual(feedback["events"][0]["source"], "model_filter")

    def test_clear_model_review_filters_scope_without_preference_labels(self) -> None:
        from wayper.model_review import (
            filtered_model_review_filenames,
            load_model_review_state,
            pending_model_review_count,
            queue_model_review_item,
        )
        from wayper.pool import list_blacklist, save_metadata_batch
        from wayper.preference_model import (
            _bootstrap_historical_preference_bans,
            collect_preference_training_snapshot,
            load_preference_feedback,
            load_preference_historical_bans,
        )

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            paths = []
            for orientation, name in (
                ("landscape", "first.jpg"),
                ("landscape", "second.jpg"),
                ("portrait", "portrait.jpg"),
            ):
                image = config.model_review_dir / "sfw" / orientation / name
                image.parent.mkdir(parents=True, exist_ok=True)
                image.touch()
                paths.append(image)
                queue_model_review_item(
                    config,
                    image,
                    purity="sfw",
                    orientation=orientation,
                    prediction={"probability": 0.99},
                    strategy="model",
                )
            save_metadata_batch(
                config,
                {image.name: {"tags": [image.stem], "downloaded_at": 100} for image in paths},
            )

            def fake_trash(_config: WayperConfig, image: Path) -> None:
                image.unlink()

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.model_review._trash_file", side_effect=fake_trash) as trash,
                patch("wayper.preference_model.schedule_preference_model_retrain") as retrain,
            ):
                response = model_review_clear_route(
                    ModelReviewClearRequest(purities=["sfw"], orientation="landscape")
                )

            state = load_model_review_state(config)
            records = state["items"]
            feedback = load_preference_feedback(config)
            _bootstrap_historical_preference_bans(config)
            historical_bans = load_preference_historical_bans(config)
            snapshot = collect_preference_training_snapshot(config)
            blacklist = {filename for _, filename in list_blacklist(config)}
            neutral_filters = filtered_model_review_filenames(config)
            pending_count = pending_model_review_count(config)

        self.assertEqual(response["cleared_count"], 2)
        self.assertEqual(response["failed_count"], 0)
        self.assertEqual(response["remaining_count"], 0)
        self.assertEqual(trash.call_count, 2)
        retrain.assert_not_called()
        self.assertEqual(feedback["revision"], 0)
        self.assertEqual(historical_bans, {})
        self.assertEqual(blacklist, {"first.jpg", "second.jpg"})
        self.assertEqual(neutral_filters, {"first.jpg", "second.jpg"})
        self.assertEqual(
            {record["status"] for record in records.values()},
            {"filter", "pending"},
        )
        self.assertEqual(pending_count, 1)
        self.assertNotIn("first.jpg", {example.filename for example in snapshot.examples})
        self.assertNotIn("second.jpg", {example.filename for example in snapshot.examples})

    def test_model_review_queue_keeps_same_named_files_and_scopes_counts(self) -> None:
        from wayper.model_review import (
            list_model_review_items,
            pending_model_review_count,
            queue_model_review_item,
        )

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            for purity, orientation in (("sfw", "landscape"), ("nsfw", "portrait")):
                image = config.model_review_dir / purity / orientation / "same.jpg"
                image.parent.mkdir(parents=True)
                image.touch()
                queue_model_review_item(
                    config,
                    image,
                    purity=purity,
                    orientation=orientation,
                    prediction={"probability": 0.99},
                    strategy="model",
                )

            self.assertEqual(pending_model_review_count(config), 2)
            self.assertEqual(
                pending_model_review_count(config, purities=("sfw",)),
                1,
            )
            self.assertEqual(
                pending_model_review_count(config, orientation="portrait"),
                1,
            )
            self.assertEqual(
                {item["path"] for item in list_model_review_items(config)},
                {
                    ".model-review/sfw/landscape/same.jpg",
                    ".model-review/nsfw/portrait/same.jpg",
                },
            )

    def test_preference_keep_feedback_rejects_non_candidates_and_unblock_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            config.blacklist_file.write_text("100 candidate.jpg\n")

            with patch("wayper.server.api.get_config", return_value=config):
                with self.assertRaises(HTTPException) as candidate_error:
                    preference_suggestion_feedback(
                        PreferenceFeedbackRequest(path="sfw/landscape/candidate.jpg", action="keep")
                    )
                with self.assertRaises(HTTPException) as traversal_error:
                    remove_blocklist_entry(UnblockRequest(filename="../candidate.jpg"))
                unchanged = remove_blocklist_entry(UnblockRequest(filename="missing.jpg"))

            from wayper.preference_model import load_preference_feedback

            feedback = load_preference_feedback(config)

        self.assertEqual(candidate_error.exception.status_code, 409)
        self.assertEqual(traversal_error.exception.status_code, 400)
        self.assertFalse(unchanged["removed"])
        self.assertEqual(feedback["events"], [])

    def test_model_review_ban_passes_server_observed_context_to_core(self) -> None:
        from wayper.core import CoreResult

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            result = CoreResult(action="ban", image=image, extra={"replacement_images": {}})

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch(
                    "wayper.server.api._model_review_feedback",
                    return_value={
                        "schema_version": 2,
                        "feature_score": -0.25,
                        "review_score": 1.25,
                        "neighbor_preference_gap": 1.0,
                        "rank": 1,
                    },
                ),
                patch("wayper.server.api.do_ban", return_value=result) as do_ban,
            ):
                response = ban_image_route(
                    ActionRequest(
                        image_path="sfw/landscape/candidate.jpg",
                        preference_context="model_review",
                    )
                )

        self.assertEqual(response["status"], "ok")
        kwargs = do_ban.call_args.kwargs
        self.assertEqual(kwargs["preference_context"], "model_review")
        self.assertEqual(kwargs["preference_model"]["feature_score"], -0.25)
        self.assertEqual(kwargs["preference_model"]["review_score"], 1.25)

    def test_manual_dislike_records_distinct_feedback_and_blocks_exact_image(self) -> None:
        from wayper.core import do_ban, do_dislike
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "missed.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            ordinary_ban = image.with_name("tired.jpg")
            review_dislike = image.with_name("review.jpg")
            ordinary_ban.touch()
            review_dislike.touch()

            with (
                patch("wayper.core._replace_on_all_monitors", return_value={}),
                patch("wayper.core.push_undo") as push_undo,
                patch("wayper.core._schedule_preference_model_retrain"),
                patch("wayper.wallhaven_web.wallhaven_web_unfav", return_value="queued"),
            ):
                result = do_dislike(config, image=image, wait_remote=False)
                do_ban(config, image=ordinary_ban, wait_remote=False)
                do_ban(
                    config,
                    image=review_dislike,
                    wait_remote=False,
                    preference_context="model_review",
                )

            feedback = load_preference_feedback(config)
            blacklist = config.blacklist_file.read_text()

        self.assertTrue(result.ok)
        self.assertEqual(result.action, "dislike")
        self.assertIn("missed.jpg", blacklist)
        self.assertEqual(push_undo.call_count, 3)
        push_undo.assert_any_call(config, "missed.jpg", image.parent)
        self.assertEqual(
            [event["action"] for event in feedback["events"]],
            ["dislike", "ban", "dislike"],
        )
        self.assertEqual(feedback["events"][0]["context"], "manual_dislike")
        self.assertEqual(feedback["events"][2]["context"], "model_review")

    def test_dislike_image_route_uses_explicit_dislike_core_action(self) -> None:
        from wayper.core import CoreResult

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            result = CoreResult(action="dislike", image=image, extra={"replacement_images": {}})

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.server.api.do_dislike", return_value=result) as do_dislike,
                patch(
                    "wayper.server.api._preference_learning_payload",
                    return_value={"due": False},
                ),
            ):
                response = dislike_image_route(
                    ActionRequest(image_path="sfw/landscape/candidate.jpg")
                )

        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["learning"], {"due": False})
        kwargs = do_dislike.call_args.kwargs
        self.assertEqual(kwargs["image"], image.resolve())
        self.assertFalse(kwargs["wait_remote"])
        self.assertTrue(callable(kwargs["clear_thumbnail"]))

    def test_dislike_cli_preserves_json_output(self) -> None:
        from click.testing import CliRunner

        from wayper.cli import cli
        from wayper.core import CoreResult

        config = WayperConfig()
        image = Path("/tmp/missed.jpg")
        with (
            patch("wayper.cli.load_config", return_value=config),
            patch(
                "wayper.cli.do_dislike",
                return_value=CoreResult(action="dislike", image=image),
            ),
        ):
            result = CliRunner().invoke(cli, ["--json", "dislike"])

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(json.loads(result.output), {"action": "dislike", "image": str(image)})

    def test_preference_keep_feedback_reports_a_ledger_write_failure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    return_value={"items": [{"path": "sfw/landscape/candidate.jpg"}]},
                ),
                patch(
                    "wayper.preference_model.record_preference_feedback",
                    side_effect=OSError("disk full"),
                ),
            ):
                with self.assertLogs("wayper.api", level="WARNING"):
                    with self.assertRaises(HTTPException) as error:
                        preference_suggestion_feedback(
                            PreferenceFeedbackRequest(
                                path="sfw/landscape/candidate.jpg", action="keep"
                            )
                        )

        self.assertEqual(error.exception.status_code, 500)

    def test_mcp_delete_records_ban_feedback_only_when_blacklisted(self) -> None:
        from wayper.core import CoreResult
        from wayper.mcp_server import delete_wallpaper

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            ordinary = config.download_dir / "sfw" / "landscape" / "ordinary.jpg"
            blacklisted = config.download_dir / "sfw" / "landscape" / "blacklisted.jpg"
            ordinary.parent.mkdir(parents=True)
            ordinary.touch()
            blacklisted.touch()

            with (
                patch("wayper.mcp_server._config", return_value=config),
                patch(
                    "wayper.mcp_server.do_ban",
                    return_value=CoreResult(action="ban", image=blacklisted),
                ) as do_ban,
            ):
                ordinary_result = delete_wallpaper(str(ordinary))
                blacklisted_result = delete_wallpaper(str(blacklisted), add_to_blacklist_flag=True)
                directory_result = delete_wallpaper(
                    str(ordinary.parent), add_to_blacklist_flag=True
                )
                ordinary_deleted = not ordinary.exists()
                blacklisted_still_present = blacklisted.exists()

        self.assertFalse(ordinary_result["blacklisted"])
        self.assertTrue(blacklisted_result["blacklisted"])
        self.assertTrue(ordinary_deleted)
        self.assertTrue(blacklisted_still_present)
        self.assertIn("error", directory_result)
        do_ban.assert_called_once_with(config, image=blacklisted.resolve(), wait_remote=False)


if __name__ == "__main__":
    unittest.main()
