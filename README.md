<p align="center">
  <img src="assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    The wallpaper manager that learns what you like.<br>
    Wallhaven integration · AI-native · keyboard-driven.
  </p>
  <p align="center">
    <a href="https://yuukidach.github.io/wayper/">Home</a> · <a href="#install">Install</a> · <a href="#gui">GUI</a> · <a href="#cli">CLI</a> · <a href="#mcp">MCP</a> · <a href="#config">Config</a> · <a href="docs/README.zh-CN.md">中文</a>
  </p>
</p>

<p align="center">
  <img src="assets/demo-desktop.gif" alt="wallpaper transitions" width="720">
</p>

## Why wayper?

Most wallpaper tools stop at "set image on desktop." wayper is a full **Wallhaven client** that auto-downloads, curates, and rotates wallpapers — and gets smarter the more you use it.

**What makes it different:**

- **Learns from you** — mark a wallpaper **Dislike** when the model misses it and wayper adds an explicit training label. **Ban** remains a separate exact-image block for wallpapers you are simply tired of.
- **AI-native (MCP)** — built-in [MCP](https://modelcontextprotocol.io/) server. Tell Codex or Claude *"switch to something with mountains"* or *"favorite this one"* — it just works. First wallpaper manager with native AI assistant integration.
- **Keyboard-driven GUI** — every single action has a shortcut. Grid navigation, lightbox, favorites, settings — fully operable without a mouse. Built for power users.

**And the fundamentals:**

- **Wallhaven integration** — auto-downloads based on your search preferences. Syncs favorites and tag blacklist to your Wallhaven account.
- **Smart tag filtering** — excluded tags sync to Wallhaven's cloud blacklist for server-side filtering; overflow tags are sent via URL query; the rest are filtered after metadata fetch. Zero wasted downloads.
- **Auto orientation** — portrait monitors get portrait wallpapers. No sorting needed.
- **Three-tier purity** — SFW, Sketchy, NSFW — independently toggleable, persistent across sessions.
- **Cross-platform** — Windows, macOS, and Linux (Hyprland/Sway). CLI + GUI + MCP.
- **`--json` everywhere** — every command supports machine-readable output.

## Install

### Arch Linux (AUR)

```bash
paru -S wayper     # or: yay -S wayper
```

### Windows

Download the latest Windows installer from [GitHub Releases](https://github.com/yuukidach/wayper/releases/latest), or install from source with Python 3.12+.

```powershell
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv
uv pip install -e .
```

### macOS

Download the latest `.dmg` from [GitHub Releases](https://github.com/yuukidach/wayper/releases/latest), or install from source with Python 3.12+.

### From source

```bash
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv && uv pip install -e .
```

Browser cookie extraction and the Cloudflare-capable login fallback for Wallhaven sync are
included in the standard installation.

## GUI

<p align="center">
  <img src="assets/browse.png" alt="GUI browse view" width="720">
</p>

`wayper-gui` launches a tray-resident app for browsing, managing, and controlling your wallpaper collection. Fully operable without a mouse.

- **Browse & preview** — grid view with thumbnail caching, lightbox preview, set wallpaper with Enter
- **Tag search** — search by Wallhaven tags, category, or filename with autocomplete
- **Smart suggestions** — analyzes ban patterns to recommend tags to exclude; co-occurrence mining finds common descriptors across excluded individuals; drill into combo exclusions (e.g., "tattoo + nude") for precise filtering
- **AI analysis** — Codex-powered deep analysis of ban patterns with iterative feedback. Identifies uploader patterns and suggests Wallhaven user blacklist candidates. Click suggested tags to preview matching images
- **Adaptive filtering** — choose `rules`, `model`, or `rules + model` from the always-visible sidebar control. **Review** keeps automatically held downloads and ordinary model recommendations in separate card lanes; clear the Auto-held lane to filter it without adding preference labels
- **Background rotation** — closing the window keeps Wayper in the system tray, where you can change wallpaper, pause rotation, reopen the window, or quit
- **Settings** — configure the download folder, Wallhaven queries, excluded tags/combos, purity, and monitors from the GUI. Changes apply to automatic rotation instantly
- **Keyboard-driven** — every action has a shortcut: grid navigation, lightbox, favorites, Dislike, Ban, and undo

Use `wayper-gui --hidden` to start directly in the tray. On Hyprland, the tray is supplied by a status bar such as Waybar; make sure its `tray` module is enabled.

**Grid view:**

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `p` / `v` | Pool / Favorites | `m` / `b` | Model / Blocklist |
| `s` | Settings | `F1` `F2` `F3` | Toggle SFW / Sketchy / NSFW |
| `h` / `l` | Prev / Next wallpaper | `f` | Favorite (focused card or current) |
| `d` | Dislike + teach model | `x` / `Del` | Ban exact image only |
| `u` | Undo last Dislike / Ban | `o` | Open on Wallhaven |
| `/` | Focus search bar | `Esc` | Clear search / Unfocus |
| `Enter` / `Space` | Preview (lightbox) | Arrow keys | Navigate grid |
| `[` / `]` | Blocklist: Recoverable / All | `a` | AI analysis (Blocklist) |
| `g` | Locate current wallpaper | `gg` / `G` | Jump to first / last |
| `1`–`9` | Switch monitor | | |

**Lightbox preview:**

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `←` / `→` | Previous / Next image (pan when zoomed) | `Enter` | Set as wallpaper |
| `f` | Favorite | `d` | Dislike + teach model |
| `x` / `Del` | Ban exact image only | `a` (Review) | Keep reviewed candidate |
| `o` | Open on Wallhaven | | |
| `Space` / `Esc` | Close lightbox | | |
| Scroll | Zoom at cursor (0.5×–8×) | Drag | Pan when zoomed in |
| `0` | Reset to fit | `+` / `-` | Zoom in / out |
| Double-click | Toggle 100% / fit | | |

## CLI

<p align="center">
  <img src="assets/demo-cli.gif" alt="CLI usage" width="720">
</p>

```
wayper next                 # next wallpaper (forward history or new random)
wayper prev                 # previous wallpaper from history
wayper fav [--open]         # favorite current wallpaper
wayper unfav                # remove from favorites
wayper dislike              # explicit dislike: teach model, blacklist + switch
wayper ban                  # exact-image block only: blacklist + switch
wayper unban                # undo last dislike or ban
wayper mode                 # toggle sfw↔nsfw (preserves sketchy)
wayper mode sketchy         # toggle sketchy on/off
wayper mode sfw,sketchy     # set exact purity combination
wayper suggest             # frequency-based tag exclusion suggestions
wayper suggest --ai        # AI-powered analysis via Codex CLI
wayper model train         # train the lightweight local metadata ranking model
wayper model score --tags "tag1,tag2"  # explain a local dislike score
wayper model status        # inspect the saved model and recent validation
wayper metadata status     # inspect cached Wallhaven metadata completeness
wayper metadata backfill   # resumably fetch missing full wallpaper/tag details
wayper status               # show current state
wayper-gui                  # GUI app + tray background rotation
wayper setup                # install .desktop entry (Linux)
wayper --json status        # machine-readable output
```

`wayper model train` learns from local Wallhaven metadata only: normalized tags and
compact color/category/purity context. It never opens image files or reads pixels.
FastEmbed is installed with Wayper; `BAAI/bge-small-en-v1.5` is downloaded and cached on
first use to provide the semantic path. Every
explicit Keep/Dislike remains available to KNN retrieval: an IDF-weighted pooled matrix
does coarse retrieval, then only the top candidates are reranked with exact overlap,
per-tag MaxSim, category/color/purity context, and balanced Keep/Dislike evidence. The
global sparse+dense head fits a balanced recent working set of at most 2,048 examples,
while the KNN memory is not truncated. The final decision keeps 80% of the local vote
and 20% of the global preference probability, then applies one boundary calibrated on
at most 640 held-out decisions for at least 80% precision. Embeddings are metadata-only
and cached locally.
New downloads preserve complete Wallhaven tag objects; use `wayper metadata backfill`
to repair older live/model-relevant records without exceeding the API rate limit.

Before any **Review** feedback exists, older blacklist/favorite data may bootstrap
the model. After the first Review decision or manual **Dislike**, only explicit
Keep/Dislike decisions become labels; **Ban** remains an exact-image block. Images
that merely sit in the pool are background examples, not proof that you like them.
Filtering stays off until both explicit classes and held-out calibration are available.
The model then learns related metadata, filters likely blocks into a recoverable queue,
and ranks suggestions. It never changes the blacklist automatically, and refreshes
locally after enough feedback.

Open the dedicated **Review** view to teach the model. Choose `Rules`, `Model`, or
`Both` (`Rules + model`) for new downloads. **Auto-held** contains downloads set
aside by the model; **Recommended** contains possible blocks already in the pool.
Auto-held appears first. Drag, scroll, or use the arrows to move through cards;
`Enter`/`Space` opens a preview, `A` keeps, and `D` dislikes. Keeping an Auto-held
file releases it into the pool; keeping a recommendation records feedback without
moving the file. In Settings, the language can follow the system or be set to
English/Simplified Chinese; download batch size is configured under General.
**Clear auto-held** adds every held image in the current library slice to the
blocklist without recording Keep or Dislike feedback.

### Keybindings

**Hyprland:**

```ini
bind = $mod, F9,       exec, wayper ban
bind = $mod CTRL, F9,  exec, wayper dislike
bind = $mod SHIFT, F9, exec, wayper unban
bind = $mod, F10,      exec, wayper fav
bind = $mod SHIFT, F10,exec, wayper unfav
bind = $mod CTRL, F10, exec, wayper fav --open
bind = $mod, F11,      exec, wayper next
bind = $mod SHIFT, F11,exec, wayper prev
bind = $mod, F12,      exec, wayper mode
bind = $mod SHIFT, F12,exec, wayper mode sketchy
exec-once = wayper-gui --hidden
```

**AeroSpace (macOS):**

```toml
cmd-shift-n = 'exec-and-forget wayper next'
cmd-shift-b = 'exec-and-forget wayper ban'
cmd-shift-f = 'exec-and-forget wayper fav'
```

## MCP

wayper ships an [MCP](https://modelcontextprotocol.io/) server so AI assistants can control your wallpapers natively.

Use the absolute path to `wayper-mcp`. After installing from source, that is usually `.venv/bin/wayper-mcp`.

**Codex:**

```bash
codex mcp add wayper -- /path/to/wayper/.venv/bin/wayper-mcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.wayper]
command = "/path/to/wayper/.venv/bin/wayper-mcp"
```

**Claude Code:**

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/wayper/.venv/bin/wayper-mcp"
    }
  }
}
```

Available tools: `status` · `next_wallpaper` · `prev_wallpaper` · `fav` · `unfav` · `dislike` · `ban` · `unban` · `set_mode` · `delete_wallpaper` · `wallpaper_info` · `tag_stats_top` · `tag_stats_lookup` · `tag_stats_combo` · `uploader_stats_lookup`

## Config

Linux/macOS:

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

Windows:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\wayper"
Copy-Item example-config.toml "$env:APPDATA\wayper\config.toml"
```

Set the wallpaper download folder and login autostart in the GUI Settings view, or edit the options in [`example-config.toml`](example-config.toml). Autostart defaults on and can also be managed with `wayper autostart enable|disable|status` or the MCP `configure_autostart` tool. Wayper uses a graphical-session user service on Linux (so no Hyprland `exec-once` is needed), a LaunchAgent on macOS, and a per-user Run registration on Windows. Windows launches the GUI executable directly when possible and automatically uses a windowless script fallback for uv environments without a working `pythonw.exe`; neither path opens a console window. See the example file for all options — API key, proxy, intervals, quota, minimum Wallhaven favorites, transitions, etc. Monitors are auto-detected; the `[[monitors]]` config section is only needed as a fallback when detection fails.

## Requirements

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)

**Linux:** [awww](https://codeberg.org/LGFae/awww), [Hyprland](https://hyprland.org/)

**macOS:** Python 3.12+, Node.js (for Electron GUI)

**Windows:** Windows 10/11, Python 3.12+, Node.js (for Electron GUI)

## License

[MIT](LICENSE)
