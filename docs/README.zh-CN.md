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

<details>
<summary>GUI 截图</summary>
<p align="center">
  <img src="assets/browse.png" alt="GUI 浏览界面" width="720">
</p>
</details>

## 为什么选 wayper？

- **Wallhaven 集成** — 根据搜索偏好自动从 [Wallhaven](https://wallhaven.cc) 下载壁纸，无需手动找图。
- **自动匹配方向** — 竖屏显示器自动用竖屏壁纸，横屏用横屏。无需手动分类。
- **壁纸池管理** — 验证（检测损坏图片）、裁剪至显示器分辨率、定时轮换。
- **三档纯度** — SFW、Sketchy、NSFW 独立开关，跨会话持久化。
- **历史导航** — 前进/后退浏览壁纸历史，按显示器独立记录。
- **收藏与黑名单** — 喜欢/不喜欢，支持撤销。收藏的壁纸继续参与轮换。
- **跨平台 GUI** — 浏览、预览和管理壁纸集合，集成 daemon 控制和设置。支持 Linux 和 macOS。
- **标签搜索** — 按 Wallhaven 标签、分类或文件名搜索壁纸集合。自动补全建议，跨所有视图（壁纸池、收藏、黑名单）生效。
- **智能标签建议** — 分析你的拉黑历史，自动发现反复拉黑的标签。在黑名单中预览匹配图片，一键排除。不用再猜该屏蔽哪些标签。
- **全键盘操作** — 每个操作都有快捷键。网格导航、灯箱预览、收藏、拉黑——完全不需要鼠标。
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
wayper next                 # 下一张壁纸（历史前进或随机新壁纸）
wayper prev                 # 上一张壁纸（历史后退）
wayper fav [--open]         # 收藏当前壁纸
wayper unfav                # 取消收藏
wayper dislike              # 拉黑 + 切换
wayper undislike            # 撤销上次拉黑
wayper mode                 # 切换 sfw↔nsfw（保留 sketchy 状态）
wayper mode sketchy         # 开关 sketchy
wayper mode sfw,sketchy     # 设置精确组合
wayper status               # 查看当前状态
wayper-gui                  # GUI 应用（浏览、操作、daemon、设置）
wayper setup                # 安装 .desktop（Linux）
wayper --json status        # JSON 格式输出
```

### GUI 应用

`wayper-gui` 启动独立应用，集成浏览、快捷操作（下一张/上一张/收藏/拉黑）、daemon 控制和设置。完全支持键盘操作，无需鼠标。

**网格浏览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `1` `2` `3` | 壁纸池 / 收藏 / 黑名单 | `F1` `F2` `F3` | 切换 SFW / Sketchy / NSFW |
| `h` / `l` | 上一张 / 下一张壁纸 | `f` | 收藏 |
| `x` / `Del` | 拉黑 / 移除 | `z` | 撤销拉黑 |
| `o` | 在 Wallhaven 打开 | `s` | 设置 |
| `/` | 聚焦搜索栏 | `Esc` | 清除搜索 / 取消聚焦 |
| `Enter` / `Space` | 预览（灯箱） | 方向键 | 网格导航 |
| `[` / `]` | 黑名单：可恢复 / 全部 | `4`–`9` | 切换显示器 |

**灯箱预览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `←` / `→` | 上一张 / 下一张 | `Enter` | 设为壁纸 |
| `f` | 收藏 | `x` / `Del` | 拉黑 |
| `o` | 在 Wallhaven 打开 | `Space` / `Esc` | 关闭灯箱 |

### Hyprland 快捷键示例

```ini
bind = $mod, F9,       exec, wayper dislike
bind = $mod SHIFT, F9, exec, wayper undislike
bind = $mod, F10,      exec, wayper fav
bind = $mod SHIFT, F10,exec, wayper unfav
bind = $mod CTRL, F10, exec, wayper fav --open
bind = $mod, F11,      exec, wayper next
bind = $mod SHIFT, F11,exec, wayper prev
bind = $mod, F12,      exec, wayper mode
bind = $mod SHIFT, F12,exec, wayper mode sketchy
exec-once = wayper daemon
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

可用工具：`status` · `next_wallpaper` · `prev_wallpaper` · `fav` · `unfav` · `dislike` · `undislike` · `set_mode` · `delete_wallpaper`

## 配置

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

详见 [`example-config.toml`](example-config.toml) — 显示器、API key、代理、轮换间隔、配额、转场效果等。

## 依赖

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)

**Linux:** [awww](https://codeberg.org/LGFae/awww)、[Hyprland](https://hyprland.org/)

**macOS:** Python 3.12+、Node.js（用于 Electron GUI）

## 许可

[MIT](LICENSE)
