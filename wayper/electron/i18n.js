/*
 * Small, dependency-free renderer translation layer.
 *
 * The GUI deliberately keeps its source strings in English so that older
 * plugins and screenshots remain readable.  This file translates those
 * strings in place and watches newly-rendered cards/panels, which means the
 * split renderer modules do not need to coordinate a second render pass.
 * ``auto`` follows Electron's navigator/Intl locale; ``en`` and ``zh`` are
 * explicit user overrides persisted by the normal Wayper config endpoint.
 */
(function () {
    'use strict';

    const root = typeof window === 'undefined' ? globalThis : window;

    const ZH = {
        'Search tags...': '搜索标签…',
        'Clear search (Esc)': '清除搜索（Esc）',
        'Previous Wallpaper': '上一张壁纸',
        'Next Wallpaper': '下一张壁纸',
        'Locate Current Wallpaper': '定位当前壁纸',
        'Undo Last Ban or Dislike': '撤销上次屏蔽或不喜欢',
        Library: '我的壁纸',
        Pool: '图库',
        Favorites: '收藏',
        Filtering: '筛选管理',
        'Filtering workflows': '筛选与确认',
        Review: '待确认',
        'Review queue': '待确认图片',
        Blocklist: '已屏蔽',
        'Blocklist and tag rules': '已屏蔽图片与排除规则',
        'Automatic filtering': '下载筛选方式',
        'Automatic filter strategy': '选择下载筛选方式',
        'Model decisions only': '仅按偏好模型判断',
        'Rules first, then model': '先应用排除规则，再由偏好模型判断',
        'Rule exclusions only': '仅应用排除规则',
        'Rules only': '仅使用规则',
        'Model only': '仅使用偏好模型',
        'Rules and model': '同时使用规则和偏好模型',
        Rules: '规则',
        Model: '模型',
        Both: '两者',
        Monitors: '显示器',
        Purity: '内容级别',
        Sketchy: '轻度敏感',
        'Pause Auto Rotation': '暂停自动换壁纸',
        'Resume Auto Rotation': '继续自动换壁纸',
        'Configure Auto Rotation': '设置自动换壁纸',
        'Pausing...': '正在暂停…',
        'Resuming...': '正在恢复…',
        'Checking auto rotation...': '正在读取自动换壁纸状态…',
        'Auto Rotation Active': '自动换壁纸已开启',
        'Auto Rotation Paused': '自动换壁纸已暂停',
        'Auto Rotation Off': '自动换壁纸已关闭',
        Active: '正在使用',
        Empty: '未设置',
        'In Trash': '可从回收站恢复',
        Deleted: '已删除',
        Unblock: '解除屏蔽',
        'Loading wallpapers...': '正在加载壁纸…',
        'Wayper update available': 'Wayper 有可用更新',
        Settings: '设置',
        'Configure Wayper behavior and sources': '设置自动换壁纸、下载来源和存储方式',
        General: '基本设置',
        Language: '语言',
        'System default': '跟随系统',
        English: '英语',
        'Simplified Chinese': '简体中文',
        'Use the system language unless you choose an override': '除非手动指定，否则使用系统语言',
        'Interval (minutes)': '自动更换间隔（分钟）',
        'Disk Quota (MB)': '存储上限（MB）',
        'Download Folder': '壁纸文件夹',
        'Choose Folder': '选择文件夹',
        'New downloads and library views use this folder': '新下载的壁纸和图库都使用此文件夹',
        Proxy: '代理',
        'Leave empty for direct connection': '不填写则直接连接',
        'Pause on Lock': '锁屏时暂停换壁纸',
        'Pause wallpaper rotation when screen is locked': '屏幕锁定期间不自动更换壁纸',
        'Safe Mode': '仅安全内容',
        'Lock purity to SFW only': '开启后只显示 SFW 壁纸',
        'Blacklist Expiry (days)': '屏蔽记录保留（天）',
        'Never expire': '永不过期',
        'How long disliked images stay blacklisted': '“不喜欢”的壁纸在屏蔽记录中保留多久',
        'Wallhaven Source': 'Wallhaven 下载设置',
        'API Key': 'API 密钥',
        'Your Wallhaven API key': '你的 Wallhaven API 密钥',
        'Required for NSFW —': 'NSFW 需要密钥 —',
        'get your key': '获取密钥',
        'Wallhaven Username': 'Wallhaven 用户名',
        Username: '用户名',
        'Wallhaven Password': 'Wallhaven 密码',
        'For favorite sync; optional with browser cookies': '用于同步收藏；也可以改用浏览器 Cookie 登录',
        'Categories (General/Anime/People)': '分类（常规 / 动漫 / 人物）',
        '111 = All, 010 = Anime only': '111 = 全部，010 = 仅动漫',
        'Top Range': '热门时间范围',
        'Last Day': '最近一天',
        'Last 3 Days': '最近三天',
        'Last Week': '最近一周',
        'Last Month': '最近一个月',
        'Last 3 Months': '最近三个月',
        'Last 6 Months': '最近六个月',
        'Last Year': '最近一年',
        Sorting: '排序',
        Toplist: '热门榜',
        Hot: '热门',
        Random: '随机',
        Views: '浏览量',
        'AI Art Filter': 'AI 生成图片',
        'Allow AI': '允许 AI 生成图片',
        'Block AI': '排除 AI 生成图片',
        'Download Batch Size': '每批下载数量',
        'Maximum wallpapers to download per mode and orientation': '每种内容级别和屏幕方向单次最多下载多少张',
        'Minimum Favorites': 'Wallhaven 最低收藏数',
        'Skip Wallhaven downloads below this favorite count': '不下载 Wallhaven 收藏数低于此值的图片',
        'Exclusion Rules': '排除规则',
        'Exclude Tags': '排除标签',
        'Tag name...': '标签名称…',
        Add: '添加',
        'Tags to exclude from Wallhaven downloads': '从 Wallhaven 下载中排除的标签',
        'Exclude Combos': '组合规则',
        'Tag combinations — image excluded when ALL tags match': '图片同时包含组合内所有标签时跳过下载',
        'Exclude Uploaders': '排除上传者',
        'Username...': '用户名…',
        'Uploaders to exclude — synced to Wallhaven user blacklist': '跳过这些上传者，并同步到 Wallhaven 用户黑名单',
        Cancel: '取消',
        'Save Changes': '保存更改',
        'Saving...': '正在保存…',
        'Disk usage': '磁盘使用量',
        'Banned / kept / favorites': '屏蔽 / 保留 / 收藏',
        'Suggested exclusions': '排除建议',
        'Click a signal to review matching wallpapers': '点击一项依据，查看匹配的壁纸',
        Tags: '标签',
        Combos: '组合',
        tag: '标签',
        combo: '组合',
        uploader: '上传者',
        'Analyze exclusions with Codex': '使用 Codex 分析排除项',
        'Copy': '复制',
        Copied: '已复制',
        Dismiss: '关闭',
        Applied: '已应用',
        Removed: '已移除',
        'Suggested Additions': '建议添加',
        'Suggested Removals': '建议移除',
        'Cannot read images from Trash — grant': '无法读取回收站中的图片——请为终端开启',
        'Full Disk Access': '完全磁盘访问权限',
        'to your terminal in System Settings > Privacy & Security.': '（系统设置 > 隐私与安全性）。',
        'Open System Settings': '打开系统设置',
        'Open Settings': '打开设置',
        Analyzing: '分析中',
        'Preparing…': '准备中…',
        Preview: '预览',
        Keep: '保留',
        Dislike: '不喜欢',
        Ban: '屏蔽',
        Restore: '恢复',
        Set: '设为壁纸',
        Fav: '收藏',
        'Wallhaven': 'Wallhaven',
        'Open on Wallhaven (O)': '在 Wallhaven 打开（O）',
        'Set Wallpaper (Enter)': '设置为壁纸（Enter）',
        'Favorite (F)': '收藏（F）',
        'Dislike and teach the model (D)': '标记为“不喜欢”并让模型学习（D）',
        'Ban this exact image only (X)': '只屏蔽这张图，不用于训练模型（X）',
        'Restore to Pool': '移回图库',
        'Close (Esc)': '关闭（Esc）',
        'Previous card (Left arrow)': '上一张卡片（左方向键）',
        'Previous review card': '上一张待确认图片',
        'Next card (Right arrow)': '下一张卡片（右方向键）',
        'Review preview; use left and right arrows to switch candidates': '待确认图片预览；使用左右方向键切换',
        'Wallpaper preview': '壁纸预览',
        'Previous image': '上一张图片',
        'Next image': '下一张图片',
        'All Blocked': '全部屏蔽记录',
        Recoverable: '可恢复',
        Back: '返回',
        'Refine with': '继续添加条件',
        Exclude: '排除',
        'Exclude combo': '添加组合规则',
        'in pool': '在图库中',
        candidate: '候选图片',
        candidates: '候选图片',
        'Ranked candidate': '模型候选图片',
        'Auto-held': '已自动拦截',
        Recommended: '建议检查',
        Counter: '保留依据',
        'Similar to Dislike': '与“不喜欢”相似',
        'No individual feature explanation available': '暂无单独的特征说明',
        'Model review': '确认模型筛选结果',
        'Review source': '候选来源',
        'Model review card deck': '待确认图片',
        'Automatically held model review cards': '模型自动拦截的图片',
        'Model recommendation cards': '建议检查的图库图片',
        'Ranked by local tag/context evidence · Tab/Arrows · Enter/Space · A/D': '根据本地标签和使用情境排序 · Tab/方向键 · Enter/空格 · A/D',
        'Automatically held by the model · inspect, Keep or Dislike · Enter/Space · A/D': '已被模型自动拦截 · 确认保留或标记为不喜欢 · Enter/空格 · A/D',
        'There are no model recommendations waiting. Rules continue to filter new downloads.': '暂无建议检查的图片；排除规则仍会继续筛选新下载。',
        'There are no auto-held images or recommendations waiting for this monitor.': '当前显示器没有自动拦截或建议检查的图片。',
        'No automatically filtered images are waiting for review.': '没有需要确认的自动筛选图片。',
        'Automatic model filtering is off. Choose Model or Rules + model in Settings.': '偏好模型筛选未开启，请在设置中选择“模型”或“两者”。',
        'Train a local preference model to start reviewing candidates.': '训练本地偏好模型后，Wayper 才能找出需要确认的图片。',
        'Updating the local ranking model; review will appear shortly.': '正在更新本地偏好模型，稍后会显示待确认图片。',
        'No learned dislike-evidence candidates for this monitor and purity.': '当前显示器和内容级别下，没有与“不喜欢”反馈相似的图片。',
        'Recommended is ready; Auto-held will activate after the next calibration refresh.': '已可查看“建议检查”；“自动拦截”会在下次模型校准后启用。',
        'Keep or Dislike a few wallpapers to build enough preference feedback.': '请对几张壁纸选择“保留”或“不喜欢”，帮助模型了解你的偏好。',
        'Wayper could not update the review queue. Your wallpapers are unchanged.': 'Wayper 无法刷新待确认图片；现有壁纸没有变化。',
        'Open full preview (Enter / Space)': '打开完整预览（Enter / 空格）',
        'Open full preview (Enter/Space)': '打开完整预览（Enter/空格）',
        'Remove': '移除',
        'Click to preview matching images': '点击预览匹配的图片',
        'Next review card': '下一张待确认图片',
        'Needs attention': '需要处理',
        'Review is temporarily unavailable': '暂时无法加载待确认内容',
        'Try again': '重试',
        'Getting ready': '准备中',
        'The model is still learning': '模型还在了解你的偏好',
        'Browse Pool': '浏览图库',
        'Queue clear': '暂无待确认内容',
        'You’re all caught up': '都确认完了',
        'Back to Pool': '返回图库',
        'No wallpapers in': '没有壁纸：',
        'No matches for': '没有匹配项：',
        'No recoverable images in trash': '回收站中没有可恢复的图片',
        'No blocked images': '没有已屏蔽的图片',
        'No model recommendations waiting': '没有建议检查的图片',
    };

    const EN = Object.fromEntries(Object.keys(ZH).map(key => [key, key]));
    const ZH_TO_EN = Object.fromEntries(
        Object.entries(ZH).map(([key, value]) => [value, key]),
    );
    const TEXT_ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
    // User/content supplied labels must remain verbatim.  Without this
    // guard a wallpaper tag literally named "Model" or a monitor named
    // "Review" would be translated along with the surrounding controls.
    const CONTENT_IGNORE_SELECTORS = [
        '.monitor-name',
        '.breadcrumb-tag',
        '.suggestion-chip-name',
        '.model-review-name',
        '.model-review-feature',
        '.entry-name',
        '.ai-analysis-text',
        '.ai-suggestion-tags',
        '.ai-suggestion-reason',
        '.search-dropdown-item',
    ];
    const nodeState = new WeakMap();
    const attributeState = new WeakMap();
    let preference = 'auto';
    let activeLocale = detectSystemLocale();
    let observer = null;
    let applyQueued = false;
    const pendingMutationRoots = new Set();
    let applying = false;

    function detectSystemLocale() {
        let candidates = [];
        try {
            candidates = [
                ...(Array.isArray(navigator.languages) ? navigator.languages : []),
                navigator.language,
            ];
        } catch (_) {
            // Node-based renderer tests do not expose navigator.
        }
        try {
            candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
        } catch (_) {
            // Ignore missing Intl locale data.
        }
        return candidates.some(value => /^zh(?:[-_]|$)/i.test(String(value || '')))
            ? 'zh'
            : 'en';
    }

    function normalizePreference(value) {
        const normalized = String(value || 'auto').trim().toLowerCase().replace('_', '-');
        if (normalized === 'zh' || normalized.startsWith('zh-') || normalized === 'chinese') return 'zh';
        if (normalized === 'en' || normalized.startsWith('en-') || normalized === 'english') return 'en';
        return 'auto';
    }

    function interpolate(value, vars) {
        if (!vars || typeof vars !== 'object') return value;
        return value.replace(/\{(\w+)\}/g, (_, key) => (
            Object.hasOwn(vars, key) ? String(vars[key]) : `{${key}}`
        ));
    }

    function translateDynamic(source, locale) {
        if (locale !== 'zh') return source;
        let match = source.match(/^No matches for "([^"]*)"$/);
        if (match) return `没有匹配“${match[1]}”`;
        match = source.match(/^No wallpapers in (.+)$/);
        if (match) {
            const context = match[1]
                .replace(/\bpool\b/gi, '图库')
                .replace(/\bfavorites\b/gi, '收藏')
                .replace(/\btrash\b/gi, '回收站')
                .replace(/\bsfw\b/gi, 'SFW')
                .replace(/\bsketchy\b/gi, '轻度敏感')
                .replace(/\bnsfw\b/gi, 'NSFW');
            const [location, purity] = context.split(/\s*\/\s*/, 2);
            if (purity === '轻度敏感') return `${location}中没有轻度敏感内容的壁纸`;
            if (purity) return `${location}中没有 ${purity} 壁纸`;
            return `${location}中没有壁纸`;
        }
        match = source.match(/^(landscape|portrait) · (Active|Empty)$/i);
        if (match) {
            const orientation = match[1].toLowerCase() === 'portrait' ? '竖屏' : '横屏';
            return `${orientation} · ${match[2].toLowerCase() === 'active' ? '正在使用' : '未设置'}`;
        }
        match = source.match(/^(.+), (landscape|portrait), (active wallpaper|empty)$/i);
        if (match) {
            const orientation = match[2].toLowerCase() === 'portrait' ? '竖屏' : '横屏';
            const state = match[3].toLowerCase() === 'empty' ? '未设置' : '正在使用';
            return `${match[1]}，${orientation}，${state}`;
        }
        match = source.match(/^(\d+) (tag|combo|uploader)s?$/i);
        if (match) {
            const kind = { tag: '标签', combo: '组合', uploader: '上传者' }[match[2].toLowerCase()] || match[2];
            return `${match[1]} 个${kind}`;
        }
        match = source.match(/^(\d+) candidate(s?)$/);
        if (match) return `${match[1]} 张候选图片`;
        match = source.match(/^(\d+) (?:auto-held|recommended)$/);
        if (match) return source.endsWith('recommended')
            ? `${match[1]} 张建议检查`
            : `${match[1]} 张已自动拦截`;
        match = source.match(/^(\d+) banned$/);
        if (match) return `${match[1]} 张已屏蔽`;
        match = source.match(/^(\d+) in pool$/);
        if (match) return `${match[1]} 张在图库中`;
        match = source.match(/^Analyzing (\d+)s$/);
        if (match) return `分析中 ${match[1]} 秒`;
        match = source.match(/^(.+) feedback pending$/);
        if (match) return `${match[1]} 条反馈等待模型更新`;
        match = source.match(/^No learned dislike-evidence candidates; strongest review score (.+)$/);
        if (match) return `没有与“不喜欢”反馈相似的图片；最高待确认分数为 ${match[1]}`;
        match = source.match(/^model update pending$/i);
        if (match) return '等待更新模型';
        match = source.match(/^model refresh due$/i);
        if (match) return '模型需要更新';
        match = source.match(/^(.+) · boundary (.+)$/);
        if (match) return `${match[1]} · 判定阈值 ${match[2]}`;
        match = source.match(/^Similar to Dislike: (.+)$/);
        if (match) return `与“不喜欢”相似：${match[1]}`;
        match = source.match(/^Nearest explicit Dislike \((.+) similarity\)$/);
        if (match) return `最接近的“不喜欢”反馈（相似度 ${match[1]}）`;
        match = source.match(/^Preview (.+) \((Enter\/?Space)\)$/);
        if (match) return `预览 ${match[1]}（${match[2].replace('/', ' / ')}）`;
        match = source.match(/^Preview (.+) full image$/);
        if (match) return `预览 ${match[1]} 的完整图片`;
        match = source.match(/^Keep (.+) \(A\)$/);
        if (match) return `保留 ${match[1]}（A）`;
        match = source.match(/^Dislike (.+) and teach the model \(D\)$/);
        if (match) return `将 ${match[1]} 标记为“不喜欢”并让模型学习（D）`;
        match = source.match(/^Dislike (.+) \(D\)$/);
        if (match) return `标记 ${match[1]} 为不喜欢（D）`;
        match = source.match(/^Open full preview of (.+)$/);
        if (match) return `打开 ${match[1]} 的完整预览`;
        match = source.match(/^Review "([^"]+)" in blocklist/);
        if (match) return `在已屏蔽图片中查看“${match[1]}”`;
        match = source.match(/^Review combo "([^"]+)"/);
        if (match) return `查看组合“${match[1]}”`;
        match = source.match(/^Remove "([^"]+)" from combo$/);
        if (match) return `从组合中移除“${match[1]}”`;
        match = source.match(/^Add "([^"]+)" to combo/);
        if (match) return `将“${match[1]}”加入组合`;
        match = source.match(/^(.+) · (\d+(?:\.\d+)?)% pool$/);
        if (match) return `${match[1]} · 占图库 ${match[2]}%`;
        match = source.match(/^#(\d+) · (\d+(?:\.\d+)?)% pool$/);
        if (match) return `第 ${match[1]} 名 · 占图库 ${match[2]}%`;
        match = source.match(/^Could not change automatic filter: (.+)$/);
        if (match) return `无法更改下载筛选方式：${match[1]}`;
        match = source.match(/^Failed to save settings: (.+)$/);
        if (match) return `保存设置失败：${match[1]}`;
        match = source.match(/^Connection error: (.+)$/);
        if (match) return `连接错误：${match[1]}`;
        match = source.match(/^Wayper (.+) is available\. Current version: (.+)\.$/);
        if (match) return `Wayper ${match[1]} 可用。当前版本：${match[2]}。`;
        match = source.match(/^Could not (keep|ban|dislike) (.+): (.+)$/i);
        if (match) {
            const action = {
                keep: '保留',
                ban: '屏蔽',
                dislike: '标记为不喜欢',
            }[match[1].toLowerCase()] || match[1];
            return `无法${action} ${match[2]}：${match[3]}`;
        }
        return null;
    }

    function textParts(value) {
        const leading = (value.match(/^\s*/) || [''])[0];
        const trailing = (value.match(/\s*$/) || [''])[0];
        const end = value.length - trailing.length;
        return { leading, core: value.slice(leading.length, end), trailing };
    }

    function translateTextNode(node) {
        const raw = String(node.nodeValue || '');
        const oldState = nodeState.get(node);
        let source = oldState && raw === oldState.rendered ? oldState.source : textParts(raw).core;
        if (!source) return;
        if (!Object.hasOwn(EN, source) && !Object.hasOwn(ZH_TO_EN, source)) {
            // Dynamic strings are only inferred while they are in English;
            // state retained above lets an already translated node switch back.
            if (!oldState) {
                const dynamic = translateDynamic(source, 'zh');
                if (!dynamic) return;
            }
        }
        if (Object.hasOwn(ZH_TO_EN, source)) source = ZH_TO_EN[source];
        const parts = textParts(raw);
        const nextCore = activeLocale === 'zh'
            ? (ZH[source] || translateDynamic(source, 'zh') || source)
            : source;
        const next = parts.leading + nextCore + parts.trailing;
        nodeState.set(node, { source, rendered: next });
        if (next !== raw) node.nodeValue = next;
    }

    function translateAttribute(element, attribute) {
        const raw = element.getAttribute(attribute);
        if (raw === null || !raw.trim()) return;
        if (CONTENT_IGNORE_SELECTORS.some(selector => element.closest(selector))) return;
        let states = attributeState.get(element);
        if (!states) {
            states = new Map();
            attributeState.set(element, states);
        }
        const oldState = states.get(attribute);
        let source = oldState && raw === oldState.rendered ? oldState.source : raw.trim();
        if (Object.hasOwn(ZH_TO_EN, source)) source = ZH_TO_EN[source];
        const nextCore = activeLocale === 'zh'
            ? (ZH[source] || translateDynamic(source, 'zh') || source)
            : source;
        states.set(attribute, { source, rendered: nextCore });
        if (nextCore !== raw) element.setAttribute(attribute, nextCore);
    }

    function ignoredTextNode(node) {
        const parent = node.parentElement;
        if (!parent) return true;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        if (parent.closest('[data-i18n-ignore="true"]')) return true;
        // A few content containers (for example the AI analysis panel) also
        // contain translated action buttons.  Ignore only their prose, not
        // controls nested inside them.
        if (parent.closest('button, a, [role="button"], .search-type-badge')) return false;
        return CONTENT_IGNORE_SELECTORS.some(selector => parent.closest(selector));
    }

    function translateSubtree(rootNode) {
        if (!rootNode) return;
        const textNodeType = typeof Node === 'undefined' ? 3 : Node.TEXT_NODE;
        const elementType = typeof Node === 'undefined' ? 1 : Node.ELEMENT_NODE;
        const fragmentType = typeof Node === 'undefined' ? 11 : Node.DOCUMENT_FRAGMENT_NODE;
        if (rootNode.nodeType === textNodeType) {
            if (!ignoredTextNode(rootNode)) translateTextNode(rootNode);
            return;
        }
        if (rootNode.nodeType !== elementType && rootNode.nodeType !== fragmentType) return;
        if (rootNode.nodeType === elementType) {
            for (const attribute of TEXT_ATTRIBUTES) translateAttribute(rootNode, attribute);
        }
        const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
        const walker = document.createTreeWalker(rootNode, showText);
        let node;
        while ((node = walker.nextNode())) {
            if (!ignoredTextNode(node)) translateTextNode(node);
        }
        for (const element of rootNode.querySelectorAll('*')) {
            for (const attribute of TEXT_ATTRIBUTES) translateAttribute(element, attribute);
        }
    }

    function applyTranslations(roots = null) {
        if (typeof document === 'undefined' || !document.body || applying) return;
        applying = true;
        try {
            if (roots && roots.size) {
                for (const rootNode of roots) translateSubtree(rootNode);
            } else {
                translateSubtree(document.body);
            }
            document.documentElement.lang = activeLocale === 'zh' ? 'zh-CN' : 'en';
        } finally {
            applying = false;
        }
    }

    function queueApply() {
        if (applyQueued) return;
        applyQueued = true;
        Promise.resolve().then(() => {
            applyQueued = false;
            const roots = new Set(pendingMutationRoots);
            pendingMutationRoots.clear();
            applyTranslations(roots);
        });
    }

    function setPreference(value, { notify = true } = {}) {
        const nextPreference = normalizePreference(value);
        const nextLocale = nextPreference === 'auto' ? detectSystemLocale() : nextPreference;
        const changed = nextPreference !== preference || nextLocale !== activeLocale;
        preference = nextPreference;
        activeLocale = nextLocale;
        applyTranslations();
        if (notify && changed) {
            if (typeof root.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                root.dispatchEvent(new CustomEvent('wayper-language-changed', {
                    detail: { preference, locale: activeLocale },
                }));
            }
        }
        return activeLocale;
    }

    function t(key, vars = undefined) {
        const source = String(key ?? '');
        const value = activeLocale === 'zh'
            ? (ZH[source] || translateDynamic(source, 'zh') || source)
            : source;
        return interpolate(value, vars);
    }

    function startObserver() {
        if (typeof MutationObserver === 'undefined'
            || typeof document === 'undefined'
            || !document.body) return;
        observer = new MutationObserver(records => {
            if (applying) return;
            for (const record of records) {
                if (record.type === 'childList') {
                    for (const node of record.addedNodes) pendingMutationRoots.add(node);
                } else if (record.type === 'characterData' || record.type === 'attributes') {
                    pendingMutationRoots.add(record.target);
                }
            }
            if (pendingMutationRoots.size) queueApply();
        });
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: TEXT_ATTRIBUTES,
        });
    }

    root.WayperI18n = {
        dictionaries: { en: EN, zh: ZH },
        detectSystemLocale,
        normalizePreference,
        preference: () => preference,
        locale: () => activeLocale,
        setPreference,
        apply: applyTranslations,
        t,
    };
    // Short alias for renderer additions and third-party UI extensions.
    root.wayperT = t;
    // Native alerts are used by a few legacy renderer paths.  Translating at
    // this boundary keeps those errors in the selected language without
    // changing their control flow.
    if (typeof root.alert === 'function') {
        const nativeAlert = root.alert.bind(root);
        try {
            root.alert = message => nativeAlert(t(String(message)));
        } catch (_) {
            // Some embedded WebViews expose a non-writable alert property.
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = root.WayperI18n;
    }

    if (typeof document !== 'undefined' && document.body) {
        setPreference('auto', { notify: false });
        startObserver();
    } else if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            setPreference('auto', { notify: false });
            startObserver();
        }, { once: true });
    }
})();
