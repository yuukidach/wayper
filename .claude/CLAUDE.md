# Wayper

Cross-platform wallpaper manager with Wallhaven integration. Supports macOS (AppKit) and Linux (swww/dbus + GTK4).

## Quick Reference

```bash
# Install (dev)
uv venv && uv pip install -e '.[macos]'   # macOS
uv venv && uv pip install -e .             # Linux

# Run
wayper next          # Set next wallpaper
wayper daemon start  # Start background rotation
wayper-gui           # Launch macOS GUI app
wayper-mcp           # Start MCP server

# Lint
ruff check wayper/
ruff format --check wayper/
```

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
├── browse/          # Native wallpaper browser
│   ├── macos.py     #   AppKit browser
│   └── gtk.py       #   GTK4 browser
└── gui/             # macOS standalone GUI app
    ├── app.py       #   NSApplication setup
    ├── main_window.py
    └── ...
```

**Key patterns:**
- Platform code is isolated in `backend/` and `browse/` — shared logic lives in top-level modules
- CLI and GUI both share the same backend logic
- File-based state: TOML config, plain text blacklist/undo, JSON history
- File locks (`flock`) prevent concurrent state modifications
- Daemon uses SIGUSR1 (force rotation) and SIGUSR2 (mode reload)

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
- Keep platform-specific code in `backend/` or `browse/`, never in shared modules
