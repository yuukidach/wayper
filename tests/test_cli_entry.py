"""The unified app entry point keeps GUI and CLI invocations separate."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from wayper.cli import cli
from wayper.config import WayperConfig


@pytest.mark.parametrize("arguments", [[], ["--hidden"]])
def test_no_subcommand_launches_app(arguments: list[str]) -> None:
    with (
        patch("wayper.server.launcher.run_app") as launch,
        patch("wayper.cli.load_config") as load_config,
        patch("wayper.logging.setup_logging") as setup_logging,
    ):
        result = CliRunner().invoke(cli, arguments)

    assert result.exit_code == 0, result.output
    launch.assert_called_once_with(arguments=arguments)
    load_config.assert_not_called()
    setup_logging.assert_not_called()


def test_help_does_not_launch_app() -> None:
    with patch("wayper.server.launcher.run_app") as launch:
        result = CliRunner().invoke(cli, ["--help"])

    assert result.exit_code == 0, result.output
    assert "--hidden" in result.output
    assert "Run without a command to open the app" in result.output
    launch.assert_not_called()


def test_cli_subcommand_preserves_json_and_custom_config(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.touch()
    config = WayperConfig()
    snapshot = {"pool": {"total": 42}, "favorites": 7}
    with (
        patch("wayper.server.launcher.run_app") as launch,
        patch("wayper.logging.setup_logging"),
        patch("wayper.cli.load_config", return_value=config) as load_config,
        patch("wayper.cli.status_snapshot", return_value=snapshot) as status_snapshot,
    ):
        result = CliRunner().invoke(cli, ["--config", str(config_path), "--json", "status"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == snapshot
    load_config.assert_called_once_with(config_path)
    status_snapshot.assert_called_once_with(config)
    launch.assert_not_called()


@pytest.mark.parametrize("arguments", [["--hidden", "status"], ["--json"], ["--hidden", "--json"]])
def test_gui_and_cli_options_cannot_be_mixed(arguments: list[str]) -> None:
    with (
        patch("wayper.server.launcher.run_app") as launch,
        patch("wayper.cli.load_config") as load_config,
    ):
        result = CliRunner().invoke(cli, arguments)

    assert result.exit_code == 2
    assert "subcommand" in result.output
    launch.assert_not_called()
    load_config.assert_not_called()


def test_config_without_subcommand_does_not_silently_use_default_config(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.touch()
    with patch("wayper.server.launcher.run_app") as launch:
        result = CliRunner().invoke(cli, ["--config", str(config_path)])

    assert result.exit_code == 2
    assert "require a CLI subcommand" in result.output
    launch.assert_not_called()
