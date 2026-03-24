<p align="center">
  <img src="assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    Wayland-first wallpaper manager with <a href="https://wallhaven.cc">Wallhaven</a> integration and AI-native control.
  </p>
  <p align="center">
    <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#mcp">MCP</a> · <a href="#config">Config</a> · <a href="README.zh-CN.md">中文</a>
  </p>
</p>

<p align="center">
  <img src="assets/demo-desktop.gif" alt="wallpaper transitions" width="720">
</p>

<details>
<summary>CLI demo</summary>
<p align="center">
  <img src="assets/demo-cli.gif" alt="CLI usage" width="720">
</p>
</details>

## Why wayper?

- **Auto orientation matching** — portrait monitors get portrait wallpapers, landscape gets landscape. No manual sorting.
- **Pool management** — downloads, validates (catches corrupt images), resizes to your exact resolution, and rotates automatically.
- **SFW/NSFW toggle** — one key to switch. Persistent across sessions.
- **Favorites & blacklist** — like/dislike with undo. Favorites stay in rotation.
- **GTK4 browser** — browse, preview, and manage your wallpaper collection with keyboard shortcuts. Launch from rofi or any app launcher.
- **AI-native** — built-in MCP server lets AI assistants (Claude Code, etc.) control your wallpapers directly. Ask your AI to "delete this broken wallpaper" or "favorite this one" — it just works.
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
wayper browse               # GTK4 wallpaper browser
wayper setup                # install desktop entry for rofi/launchers
wayper --json status        # machine-readable output
```

### Browse

GTK4 wallpaper browser with thumbnail grid, full-size preview, and keyboard shortcuts.

<p align="center">
  <img src="assets/browse.png" alt="browse window" width="540">
</p>

```
Arrow keys    navigate grid          1/2/3    switch category
Enter         set as wallpaper       m        toggle SFW/NSFW
f             favorite               x        remove/reject/restore
o             open on Wallhaven      d        delete
q/Esc         close
```

Run `wayper setup` once to add a desktop entry — then launch from rofi or any application launcher.

### Hyprland keybindings example

```ini
bind = $mod, F9,       exec, wayper dislike
bind = $mod SHIFT, F9, exec, wayper undislike
bind = $mod, F10,      exec, wayper fav
bind = $mod SHIFT, F10,exec, wayper unfav
bind = $mod CTRL, F10, exec, wayper fav --open
bind = $mod, F11,      exec, wayper next
bind = $mod, F12,      exec, wayper mode
bind = $mod, W,        exec, wayper browse

exec-once = swww-daemon & sleep 5 && wayper daemon
```

## MCP

wayper ships an [MCP](https://modelcontextprotocol.io/) server so AI assistants can control your wallpapers natively.

Add to your Claude Code config (`~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/.venv/bin/wayper-mcp"
    }
  }
}
```

Available tools: `status` · `next_wallpaper` · `fav` · `unfav` · `dislike` · `undislike` · `set_mode` · `delete_wallpaper`

## Config

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

See [`example-config.toml`](example-config.toml) for all options — monitors, API key, proxy, intervals, quota, transitions, etc.

## Requirements

- Python 3.12+
- [swww](https://github.com/LGFae/swww) — Wayland wallpaper daemon
- [Hyprland](https://hyprland.org/) — for focused monitor detection
- [Wallhaven API key](https://wallhaven.cc/settings/account)
- [GTK4](https://gtk.org/) + [PyGObject](https://pygobject.gnome.org/) — for `wayper browse` (install: `sudo pacman -S python-gobject gtk4`)

## License

[MIT](LICENSE)
