from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from PIL import Image

from wayper.config import WayperConfig, load_config, save_config
from wayper.pool import pool_dir
from wayper.server import api


@pytest.fixture
def local_library(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.toml"
    config = WayperConfig(download_dir=tmp_path / "library")
    save_config(config, config_file)
    for orientation in ("landscape", "portrait"):
        image = pool_dir(config, "sfw", orientation) / "local.jpg"
        image.parent.mkdir(parents=True)
        Image.new("RGB", (64, 64), "blue").save(image)
    monkeypatch.setattr("wayper.config.CONFIG_FILE", config_file)
    monkeypatch.setattr(api, "_cached_config", None)
    monkeypatch.setattr(api, "_cached_mtime", 0)
    monkeypatch.setattr(api, "_image_dir_cache", {})
    return config


def test_read_only_config_does_not_access_the_desktop(local_library, monkeypatch):
    detect = Mock(side_effect=RuntimeError("Desktop unavailable"))
    monkeypatch.setattr("wayper.backend.detect_monitors", detect)
    config = load_config(detect_displays=False)
    assert config.download_dir == local_library.download_dir
    detect.assert_not_called()
    load_config()
    detect.assert_called_once()


def test_library_and_image_routes_do_not_detect_monitors(local_library, monkeypatch):
    detect = Mock(side_effect=RuntimeError("Desktop unavailable"))
    monkeypatch.setattr("wayper.backend.detect_monitors", detect)
    routes = [
        "/api/config",
        "/api/images?purity=sfw&orient=",
        "/api/images/page?purity=sfw&orient=",
        "/images?path=sfw/landscape/local.jpg",
        "/thumbnails?path=sfw/landscape/local.jpg",
        "/previews?path=sfw/landscape/local.jpg",
        "/api/disk",
    ]

    async def browse():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app), base_url="http://wayper.test"
        ) as client:
            for route in routes:
                response = await client.get(route)
                assert response.status_code == 200, (route, response.text)
                if route.startswith("/api/images/page"):
                    page = response.json()
                    assert page["total"] == 2
                    assert {item["orientation"] for item in page["items"]} == {
                        "landscape",
                        "portrait",
                    }

    asyncio.run(browse())
    detect.assert_not_called()


def test_a_stalled_monitor_request_does_not_block_local_images(local_library, monkeypatch):
    entered = threading.Event()
    release = threading.Event()

    def detect():
        entered.set()
        release.wait(5)
        return []

    monkeypatch.setattr("wayper.backend.detect_monitors", detect)
    monkeypatch.setattr(api, "query_current", lambda: {})

    async def browse():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app), base_url="http://wayper.test"
        ) as client:
            monitors = asyncio.create_task(client.get("/api/monitors"))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                response = await asyncio.wait_for(
                    client.get("/api/images/page?purity=sfw&orient="), timeout=2
                )
                assert response.status_code == 200
                assert response.json()["total"] == 2
                assert not monitors.done()
            finally:
                release.set()
                await monitors

    asyncio.run(browse())
