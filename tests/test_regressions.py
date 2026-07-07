from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

import httpx

from wayper.config import WallhavenConfig, WayperConfig
from wayper.pool import load_metadata, save_metadata
from wayper.server.api import app
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
                    "tags": [{"name": "b"}],
                    "uploader": {"username": "user"},
                },
            )

            repaired = json.loads(config.metadata_file.read_text())
            self.assertIn("old.jpg", repaired)
            self.assertEqual(repaired["new.jpg"]["tags"], ["b"])

    def test_trash_routes_support_head_for_permission_probe(self) -> None:
        methods_by_path: dict[str, set[str]] = {}
        for route in app.routes:
            path = getattr(route, "path", "")
            methods = getattr(route, "methods", set()) or set()
            methods_by_path.setdefault(path, set()).update(methods)

        self.assertIn("HEAD", methods_by_path["/trash/{filename}"])
        self.assertIn("HEAD", methods_by_path["/trash-thumbnails/{filename}"])


if __name__ == "__main__":
    unittest.main()
