# wayper

Wayland-first wallpaper manager with [Wallhaven](https://wallhaven.cc) integration and AI-native control.

## Features

- **Multi-monitor orientation matching** — portrait and landscape wallpapers go to the right screen
- **Smart pool management** — auto-downloads, validates, resizes, and rotates wallpapers
- **SFW/NSFW modes** — toggle on the fly, persistent across sessions
- **Favorites & blacklist** — like/dislike with undo support
- **JSON output** — `--json` flag on every command
- **MCP server** — AI assistants can control your wallpapers natively

## Install

```bash
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv && uv pip install -e .
```

## Setup

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
# Edit config with your API key, monitors, proxy, etc.
```

## Usage

```
wayper daemon               # start background rotation + downloads
wayper next                 # change wallpaper on focused monitor
wayper fav [--open]         # favorite current wallpaper
wayper unfav                # remove from favorites
wayper dislike              # blacklist + switch
wayper undislike            # undo last dislike
wayper mode [sfw|nsfw]      # toggle or set mode
wayper status               # show current state
wayper --json status        # machine-readable output
```

## MCP

wayper ships an MCP server for AI assistants (Claude Code, etc.):

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/.venv/bin/wayper-mcp"
    }
  }
}
```

Tools: `status`, `next_wallpaper`, `fav`, `unfav`, `dislike`, `undislike`, `set_mode`, `delete_wallpaper`

## Requirements

- Python 3.12+
- [swww](https://github.com/LGFae/swww) (Wayland wallpaper daemon)
- Hyprland (for focused monitor detection)
- Wallhaven API key ([get one here](https://wallhaven.cc/settings/account))

## License

MIT
