import type { LanguagePreference } from "./types";

export type ResolvedLocale = "en" | "zh";

export function normalizeLanguagePreference(raw: unknown): LanguagePreference {
  const value = String(raw ?? "auto").trim().toLowerCase().replace(/_/g, "-");
  if (!value || value === "auto" || value === "自动") return "auto";
  if (
    value === "en" ||
    value === "english" ||
    value.startsWith("en-")
  ) {
    return "en";
  }
  if (
    value === "zh" ||
    value === "chinese" ||
    value === "简体中文" ||
    value === "繁體中文" ||
    value.startsWith("zh-")
  ) {
    return "zh";
  }
  return "auto";
}

export function resolveLocale(
  preference: LanguagePreference,
  systemLocale?: string,
): ResolvedLocale {
  if (preference === "en" || preference === "zh") return preference;
  const candidate =
    systemLocale ||
    (typeof navigator !== "undefined"
      ? navigator.languages?.[0] || navigator.language
      : "") ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    "en";
  return /^zh(?:[-_]|$)/i.test(candidate) ? "zh" : "en";
}

const ZH_STRINGS: Record<string, string> = {
  // Brand & Header
  "Search tags, @uploader, or filename...": "搜索标签、@上传者或文件名…",
  "Clear search": "清除搜索",
  "Previous wallpaper": "上一张壁纸",
  "Next wallpaper": "下一张壁纸",
  "Next": "下一张",
  "Nothing showing yet": "还没有壁纸",
  "Locate current wallpaper": "定位当前壁纸",
  "Undo last ban or dislike": "撤销上次拉黑或不喜欢",
  "Clear auto-held": "清空自动拦截",
  "Update available": "发现新版本",

  // Sidebar Sections
  "Displays": "显示器",
  "Library": "壁纸库",
  "Pool": "候选池",
  "Favorites": "收藏夹",
  "Curation": "筛选与审核",
  "Review": "模型审核",
  "Blocklist": "黑名单",
  "Filter Strategy": "自动过滤策略",
  "Rules": "规则",
  "Model": "模型",
  "Both": "规则+模型",
  "Purity": "分级",
  "SFW": "全年龄",
  "Sketchy": "擦边",
  "NSFW": "成人",
  "Safe mode is enabled": "安全模式已开启",
  "API key required for NSFW": "开启成人分级需要配置 API Key",
  "Pause Auto Rotation": "暂停自动换壁纸",
  "Resume Auto Rotation": "继续自动换壁纸",
  "Configure Auto Rotation": "配置自动换壁纸",
  "Settings": "设置",
  "landscape": "横屏",
  "portrait": "竖屏",
  "Landscape": "横屏",
  "Portrait": "竖屏",
  "Active": "已应用",
  "Empty": "空闲",

  // Gallery & Cards
  "Apply wallpaper": "设为壁纸",
  "Set Wallpaper": "设为壁纸",
  "Set Greeter": "设为登录背景",
  "Favorite": "收藏",
  "Unfavorite": "取消收藏",
  "Dislike": "不喜欢",
  "Ban": "仅拉黑此图",
  "Restore": "恢复到候选池",
  "Open on Wallhaven": "在 Wallhaven 打开",
  "Wallhaven": "Wallhaven",
  "Keep": "保留",
  "Inspect metadata": "查看图片详情",
  "Loading library...": "正在加载壁纸库…",
  "No wallpapers in Pool yet": "候选池暂无壁纸",
  "No favorites yet": "暂无收藏壁纸",
  "Press Next [L] or trigger a sync to pull fresh wallpapers from Wallhaven.": "按 L 切换下一张或等待自动拉取新壁纸。",
  "Mark wallpapers you love with [F] to build your collection and guide the model.": "按 F 收藏喜欢的壁纸，同时为偏好模型提供正向样本。",
  "No matches found": "未找到匹配的壁纸",
  "Clear filter": "清除筛选",

  // Model Review
  "Auto-held": "自动拦截",
  "Recommended": "主动推荐",
  "Review is temporarily unavailable": "审核功能暂时不可用",
  "The model is still learning": "偏好模型正在积累样本",
  "You're all caught up": "待审核队列已全部处理完毕",
  "Dislike wallpapers with [D] and favorite or keep ones you like so the two-stage model can calibrate to 80% precision.": "使用 D 标记不喜欢、使用 F 收藏或保留喜欢的壁纸，积累足够正负样本后模型会自动完成 80% 精度校准。",
  "No auto-held or recommended candidates need your review right now.": "当前分级与屏幕方向下没有需要人工确认的候选壁纸。",
  "Browse Pool": "浏览候选池",
  "Back to Pool": "返回候选池",
  "Try again": "重试",
  "Retrain model": "立即重训模型",
  "Model Ready": "模型已就绪",
  "Calibrating": "学习校准中",
  "Untrained": "尚未训练",
  "Dislike score": "不喜欢评分",
  "left": "剩余",
  "Swipe or press a key to decide": "拖动卡片或按键决定",
  "View options": "显示选项",
  "Storage": "存储",
  "Size": "尺寸",
  "Categories": "分类",
  "Source": "来源",
  "Account": "账号",
  "Application": "应用",
  "Rotation": "轮换",
  "Threshold": "拦截阈值",
  "Similar to a disliked wallpaper": "与不喜欢的壁纸相似",
  "View full size": "查看大图",
  "Tag": "标签",

  // Blocklist & Suggestions
  "Recoverable": "可恢复",
  "All Blocked": "全部记录",
  "Exclusion rules": "排除规则",
  "Blocked": "已屏蔽",
  "Kept": "保留",
  "In your library": "图库中",
  "No rule suggestions yet": "还没有可用的规则建议",
  "What shows up most in the wallpapers you blocked. Exclude one and new downloads skip it.":
    "这些内容在你屏蔽的壁纸里出现得最多。排除之后，新的下载会跳过它们。",
  "Tags": "标签",
  "Tag combos": "标签组合",
  "Uploaders": "上传者",
  "Exclude": "排除",
  "Exclude combo": "排除该组合",
  "Exclude uploader": "排除该上传者",
  "Excluded": "已排除",
  "Undo": "撤销",
  "Exclusion undone": "已撤销排除",
  "Excluded so far": "已排除的规则",
  "Remove": "移除规则",
  "Back": "返回",
  "Often blocked together with": "常一起被屏蔽",
  "Copied": "已复制",
  "In Trash": "在回收站",
  "Deleted": "已清理",
  "Unblock": "解除拉黑",
  "No recoverable wallpapers in system trash": "系统回收站中没有可恢复的壁纸",
  "No blocked wallpapers recorded": "暂无拉黑记录",
  "Trash access requires Full Disk Access": "读取系统回收站需要授予完全磁盘访问权限",
  "Trash folder is not readable": "无法读取系统回收站目录",
  "Open System Settings": "打开系统设置",

  // Lightbox & Inspector
  "Zoom in": "放大",
  "Zoom out": "缩小",
  "Reset zoom": "重置缩放",
  "Close": "关闭",
  "Details": "详情面板",
  "Resolution": "分辨率",
  "Category": "分类",
  "Uploader": "上传者",
  "Palette": "主色调",
  "Tags & Concepts": "标签",

  // Settings
  "General": "常规",
  "Filters": "过滤规则",
  "Save Changes": "保存更改",
  "Saving...": "保存中…",
  "Cancel": "取消",
  "Rotation Interval (minutes)": "自动轮换间隔（分钟）",
  "Set 0 to disable automatic rotation.": "设为 0 表示关闭自动换壁纸。",
  "Wallpaper Display Mode": "壁纸缩放模式",
  "Crop to fill": "裁剪铺满 (Crop)",
  "Fit entire image": "完整适应 (Fit)",
  "Stretch to fill": "拉伸填充 (Stretch)",
  "Original size": "原始尺寸 (Original)",
  "Available on Linux (awww) only": "仅在 Linux (awww) 下可用",
  "Applies the next time a wallpaper is set.": "保存后将在下次切换壁纸时生效。",
  "Language": "界面语言",
  "Auto (System)": "自动跟随系统",
  "Disk Quota (MB)": "磁盘配额（MB）",
  "Download Batch Size": "单次拉取数量",
  "Download Folder": "壁纸存储目录",
  "Browse": "浏览…",
  "HTTP / SOCKS Proxy": "网络代理 (HTTP / SOCKS)",
  "Start at Login": "开机自动启动（后台托盘）",
  "Pause on Screen Lock": "锁屏时暂停自动轮换",
  "Safe Mode (Lock to SFW)": "安全模式（锁定全年龄 SFW）",
  "Blacklist Expiry (days)": "黑名单保留天数",
  "Never expire": "永不过期",
  "API Key": "Wallhaven API Key",
  "Get API key on Wallhaven": "前往 Wallhaven 获取 API Key",
  "Username": "Wallhaven 用户名",
  "Password (optional)": "密码（可选）",
  "Web Session": "网页登录会话（用于同步收藏与云端黑名单）",
  "Sign in with Browser Window": "打开内置窗口登录",
  "Reconnect Session": "重新验证会话",
  "Session connected": "会话已连接",
  "Categories (General / Anime / People)": "分类（综合 / 动漫 / 人物）",
  "GeneralCat": "综合",
  "AnimeCat": "动漫",
  "PeopleCat": "人物",
  "Top Range": "排行榜时间跨度",
  "Sorting": "排序方式",
  "Toplist": "排行榜",
  "Hot": "热门",
  "Random": "随机",
  "Views": "浏览量",
  "AI Art": "AI 绘图过滤",
  "Allow AI Art": "允许 AI 作品",
  "Block AI Art": "屏蔽 AI 作品",
  "Excluded Tags": "排除单标签",
  "Excluded Tag Combos": "排除组合标签（同时命中才排除）",
  "Excluded Uploaders": "排除上传者",
  "Add tag...": "输入标签回车添加…",
  "tag1 + tag2": "标签1 + 标签2",
  "Add uploader...": "输入上传者用户名…",
  "Add": "添加",

  // Footer & Tray
  "Auto-rotation active": "自动轮换运行中",
  "Auto-rotation paused": "自动轮换已暂停",
  "Auto-rotation off": "自动轮换已关闭",
  "Open Wayper": "打开 Wayper",
  "Next Wallpaper": "下一张壁纸",
  "Auto Rotation Off": "自动换壁纸已关闭",
  "Quit Wayper": "退出 Wayper",
};

export function translate(locale: ResolvedLocale, key: string): string {
  if (locale === "en") return key;
  return ZH_STRINGS[key] ?? key;
}

export function createTranslator(locale: ResolvedLocale) {
  return (key: string): string => translate(locale, key);
}
