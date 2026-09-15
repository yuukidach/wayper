from __future__ import annotations

from unittest.mock import patch

import wayper.backend as backend
from wayper.config import MonitorConfig


def test_monitor_cache_recovers_when_display_callback_is_not_delivered() -> None:
    old = [MonitorConfig("2", 5120, 2880, "landscape")]
    live = [MonitorConfig("2", 2880, 5120, "portrait")]
    with (
        patch.object(backend, "_monitors_cache", old),
        patch.object(backend, "_monitors_dirty", False),
        patch.object(backend, "_monitors_cache_at", 100),
        patch.object(backend._backend, "detect_monitors", return_value=live) as detect,
        patch.object(backend.time, "monotonic", return_value=109) as now,
    ):
        assert backend.detect_monitors() == old
        detect.assert_not_called()
        now.return_value = 110
        assert backend.detect_monitors() == live
        detect.assert_called_once()


def test_display_callback_invalidates_monitor_cache_immediately() -> None:
    with (
        patch.object(backend, "_monitors_cache", [MonitorConfig("2", 5120, 2880, "landscape")]),
        patch.object(backend, "_monitors_dirty", False),
        patch.object(backend, "_monitors_cache_at", 100),
        patch.object(backend.time, "monotonic", return_value=101),
        patch.object(backend._backend, "detect_monitors", return_value=[]) as detect,
    ):
        backend._invalidate_monitors()
        assert backend.detect_monitors() == []
        detect.assert_called_once()
