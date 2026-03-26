# Wayper

Cross-platform wallpaper manager with Wallhaven integration. Supports macOS (AppKit) and Linux (swww/dbus + GTK4).

## Quick Reference

```bash
# Install (dev)
uv venv && uv pip install -e '.[macos]'   # macOS
uv venv && uv pip install -e .             # Linux

# Run
wayper daemon start  # Start background rotation
wayper daemon stop   # Stop daemon
wayper next          # Set next wallpaper
wayper prev          # Go back to previous wallpaper
wayper status        # Show current state, daemon, disk usage
wayper-gui           # Launch GUI app (GTK4 on Linux, AppKit on macOS)
wayper-mcp           # Start MCP server

# Lint
ruff check wayper/
ruff format --check wayper/
```

## Config & State

- Config: `~/.config/wayper/config.toml` (see `example-config.toml`)
- PID file: `~/.config/wayper/wayper.pid`
- State files live inside `download_dir`: `.mode`, `.blacklist`, `.undo`, `.history`
- Version: managed in `pyproject.toml` — keep `wayper/__init__.py` in sync

## Architecture

```
wayper/
├── cli.py           # Click CLI entry point
├── config.py        # TOML config loading/saving
├── daemon.py        # Background daemon (signal-driven)
├── state.py         # Persistent state (mode, undo, trash)
├── history.py       # Per-monitor wallpaper history
├── pool.py          # Image pool & quota management
├── wallhaven.py     # Wallhaven API client (async httpx)
├── image.py         # Image validation/resize/crop
├── mcp_server.py    # MCP server (FastMCP)
├── backend/         # Platform abstraction layer
│   ├── base.py      #   WallpaperBackend protocol
│   ├── macos.py     #   macOS (AppKit/osascript)
│   └── linux.py     #   Linux (swww/dbus)
├── browse/          # Shared browse helpers
│   └── _common.py   #   get_images, wallhaven_url, etc.
└── gui/             # GUI app (platform-dispatched)
    ├── macos/       #   macOS AppKit GUI
    │   ├── app.py, main_window.py, browse_view.py
    │   ├── actions_view.py, daemon_control.py
    │   ├── settings_window.py, colors.py
    │   └── __init__.py
    └── gtk/         #   Linux GTK4 GUI
        ├── app.py, main_window.py, browse_view.py
        ├── actions_view.py, daemon_control.py
        ├── settings_window.py, css.py
        └── __init__.py
```

**Key patterns:**
- Platform code is isolated in `backend/` and `gui/` — shared logic lives in top-level modules
- CLI and GUI both share the same backend logic; `browse/_common.py` has shared browse helpers
- File-based state: TOML config, plain text blacklist/undo, JSON history
- File locks (`flock`) prevent concurrent state modifications
- Daemon uses SIGUSR1 (force rotation) and SIGUSR2 (mode reload); `daemon start` runs in background, bare `daemon` runs in foreground
- UI uses Catppuccin Mocha palette across GTK4 and macOS GUI

## Code Conventions

- Python 3.12+. Use `from __future__ import annotations` in every file
- Type hints throughout: `-> Path | None`, `dict[str, Path | None]`
- Modern Python idioms: f-strings, dataclasses, walrus operator, pathlib
- Async/await for network I/O (httpx AsyncClient)
- Ruff: line length 100, rules `E, F, I, UP`
- Imports order: stdlib → third-party → local (relative)
- snake_case functions/variables, PascalCase classes
- Private methods/functions use `_` prefix

## Guidelines

- No tests exist yet — do not add test infrastructure unless asked
- Pool directory structure: `download_dir/[sfw|nsfw]/[portrait|landscape]` + `favorites/` + `.trash/`
- All CLI commands support `--json` flag for machine-readable output
- macOS GUI uses PyObjC (AppKit bindings) — no SwiftUI or Interface Builder
- Linux GUI uses GTK4/PyGObject — no libadwaita
- `gui/__init__.py` dispatches by platform: darwin → AppKit, else → GTK4
- Keep platform-specific code in `backend/` or `gui/` — never in shared modules
