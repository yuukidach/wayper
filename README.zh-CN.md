<p align="center">
  <img src="assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    Wayland 优先的壁纸管理器，集成 <a href="https://wallhaven.cc">Wallhaven</a> 和 AI 原生控制。
  </p>
  <p align="center">
    <a href="#安装">安装</a> · <a href="#使用">使用</a> · <a href="#mcp-服务">MCP</a> · <a href="#配置">配置</a> · <a href="README.md">English</a>
  </p>
</p>

<p align="center">
  <img src="assets/demo-desktop.gif" alt="壁纸切换效果" width="720">
</p>

<details>
<summary>CLI 演示</summary>
<p align="center">
  <img src="assets/demo-cli.gif" alt="命令行演示" width="720">
</p>
</details>

## 为什么选 wayper？

- **自动匹配方向** — 竖屏显示器自动用竖屏壁纸，横屏用横屏。无需手动分类。
- **壁纸池管理** — 自动下载、验证（检测损坏图片）、裁剪至显示器分辨率、定时轮换。
- **SFW/NSFW 切换** — 一键切换，跨会话持久化。
- **收藏与黑名单** — 喜欢/不喜欢，支持撤销。收藏的壁纸继续参与轮换。
- **GTK4 浏览器** — 浏览、预览和管理壁纸集合，支持键盘快捷键。可从 rofi 等启动器打开。
- **AI 原生** — 内置 MCP 服务器，AI 助手（Claude Code 等）可以直接控制壁纸。对 AI 说"删掉这张坏壁纸"或"收藏这张"就能执行。
- **JSON 输出** — 所有命令支持 `--json`，方便脚本和自动化。

## 安装

### Arch Linux (AUR)

```bash
paru -S wayper     # 或: yay -S wayper
```

### 从源码安装

```bash
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv && uv pip install -e .
```

## 使用

```
wayper daemon               # 启动后台轮换 + 下载
wayper next                 # 切换当前显示器壁纸
wayper fav [--open]         # 收藏当前壁纸
wayper unfav                # 取消收藏
wayper dislike              # 拉黑 + 切换
wayper undislike            # 撤销上次拉黑
wayper mode [sfw|nsfw]      # 切换模式
wayper status               # 查看当前状态
wayper browse               # GTK4 壁纸浏览器
wayper setup                # 安装桌面入口（rofi 等启动器）
wayper --json status        # JSON 格式输出
```

### 浏览器

GTK4 壁纸浏览器，支持缩略图网格、全尺寸预览和键盘快捷键。

<p align="center">
  <img src="assets/browse.png" alt="浏览器窗口" width="540">
</p>

```
方向键     导航网格               1/2/3    切换分类
Enter      设为壁纸               m        切换 SFW/NSFW
f          收藏                   x        移除/拒绝/恢复
o          在 Wallhaven 打开      d        删除
q/Esc      关闭
```

运行 `wayper setup` 安装桌面入口，之后可通过 rofi 等启动器打开。

### Hyprland 快捷键示例

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

## MCP 服务

wayper 内置 [MCP](https://modelcontextprotocol.io/) 服务器，让 AI 助手原生控制壁纸。

添加到 Claude Code 配置（`~/.claude/.mcp.json`）：

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/.venv/bin/wayper-mcp"
    }
  }
}
```

可用工具：`status` · `next_wallpaper` · `fav` · `unfav` · `dislike` · `undislike` · `set_mode` · `delete_wallpaper`

## 配置

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

详见 [`example-config.toml`](example-config.toml) — 显示器、API key、代理、轮换间隔、配额、转场效果等。

## 依赖

- Python 3.12+
- [swww](https://github.com/LGFae/swww) — Wayland 壁纸引擎
- [Hyprland](https://hyprland.org/) — 用于检测当前聚焦的显示器
- [Wallhaven API key](https://wallhaven.cc/settings/account)
- [GTK4](https://gtk.org/) + [PyGObject](https://pygobject.gnome.org/) — 用于 `wayper browse`（安装：`sudo pacman -S python-gobject gtk4`）

## 许可

[MIT](LICENSE)
