# AGENTS.md

## Project Overview

wayper is a Python 3.12+ wallpaper manager with Wallhaven integration, a Click CLI,
a FastAPI backend for the Electron GUI, and a stdio MCP server.

## Agent Guidance Layout

- This `AGENTS.md` is the canonical shared agent guidance file.
- Claude Code imports this file from `.claude/CLAUDE.md`; keep durable project guidance here.
- Shared repo skills live in `.claude/skills` for Claude Code compatibility.
- `.agents/skills` contains symlinks to `.claude/skills` so Codex can discover the same skills.

## Setup

- Install for development with `uv venv && uv pip install -e .`.
- Install optional browser cookie support with `uv pip install -e ".[browser]"`.
- Electron dependencies live in `wayper/electron`; run `npm ci` there before Electron work.
- The MCP server entry point is `wayper-mcp`; after source install it is usually
  available at `.venv/bin/wayper-mcp`.

## Common Commands

- Run CLI commands with `uv run wayper ...` or `wayper ...` after installing the package.
- Start the daemon with `wayper daemon`; use `wayper daemon start` only when backgrounding is
  specifically needed.
- Launch the GUI with `wayper-gui`.
- Start the MCP stdio server with `wayper-mcp`.
- Lint Python with `ruff check wayper/` when `ruff` is installed. If not, use
  `uvx ruff check wayper/` or `pre-commit run ruff --all-files`.
- Check Python formatting with `ruff format --check wayper/` when `ruff` is installed. If not,
  use `uvx ruff format --check wayper/` or `pre-commit run ruff-format --all-files`.
- Run the existing Electron test with `cd wayper/electron && npm test`.

## Architecture

- `wayper/core.py` owns state-modifying operations. CLI, API, and MCP layers should remain
  thin wrappers around core behavior.
- Platform-specific wallpaper behavior belongs in `wayper/backend/`; keep shared logic in
  top-level modules.
- The GUI is Electron plus a Python FastAPI backend: `wayper/server/api.py` serves API routes,
  and `wayper/electron/` contains the frontend.
- The API server auto-selects a free port and writes it to `~/.config/wayper/api.port`.
  Electron reads that port through IPC.
- File-based state is intentional: TOML config, plain-text blacklist/undo files, JSON history,
  and per-download-dir state files.
- File locks prevent concurrent state modifications.
- The daemon uses SIGUSR1 for forced rotation and SIGUSR2 for mode reload.

## Code Conventions

- Use `from __future__ import annotations` in Python files.
- Prefer modern typed Python: `Path | None`, `dict[str, Path | None]`, dataclasses, pathlib,
  f-strings, and async/await for network I/O.
- Ruff settings are in `pyproject.toml`: line length 100 and rules `E`, `F`, `I`, `UP`.
- Keep imports ordered as stdlib, third-party, then local imports.
- Use snake_case for functions and variables, PascalCase for classes, and `_` prefixes for
  private helpers.

## Change Guidelines

- Keep behavior cross-platform for macOS and Linux. Do not assume X11 on Linux; support
  Wayland-oriented Hyprland/Sway paths.
- Disliked images go to system trash. Do not introduce a project-managed `.trash/` directory.
- All CLI commands should preserve `--json` machine-readable output behavior.
- When changing user-facing docs, keep `README.md` and `docs/README.zh-CN.md` in sync. Update
  `docs/index.html` when the public site content changes.
- When changing MCP docs, include Codex TOML config and Claude Code JSON config where relevant.
- AI tag suggestions currently depend on the local `claude` CLI. Do not describe that feature
  as Codex-powered unless the implementation changes.
- For version bumps, keep `pyproject.toml`, `wayper/__init__.py`, and
  `wayper/electron/package.json` in sync.
- Do not modify local user config, wallpaper state, `.claude/settings.local.json`, or generated
  build artifacts unless the task explicitly requires it.
