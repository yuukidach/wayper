---
layout: default
---

<p align="center">
  <a href="https://github.com/yuukidach/wayper/releases">Download</a> &middot;
  <a href="https://github.com/yuukidach/wayper">GitHub</a> &middot;
  <a href="https://aur.archlinux.org/packages/wayper">AUR</a>
</p>

![wallpaper transitions](https://raw.githubusercontent.com/yuukidach/wayper/main/assets/demo-desktop.gif)

## Why wayper?

- **Wallhaven integration** — auto-downloads wallpapers from [Wallhaven](https://wallhaven.cc) based on your search preferences. No manual sourcing.
- **Auto orientation matching** — portrait monitors get portrait wallpapers, landscape gets landscape. No manual sorting.
- **Pool management** — validates (catches corrupt images), resizes to your exact resolution, and rotates automatically.
- **SFW/NSFW toggle** — one key to switch. Persistent across sessions.
- **History navigation** — prev/next through your wallpaper history. Browser-style back/forward per monitor.
- **Favorites & blacklist** — like/dislike with undo. Favorites stay in rotation.
- **Native browser** — browse, preview, and manage your collection. GTK4 on Linux, AppKit on macOS. Keyboard-driven.
- **AI-native** — built-in [MCP](https://modelcontextprotocol.io/) server lets AI assistants (Claude Code, etc.) control your wallpapers directly.
- **JSON output** — `--json` flag on every command for scripting and automation.

## Install

### Arch Linux (AUR)

```bash
paru -S wayper     # or: yay -S wayper
```

### From source

```bash
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv && uv pip install -e .
```

**macOS:** `pip install 'wayper[macos]'`

## Usage

```
wayper daemon               # start background rotation + downloads
wayper next                 # next wallpaper
wayper prev                 # previous wallpaper
wayper fav [--open]         # favorite current wallpaper
wayper dislike              # blacklist + switch
wayper undislike            # undo last dislike
wayper mode [sfw|nsfw]      # toggle or set mode
wayper status               # show current state
wayper browse               # native wallpaper browser
```

### Browse

![browse window](https://raw.githubusercontent.com/yuukidach/wayper/main/assets/browse.png)

```
1/2/3    switch category        Enter    set as wallpaper
f        favorite               x        remove/reject/restore
o        open on Wallhaven      d        delete
m        toggle SFW/NSFW        q/Esc    close
```

## MCP

wayper ships an MCP server so AI assistants can control your wallpapers natively.

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/.venv/bin/wayper-mcp"
    }
  }
}
```

Tools: `status` &middot; `next_wallpaper` &middot; `prev_wallpaper` &middot; `fav` &middot; `unfav` &middot; `dislike` &middot; `undislike` &middot; `set_mode` &middot; `delete_wallpaper`

## Config

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

See [`example-config.toml`](https://github.com/yuukidach/wayper/blob/main/example-config.toml) for all options.

## Requirements

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)
- **Linux:** [swww](https://github.com/LGFae/swww), [Hyprland](https://hyprland.org/), GTK4 + PyGObject
- **macOS:** PyObjC (`pip install 'wayper[macos]'`)

## License

[MIT](https://github.com/yuukidach/wayper/blob/main/LICENSE)
