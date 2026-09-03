"""Regression tests for packaged API server startup."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import uvicorn

from wayper.server import api


def test_review_warmup_matches_full_gui_query(monkeypatch) -> None:
    calls: list[tuple[str, str, int]] = []

    async def no_delay(_seconds: float) -> None:
        return None

    def fake_suggestions(*, purity: str, orient: str, limit: int) -> None:
        calls.append((purity, orient, limit))

    config = SimpleNamespace(
        monitors=[
            SimpleNamespace(orientation="landscape"),
            SimpleNamespace(orientation="portrait"),
        ]
    )
    monkeypatch.setattr(api.asyncio, "sleep", no_delay)
    monkeypatch.setattr(api, "get_config", lambda: config)
    monkeypatch.setattr(api, "read_mode", lambda _config: {"sfw"})
    monkeypatch.setattr(api, "preference_suggestions", fake_suggestions)

    asyncio.run(api._warm_review_suggestions())

    assert sorted(calls) == [
        ("sfw", "landscape", 0),
        ("sfw", "portrait", 0),
    ]


def test_api_run_does_not_require_console_streams(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def fake_run(application, **kwargs: object) -> None:
        captured.update(kwargs)
        uvicorn.Config(application, **kwargs)

    monkeypatch.setattr(api, "_find_free_port", lambda: 12345)
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr("atexit.register", lambda callback, *args: callback)
    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    api.run()

    assert captured["log_config"] is None
    assert (tmp_path / "api.port").read_text() == "12345"


def test_api_run_skips_a_second_backend(monkeypatch, tmp_path: Path) -> None:
    run_calls: list[object] = []

    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api, "_acquire_api_lock", lambda: None)
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr(uvicorn, "run", lambda application, **kwargs: run_calls.append(application))
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)

    api.run()

    assert run_calls == []
    assert not (tmp_path / "api.port").exists()


def test_api_port_cleanup_does_not_remove_another_instances_file(tmp_path: Path) -> None:
    port_path = tmp_path / "api.port"
    port_path.write_text("54321")

    api._remove_owned_port_file(port_path, 12345)

    assert port_path.read_text() == "54321"

    port_path.write_text("12345")
    api._remove_owned_port_file(port_path, 12345)

    assert not port_path.exists()
