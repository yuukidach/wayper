# Wayper

Cross-platform wallpaper manager with Wallhaven integration. Supports macOS and Linux with platform-specific backends and a unified Electron GUI.

## Quick Reference

```bash
# Install (dev)
uv venv && uv pip install -e .

# Run
wayper daemon start  # Start background rotation
wayper daemon stop   # Stop daemon
wayper next          # Set next wallpaper
wayper prev          # Go back to previous wallpaper
wayper status        # Show current state, daemon, disk usage
wayper-gui           # Launch Electron GUI
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
│   └── linux.py     #   Linux (awww/dbus)
├── browse/          # Shared browse helpers
│   └── _common.py   #   get_images, wallhaven_url, etc.
├── web/             # Backend API for Electron GUI
│   ├── api.py       #   FastAPI server (status, images, config, etc.)
│   ├── entry.py     #   PyInstaller entry point (CLI + API dual-mode)
│   └── launcher.py  #   Starts API server + spawns Electron
└── gui/
    ├── __init__.py  #   Entry point → Electron launcher
    └── electron/    #   Electron GUI (cross-platform)
        ├── main.js, preload.js
        ├── index.html, renderer.js, styles.css
        └── package.json  # electron-builder config
```

**Key patterns:**
- Platform code is isolated in `backend/` — shared logic lives in top-level modules
- CLI and GUI both share the same backend logic; `browse/_common.py` has shared browse helpers
- GUI is Electron-based: Python FastAPI backend (`web/api.py`) + Electron frontend (`gui/electron/`)
- PyInstaller bundles the Python backend; electron-builder packages the full app
- File-based state: TOML config, plain text blacklist/undo, JSON history
- File locks (`flock`) prevent concurrent state modifications
- Daemon uses SIGUSR1 (force rotation) and SIGUSR2 (mode reload); `daemon start` runs in background, bare `daemon` runs in foreground

## Code Conventions

- Python 3.12+. Use `from __future__ import annotations` in every file
- Type hints throughout: `-> Path | None`, `dict[str, Path | None]`
- Modern Python idioms: f-strings, dataclasses, walrus operator, pathlib
- Async/await for network I/O (httpx AsyncClient)
- Ruff: line length 100, rules `E, F, I, UP`
- Imports order: stdlib → third-party → local (relative)
- snake_case functions/variables, PascalCase classes
- Private methods/functions use `_` prefix

## Release Checklist

1. Bump version in `pyproject.toml`, `wayper/__init__.py`
2. Commit and tag: `git tag v{version}`
3. Push with tags: `git push origin main --tags` (triggers macOS DMG build via GitHub Actions)
4. Update AUR: edit `~/projects/wayper-aur/PKGBUILD` (pkgver, sha256sums), regenerate `.SRCINFO` via `makepkg --printsrcinfo > .SRCINFO`, commit and push to `ssh://aur@aur.archlinux.org/wayper.git`

## Guidelines

- No tests exist yet — do not add test infrastructure unless asked
- Pool directory structure: `download_dir/[sfw|nsfw]/[portrait|landscape]` + `favorites/` + `.trash/`
- All CLI commands support `--json` flag for machine-readable output
- Keep platform-specific code in `backend/` — never in shared modules
