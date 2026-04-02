<p align="center">
  <img src="../assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    跨平台壁纸管理器，集成 <a href="https://wallhaven.cc">Wallhaven</a> 和 AI 原生控制。
  </p>
  <p align="center">
    <a href="#安装">安装</a> · <a href="#gui">GUI</a> · <a href="#cli">CLI</a> · <a href="#mcp-服务">MCP</a> · <a href="#配置">配置</a> · <a href="../README.md">English</a>
  </p>
</p>

<p align="center">
  <img src="../assets/demo-desktop.gif" alt="壁纸切换效果" width="720">
</p>

## 为什么选 wayper？

- **Wallhaven 集成** — 根据搜索偏好自动从 [Wallhaven](https://wallhaven.cc) 下载壁纸，无需手动找图。
- **自动匹配方向** — 竖屏显示器自动用竖屏壁纸，横屏用横屏。无需手动分类。
- **壁纸池管理** — 验证图片、裁剪至显示器分辨率、定时轮换。
- **三档纯度** — SFW、Sketchy、NSFW 独立开关，跨会话持久化。
- **智能标签排除** — 分析拉黑历史，自动发现反复拉黑的标签。支持单标签和组合排除（如"tattoo + nude"），精细过滤。排除规则仅在下载时过滤——已保留的壁纸池图片不会被移除。
- **AI 分析** — 通过 Claude CLI 深度分析拉黑模式，生成排除规则建议，支持多轮迭代历史追踪。每轮分析会反思历史建议和用户反馈。
- **跨平台 GUI** — 浏览、预览、搜索和管理整个壁纸集合。标签搜索、智能建议、AI 分析、daemon 控制、设置——全键盘操作。
- **AI 原生** — 内置 MCP 服务器，AI 助手可以直接控制壁纸。
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

## GUI

<p align="center">
  <img src="../assets/browse.png" alt="GUI 浏览界面" width="720">
</p>

`wayper-gui` 启动独立应用，浏览、管理和控制壁纸集合。完全支持键盘操作，无需鼠标。

- **浏览与预览** — 网格浏览（缩略图缓存）、灯箱预览、Enter 设为壁纸
- **标签搜索** — 按 Wallhaven 标签、分类或文件名搜索，支持自动补全
- **智能建议** — 分析拉黑模式，推荐要排除的标签；支持组合排除（如"tattoo + nude"）精细过滤
- **AI 分析** — 基于 Claude 的深度分析，支持迭代反馈。点击建议标签可预览匹配图片
- **设置** — 在 GUI 中配置 Wallhaven 查询、排除标签/组合、纯度和显示器。修改即时生效，无需重启 daemon
- **全键盘操作** — 每个操作都有快捷键：网格导航、标签切换、灯箱、收藏、拉黑、撤销

**网格浏览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `1` `2` `3` | 壁纸池 / 收藏 / 黑名单 | `F1` `F2` `F3` | 切换 SFW / Sketchy / NSFW |
| `h` / `l` | 上一张 / 下一张壁纸 | `f` | 收藏 |
| `x` / `Del` | 拉黑 / 移除 | `z` | 撤销拉黑 |
| `o` | 在 Wallhaven 打开 | `s` | 设置 |
| `/` | 聚焦搜索栏 | `Esc` | 清除搜索 / 取消聚焦 |
| `Enter` / `Space` | 预览（灯箱） | 方向键 | 网格导航 |
| `[` / `]` | 黑名单：可恢复 / 全部 | `a` | AI 分析（黑名单视图） |
| `g` | 定位当前壁纸 | `gg` / `G` | 跳到第一张 / 最后一张 |
| `4`–`9` | 切换显示器 | | |

**灯箱预览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `←` / `→` | 上一张 / 下一张 | `Enter` | 设为壁纸 |
| `f` | 收藏 | `x` / `Del` | 拉黑 |
| `o` | 在 Wallhaven 打开 | `Space` / `Esc` | 关闭灯箱 |

## CLI

<p align="center">
  <img src="../assets/demo-cli.gif" alt="命令行演示" width="720">
</p>

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
wayper suggest             # 基于频率的标签排除建议
wayper suggest --ai        # 通过 Claude CLI 进行 AI 分析
wayper status               # 查看当前状态
wayper-gui                  # GUI 应用（浏览、操作、daemon、设置）
wayper setup                # 安装 .desktop（Linux）
wayper --json status        # JSON 格式输出
```

### 快捷键示例

**Hyprland：**

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

**AeroSpace (macOS)：**

```toml
cmd-shift-n = 'exec-and-forget wayper next'
cmd-shift-b = 'exec-and-forget wayper dislike'
cmd-shift-f = 'exec-and-forget wayper fav'
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

详见 [`example-config.toml`](../example-config.toml) — API key、代理、轮换间隔、配额、转场效果等。显示器会自动检测，`[[monitors]]` 配置段仅在检测失败时作为兜底。

## 依赖

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)

**Linux：** [awww](https://codeberg.org/LGFae/awww)、[Hyprland](https://hyprland.org/)

**macOS：** Python 3.12+、Node.js（用于 Electron GUI）

## 许可

[MIT](../LICENSE)
