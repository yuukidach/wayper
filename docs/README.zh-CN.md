<p align="center">
  <img src="../assets/icon.svg" width="100" alt="wayper logo">
  <h1 align="center">wayper</h1>
  <p align="center">
    越用越懂你的壁纸管理器。<br>
    Wallhaven 集成 · AI 原生 · 全键盘操作。
  </p>
  <p align="center">
    <a href="#安装">安装</a> · <a href="#gui">GUI</a> · <a href="#cli">CLI</a> · <a href="#mcp-服务">MCP</a> · <a href="#配置">配置</a> · <a href="../README.md">English</a>
  </p>
</p>

<p align="center">
  <img src="../assets/demo-desktop.gif" alt="壁纸切换效果" width="720">
</p>

## 为什么选 wayper？

大多数壁纸工具止步于"设置桌面图片"。wayper 是一个完整的 **Wallhaven 客户端**，自动下载、筛选、轮换壁纸——而且越用越懂你的口味。

**核心差异：**

- **越用越聪明** — 拉黑壁纸后，wayper 分析你的模式。AI 驱动的标签分析会建议下一步排除什么，支持共现挖掘与多轮迭代反馈追踪。
- **AI 原生（MCP）** — 内置 [MCP](https://modelcontextprotocol.io/) 服务器。对 Codex 或 Claude 说 *"换一张有山的壁纸"* 或 *"收藏这张"* 就行。首个原生支持 AI 助手的壁纸管理器。
- **全键盘操作 GUI** — 每个操作都有快捷键。网格导航、灯箱预览、收藏、设置——完全不需要鼠标。为重度用户打造。

**基础能力：**

- **Wallhaven 集成** — 根据搜索偏好自动下载。收藏和标签黑名单同步到 Wallhaven 账号。
- **智能标签过滤** — 排除标签自动同步到 Wallhaven 云端黑名单（服务端过滤）；溢出的标签通过 URL 参数发送；剩余的在元数据获取后本地过滤。零浪费下载。
- **自动匹配方向** — 竖屏显示器自动用竖屏壁纸，无需分类。
- **三档纯度** — SFW、Sketchy、NSFW 独立开关，跨会话持久化。
- **跨平台** — Windows、macOS 和 Linux（Hyprland/Sway）。CLI + GUI + MCP。
- **`--json` 全覆盖** — 所有命令支持机器可读输出。

## 安装

### Arch Linux (AUR)

```bash
paru -S wayper     # 或: yay -S wayper
```

### Windows

从 [GitHub Releases](https://github.com/yuukidach/wayper/releases/latest) 下载最新版 Windows 安装包，或用 Python 3.12+ 从源码安装。

```powershell
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv
uv pip install -e .
```

### macOS

从 [GitHub Releases](https://github.com/yuukidach/wayper/releases/latest) 下载最新版 `.dmg`，或用 Python 3.12+ 从源码安装。

### 从源码安装

```bash
git clone https://github.com/yuukidach/wayper.git
cd wayper
uv venv && uv pip install -e .
uv pip install -e ".[browser]"  # 可选：浏览器 cookie 提取，用于 Wallhaven 同步
```

## GUI

<p align="center">
  <img src="../assets/browse.png" alt="GUI 浏览界面" width="720">
</p>

`wayper-gui` 启动独立应用，浏览、管理和控制壁纸集合。完全支持键盘操作，无需鼠标。

- **浏览与预览** — 网格浏览（缩略图缓存）、灯箱预览、Enter 设为壁纸
- **标签搜索** — 按 Wallhaven 标签、分类或文件名搜索，支持自动补全
- **智能建议** — 分析拉黑模式，推荐要排除的标签；共现挖掘找出跨排除个体的共同描述符；支持组合排除（如"tattoo + nude"）精细过滤
- **AI 分析** — 基于 Codex 的深度分析，支持迭代反馈。识别上传者模式并建议 Wallhaven 用户黑名单候选。点击建议标签可预览匹配图片
- **设置** — 在 GUI 中配置下载目录、Wallhaven 查询、排除标签/组合、纯度和显示器。修改即时生效，无需重启 daemon
- **全键盘操作** — 每个操作都有快捷键：网格导航、标签切换、灯箱、收藏、拉黑、撤销

**网格浏览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `1` `2` `3` | 壁纸池 / 收藏 / 黑名单 | `F1` `F2` `F3` | 切换 SFW / Sketchy / NSFW |
| `h` / `l` | 上一张 / 下一张壁纸 | `f` | 收藏 |
| `x` / `Del` | 拉黑 / 移除 | `u` | 撤销拉黑 |
| `o` | 在 Wallhaven 打开 | `s` | 设置 |
| `/` | 聚焦搜索栏 | `Esc` | 清除搜索 / 取消聚焦 |
| `Enter` / `Space` | 预览（灯箱） | 方向键 | 网格导航 |
| `[` / `]` | 黑名单：可恢复 / 全部 | `a` | AI 分析（黑名单视图） |
| `g` | 定位当前壁纸 | `gg` / `G` | 跳到第一张 / 最后一张 |
| `4`–`9` | 切换显示器 | | |

**灯箱预览：**

| 按键 | 操作 | 按键 | 操作 |
|------|------|------|------|
| `←` / `→` | 上一张 / 下一张（缩放时为平移） | `Enter` | 设为壁纸 |
| `f` | 收藏 | `x` / `Del` | 拉黑 |
| `a`（Model review） | 保留预览中的候选图 | `o` | 在 Wallhaven 打开 |
| `Space` / `Esc` | 关闭灯箱 | | |
| 滚轮 | 在光标位置缩放（0.5×–8×） | 拖拽 | 缩放时平移 |
| `0` | 重置为适应窗口 | `+` / `-` | 放大 / 缩小 |
| 双击 | 100% / 适应窗口切换 | | |

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
wayper ban                  # 拉黑 + 切换
wayper unban                # 撤销上次拉黑
wayper mode                 # 切换 sfw↔nsfw（保留 sketchy 状态）
wayper mode sketchy         # 开关 sketchy
wayper mode sfw,sketchy     # 设置精确组合
wayper suggest             # 基于频率的标签排除建议
wayper suggest --ai        # 通过 Codex CLI 进行 AI 分析
wayper model train         # 训练轻量的本地元数据排序模型
wayper model score --tags "tag1,tag2"  # 解释本地“不喜欢”评分
wayper model status        # 查看已保存模型和近期验证结果
wayper status               # 查看当前状态
wayper-gui                  # GUI 应用（浏览、操作、daemon、设置）
wayper setup                # 安装 .desktop（Linux）
wayper --json status        # JSON 格式输出
```

`wayper model train` 只读取本地 Wallhaven 元数据——规范化 tag，以及紧凑的颜色/分类/纯度
上下文——不会打开图片或分析像素。基础模型仍可只用 Python 标准库运行；tag-pair 仍需通过
`--max-combos` 显式实验。若要启用更强的本地文本 head，可安装
`uv pip install -e '.[semantic]'`；它通过 FastEmbed 使用 `BAAI/bge-small-en-v1.5`，编码的
仍然只有元数据文本，并在本地持久化 embedding cache，首次训练填充 cache 时可能较慢。
在还没有任何 Model review 决策时，安装可以暂时用旧的黑名单/收藏数据启动；一旦出现 **Model
review** 的 Ban 或 Keep，后续新的训练标签只来自这些明确的复核决策，普通图库操作不会被默认为标签。
可选的 semantic head 会从同一批复核样本学习相近的元数据模式，不需要手写人物或地区规则。近期拉黑
的权重更高；池中从未明确 Keep 的图片只作为背景对照，不能证明「喜欢」。Model review 以学习到的证据
排序，并对最强的具体 dislike 信号做有限加权，同时限制同一理由的重复数量。该分数不是校准概率；
自动跳过仍保持关闭，直到独立的验证/校准安全门通过。

GUI「拉黑」页面的 **Model review** 会显示排序后的候选图，并同时展示不喜欢证据和反向（Keep）证据：
「Ban」仍走普通的拉黑＋系统回收站流程，同时记录这是 review 操作；「Keep」记录明确的正反馈。
从图库首行按上方向键或用 Tab 将焦点移到候选卡片后，可用 `Enter`/`Space` 预览、`A` 保留、`X`/`Delete` 拉黑；方向键会按候选卡片的实际行列移动，
预览灯箱中可用左右键切换候选，且同样支持 `A`、`X`/`Delete`。反馈追加到本地 JSONL 事件日志（旧 JSON 日志仍可读取），
每累计 10 条新反馈，Wayper 会排队做一次本地全量重训；`wayper model status` 会显示待处理数量和模型版本。

### 快捷键示例

**Hyprland：**

```ini
bind = $mod, F9,       exec, wayper ban
bind = $mod SHIFT, F9, exec, wayper unban
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
cmd-shift-b = 'exec-and-forget wayper ban'
cmd-shift-f = 'exec-and-forget wayper fav'
```

## MCP 服务

wayper 内置 [MCP](https://modelcontextprotocol.io/) 服务器，让 AI 助手原生控制壁纸。

请使用 `wayper-mcp` 的绝对路径。源码安装后通常是 `.venv/bin/wayper-mcp`。

**Codex：**

```bash
codex mcp add wayper -- /path/to/wayper/.venv/bin/wayper-mcp
```

或编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.wayper]
command = "/path/to/wayper/.venv/bin/wayper-mcp"
```

**Claude Code：**

添加到 `~/.claude/.mcp.json`：

```json
{
  "mcpServers": {
    "wayper": {
      "command": "/path/to/wayper/.venv/bin/wayper-mcp"
    }
  }
}
```

可用工具：`status` · `next_wallpaper` · `prev_wallpaper` · `fav` · `unfav` · `ban` · `unban` · `set_mode` · `delete_wallpaper` · `wallpaper_info` · `tag_stats_top` · `tag_stats_lookup` · `tag_stats_combo` · `uploader_stats_lookup`

## 配置

Linux/macOS：

```bash
mkdir -p ~/.config/wayper
cp example-config.toml ~/.config/wayper/config.toml
```

Windows：

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\wayper"
Copy-Item example-config.toml "$env:APPDATA\wayper\config.toml"
```

壁纸下载目录可在 GUI 设置页修改，也可编辑 [`example-config.toml`](../example-config.toml) 中的 `download_dir`。详见该文件的所有选项 — API key、代理、轮换间隔、配额、Wallhaven 最低收藏数、转场效果等。显示器会自动检测，`[[monitors]]` 配置段仅在检测失败时作为兜底。

## 依赖

- Python 3.12+
- [Wallhaven API key](https://wallhaven.cc/settings/account)

**Linux：** [awww](https://codeberg.org/LGFae/awww)、[Hyprland](https://hyprland.org/)

**macOS：** Python 3.12+、Node.js（用于 Electron GUI）

**Windows：** Windows 10/11、Python 3.12+、Node.js（用于 Electron GUI）

## 许可

[MIT](../LICENSE)
