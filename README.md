<p align="center">
  <img src="assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    Cross-platform wallpaper manager with <a href="https://wallhaven.cc">Wallhaven</a> integration and AI-native control.
  </p>
  <p align="center">
    <a href="https://yuukidach.github.io/wayper/">Home</a> · <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#mcp">MCP</a> · <a href="#config">Config</a> · <a href="README.zh-CN.md">中文</a>
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

<details>
<summary>GUI screenshot</summary>
<p align="center">
  <img src="assets/browse.png" alt="GUI browse view" width="720">
</p>
</details>

## Why wayper?

- **Wallhaven integration** — auto-downloads wallpapers from [Wallhaven](https://wallhaven.cc) based on your search preferences. No manual sourcing.
- **Auto orientation matching** — portrait monitors get portrait wallpapers, landscape gets landscape. No manual sorting.
- **Pool management** — validates (catches corrupt images), resizes to your exact resolution, and rotates automatically.
- **SFW/NSFW toggle** — one key to switch. Persistent across sessions.
- **History navigation** — prev/next through your wallpaper history. Browser-style back/forward per monitor.
- **Favorites & blacklist** — like/dislike with undo. Favorites stay in rotation.
- **Cross-platform GUI** — browse, preview, and manage your collection with daemon control and settings. Works on Linux and macOS. Keyboard-driven.
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
wayper next                 # next wallpaper (forward history or new random)
wayper prev                 # previous wallpaper from history
wayper fav [--open]         # favorite current wallpaper
wayper unfav                # remove from favorites
wayper dislike              # blacklist + switch
wayper undislike            # undo last dislike
wayper mode [sfw|nsfw]      # toggle or set mode
wayper status               # show current state
wayper-gui                  # GUI app (browse, actions, daemon, settings)
wayper setup                # install .desktop entry (Linux)
wayper --json status        # machine-readable output
```

### GUI App

`wayper-gui` launches a standalone app with browse, quick actions (next/prev/fav/dislike), daemon control, and settings — all in one window.

```
1/2/3    switch category        Enter    set as wallpaper
f        favorite               x        remove/reject/restore
o        open on Wallhaven      d        delete
n/p      next/prev wallpaper    m        toggle SFW/NSFW
```

### Keybindings

<details>
<summary>Hyprland</summary>

```ini
bind = $mod, F9,       exec, wayper dislike
bind = $mod SHIFT, F9, exec, wayper undislike
bind = $mod, F10,      exec, wayper fav
bind = $mod SHIFT, F10,exec, wayper unfav
bind = $mod CTRL, F10, exec, wayper fav --open
bind = $mod, F11,      exec, wayper next
bind = $mod SHIFT, F11,exec, wayper prev
bind = $mod, F12,      exec, wayper mode
exec-once = wayper daemon
```
</details>

<details>
<summary>AeroSpace (macOS)</summary>

```toml
cmd-shift-n = 'exec-and-forget wayper next'
cmd-shift-b = 'exec-and-forget wayper dislike'
cmd-shift-f = 'exec-and-forget wayper fav'
```
</details>

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

Available tools: `status` · `next_wallpaper` · `prev_wallpaper` · `fav` · `unfav` · `dislike` · `undislike` · `set_mode` · `delete_wallpaper`

## Config

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

See [`example-config.toml`](example-config.toml) for all options — monitors, API key, proxy, intervals, quota, transitions, etc.

## Requirements

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)

**Linux:** [awww](https://codeberg.org/LGFae/awww), [Hyprland](https://hyprland.org/)

**macOS:** Python 3.12+, Node.js (for Electron GUI)

## License

[MIT](LICENSE)
