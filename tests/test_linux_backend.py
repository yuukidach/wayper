from __future__ import annotations

import json
import subprocess
from unittest.mock import patch

from wayper.backend.linux import LinuxBackend, _monitors


def _result(payload: object) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")


def test_hyprland_monitor_parser_applies_output_transform() -> None:
    monitors = _monitors(
        [
            {"name": "DP-1", "width": 2560, "height": 1440, "transform": 0},
            {"name": "DP-2", "width": 2560, "height": 1440, "transform": 1},
        ]
    )

    assert [(item.name, item.width, item.height, item.orientation) for item in monitors] == [
        ("DP-1", 2560, 1440, "landscape"),
        ("DP-2", 1440, 2560, "portrait"),
    ]


def test_sway_monitor_parser_uses_physical_mode_and_transform() -> None:
    monitors = _monitors(
        [
            {
                "name": "eDP-1",
                "active": True,
                "current_mode": {"width": 2880, "height": 1800},
                "rect": {"width": 1440, "height": 900},
                "transform": "normal",
            },
            {
                "name": "DP-2",
                "active": True,
                "current_mode": {"width": 2560, "height": 1440},
                "rect": {"width": 720, "height": 1280},
                "transform": "270",
            },
            {"name": "DP-3", "active": False},
        ],
        sway=True,
    )

    assert [(item.name, item.width, item.height, item.orientation) for item in monitors] == [
        ("eDP-1", 2880, 1800, "landscape"),
        ("DP-2", 1440, 2560, "portrait"),
    ]


def test_sway_session_is_used_for_detection_and_focus() -> None:
    responses = {
        ("swaymsg", "-t", "get_outputs", "-r"): [
            {
                "name": "DP-3",
                "active": True,
                "current_mode": {"width": 1920, "height": 1080},
                "transform": "normal",
            }
        ],
        ("swaymsg", "-t", "get_workspaces", "-r"): [
            {"name": "1", "focused": False, "output": "DP-2"},
            {"name": "2", "focused": True, "output": "DP-3"},
        ],
    }

    def run(command, **_kwargs):
        payload = responses.get(tuple(command))
        if payload is None:
            raise FileNotFoundError(command[0])
        return _result(payload)

    with patch.dict("os.environ", {"SWAYSOCK": "/run/user/1000/sway.sock"}, clear=True):
        with patch("wayper.backend.linux.subprocess.run", side_effect=run):
            backend = LinuxBackend()
            assert [monitor.name for monitor in backend.detect_monitors()] == ["DP-3"]
            assert backend.get_focused_monitor() == "DP-3"


def test_detection_falls_back_from_hyprland_to_sway() -> None:
    commands: list[tuple[str, ...]] = []

    def run(command, **_kwargs):
        commands.append(tuple(command))
        if command[0] == "hyprctl":
            raise FileNotFoundError("hyprctl")
        return _result(
            [
                {
                    "name": "HDMI-A-1",
                    "active": True,
                    "rect": {"width": 1920, "height": 1080},
                    "transform": "normal",
                }
            ]
        )

    with patch.dict("os.environ", {}, clear=True):
        with patch("wayper.backend.linux.subprocess.run", side_effect=run):
            monitors = LinuxBackend().detect_monitors()

    assert [monitor.name for monitor in monitors] == ["HDMI-A-1"]
    assert commands[:2] == [
        ("hyprctl", "monitors", "-j"),
        ("swaymsg", "-t", "get_outputs", "-r"),
    ]
