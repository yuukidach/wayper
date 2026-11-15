import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
  Plus,
  RotateCcw,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import type {
  BlocklistEntry,
  ComboSuggestionItem,
  ConfigPayload,
  ImageItem,
  Orientation,
  Purity,
  TagSuggestionItem,
  UploaderSuggestionItem,
} from "../../shared/types";
import type { ResolvedLocale } from "../../shared/i18n";
import {
  comboIdentityKey,
  dedupeCombos,
  dedupeStringsCaseInsensitive,
  dedupeTagsNormalized,
  isRuleApplied,
  type ExclusionRulesState,
} from "../../shared/exclusion";
import { casefold, normalizeTag } from "../../shared/tags";
import { formatTimestamp, thumbUrl, trashThumbUrl } from "../lib/media";

export type BlocklistTab = "recoverable" | "blocked" | "rules";

const BLOCKLIST_TABS: BlocklistTab[] = ["recoverable", "blocked", "rules"];

export interface DrilldownState {
  kind: "tags" | "uploader";
  tags: string[];
  uploader?: string;
}

export interface BlocklistWorkspaceHandle {
  selectTab: (tab: BlocklistTab) => void;
  cycleTab: (delta: -1 | 1) => void;
  popDrilldown: () => boolean;
  clearDrilldown: () => void;
  hasDrilldown: () => boolean;
  openDrilldownForSearch: (query: string) => void;
  refresh: () => Promise<void>;
}

interface BlocklistWorkspaceProps {
  t: (key: string) => string;
  locale: ResolvedLocale;
  config: ConfigPayload | null;
  purities: Purity[];
  orientation: Orientation;
  refreshToken: number;
  onRefreshConfigAndStatus: () => Promise<void>;
  onOpenTrashLightbox: (item: ImageItem, list: ImageItem[]) => void;
  onOpenLibraryLightbox: (item: ImageItem, list: ImageItem[]) => void;
  onOpenWallhaven: (filenameOrPath: string) => void;
  onNotify: (text: string, tone?: "info" | "success" | "error") => void;
}

const BLOCKED_BATCH_SIZE = 100;
const TRASH_BATCH_SIZE = 60;
const RULE_ROWS_PER_COLUMN = 10;
const RULE_SKELETON_WIDTHS = [94, 81, 70, 62, 53, 45, 39, 33];

type RuleType = "tag" | "combo" | "uploader";

interface RuleRow {
  key: string;
  type: RuleType;
  label: string;
  tags: string[];
  banned: number;
  kept: number;
  applied: boolean;
}

interface RuleColumnProps {
  title: string;
  rows: RuleRow[];
  loading: boolean;
  pendingKey: string | null;
  excludeLabel: string;
  removeLabel: string;
  onOpen: (row: RuleRow) => void;
  onToggle: (row: RuleRow) => void;
}

/**
 * A ranked list: the bar behind each rule shows how many blocked wallpapers
 * carry it, and the pale end is how many wallpapers with it were kept.
 */
const RuleColumn: React.FC<RuleColumnProps> = ({
  title,
  rows,
  loading,
  pendingKey,
  excludeLabel,
  removeLabel,
  onOpen,
  onToggle,
}) => {
  const peak = rows.reduce((max, row) => Math.max(max, row.banned + row.kept), 1);
  return (
    <div className="min-w-0">
      <h3 className="m-0 mb-1.5 px-3 text-[12.5px] font-medium text-ink-3">{title}</h3>
      {loading ? (
        <ul className="m-0 list-none p-0" aria-hidden="true">
          {RULE_SKELETON_WIDTHS.map((width) => (
            <li key={width} className="flex h-[34px] items-center">
              <span
                className="h-7 animate-pulse rounded-md bg-white/[0.045]"
                style={{ width: `${width}%` }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((row) => {
            const share = Math.max(4, ((row.banned + row.kept) / peak) * 100);
            return (
              <li key={row.key} className="group/rule relative">
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  title={row.label}
                  className="relative flex h-[34px] w-full items-center gap-3 rounded-lg px-3 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:bg-white/[0.07]"
                >
                  <span aria-hidden="true" className="absolute inset-y-[3px] right-[76px] left-0">
                    <span
                      className={`flex h-full gap-px overflow-hidden rounded-md transition-opacity ${
                        row.applied ? "opacity-40" : ""
                      }`}
                      style={{ width: `${share}%` }}
                    >
                      <span className="bg-white/[0.075]" style={{ flexGrow: row.banned }} />
                      <span className="bg-keep/55" style={{ flexGrow: row.kept }} />
                    </span>
                  </span>
                  <span
                    className={`relative flex min-w-0 flex-1 items-center gap-1.5 text-[13px] ${
                      row.applied ? "text-ink-3" : "text-ink"
                    }`}
                  >
                    {row.applied && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-keep" strokeWidth={2.25} />
                    )}
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="relative flex w-[64px] shrink-0 items-baseline justify-end gap-2 text-[12.5px] tabular-nums transition-opacity duration-100 group-focus-within/rule:opacity-0 group-hover/rule:opacity-0">
                    <span className={row.applied ? "text-ink-3" : "text-ink-2"}>{row.banned}</span>
                    <span className="min-w-[22px] text-right text-ink-3">{row.kept}</span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={pendingKey === row.key}
                  onClick={() => onToggle(row)}
                  className={`absolute top-1/2 right-1.5 inline-flex h-6 -translate-y-1/2 items-center rounded-full px-2.5 text-[12px] font-medium opacity-0 transition-[opacity,background-color,color] duration-100 group-focus-within/rule:opacity-100 group-hover/rule:opacity-100 disabled:opacity-50 ${
                    row.applied
                      ? "bg-white/[0.1] text-ink-2 hover:bg-white/[0.16] hover:text-ink"
                      : "bg-accent text-on-accent hover:bg-accent-hi"
                  }`}
                >
                  {row.applied ? removeLabel : excludeLabel}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const BlocklistWorkspace = forwardRef<BlocklistWorkspaceHandle, BlocklistWorkspaceProps>(
  (
    {
      t,
      locale,
      config,
      purities,
      orientation,
      refreshToken,
      onRefreshConfigAndStatus,
      onOpenTrashLightbox,
      onOpenLibraryLightbox,
      onOpenWallhaven,
      onNotify,
    },
    ref,
  ) => {
    const [tab, setTab] = useState<BlocklistTab>("recoverable");
    const [entries, setEntries] = useState<BlocklistEntry[]>([]);
    const [trashImages, setTrashImages] = useState<ImageItem[]>([]);
    const [entriesLoaded, setEntriesLoaded] = useState(false);
    const [visibleBlockedCount, setVisibleBlockedCount] = useState(BLOCKED_BATCH_SIZE);
    const [visibleTrashCount, setVisibleTrashCount] = useState(TRASH_BATCH_SIZE);
    const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
    const [suggestionsStale, setSuggestionsStale] = useState(true);
    const [pendingRuleKey, setPendingRuleKey] = useState<string | null>(null);
    const suggestionSeqRef = useRef(0);

    const [trashPermissionIssue, setTrashPermissionIssue] = useState<{
      forbidden: boolean;
      checked: boolean;
    } | null>(null);
    const checkedTrashFilesRef = useRef<Set<string>>(new Set());

    const [tagSuggestions, setTagSuggestions] = useState<TagSuggestionItem[]>([]);
    const [comboSuggestions, setComboSuggestions] = useState<ComboSuggestionItem[]>([]);
    const [uploaderSuggestions, setUploaderSuggestions] = useState<UploaderSuggestionItem[]>([]);

    const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
    const [refinementTags, setRefinementTags] = useState<TagSuggestionItem[]>([]);
    const [drilldownMatches, setDrilldownMatches] = useState<ImageItem[]>([]);
    const [drilldownLoading, setDrilldownLoading] = useState(false);

    const ledgerSentinelRef = useRef<HTMLDivElement | null>(null);
    const trashSentinelRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);

    const rulesState: ExclusionRulesState = useMemo(
      () => ({
        excludeTags: config?.wallhaven.exclude_tags ?? [],
        excludeCombos: config?.wallhaven.exclude_combos ?? [],
        excludeUploaders: config?.wallhaven.exclude_uploaders ?? [],
      }),
      [config],
    );

    // The ledger is a cheap file read, so it shows at once and refreshes in
    // place.  Rule suggestions scan the whole library and load on their own.
    const loadBlocklistData = useCallback(async () => {
      try {
        const bl = await window.wayper.getBlocklist();
        setEntries(bl.entries ?? []);
        const recImages: ImageItem[] =
          bl.images && bl.images.length > 0
            ? bl.images
            : (bl.entries ?? [])
                .filter((e) => e.recoverable)
                .map((e) => ({
                  path: e.filename,
                  name: e.filename,
                  is_favorite: false,
                  orientation: null,
                }));
        setTrashImages(recImages);
      } catch (err) {
        console.error("Failed loading blocklist:", err);
      } finally {
        setEntriesLoaded(true);
      }
    }, []);

    const loadSuggestions = useCallback(async () => {
      const seq = ++suggestionSeqRef.current;
      setSuggestionsStale(false);
      const [tagSug, upSug] = await Promise.all([
        window.wayper.getTagSuggestions().catch(() => ({
          suggestions: [],
          combo_suggestions: [],
        })),
        window.wayper.getUploaderSuggestions().catch(() => ({ suggestions: [] })),
      ]);
      if (seq !== suggestionSeqRef.current) return;
      setTagSuggestions((tagSug.suggestions ?? []).slice(0, RULE_ROWS_PER_COLUMN));
      setComboSuggestions((tagSug.combo_suggestions ?? []).slice(0, RULE_ROWS_PER_COLUMN));
      setUploaderSuggestions((upSug.suggestions ?? []).slice(0, RULE_ROWS_PER_COLUMN));
      setSuggestionsLoaded(true);
    }, []);

    useEffect(() => {
      void loadBlocklistData();
      setSuggestionsStale(true);
    }, [loadBlocklistData, refreshToken]);

    // Warm the suggestions once in the background, then only refresh them on
    // entering the rules tab so the list never reshuffles under the pointer.
    const rulesVisible = tab === "rules" && !drilldown;
    useEffect(() => {
      if (!suggestionsStale) return;
      if (suggestionsLoaded && !rulesVisible) return;
      if (suggestionsLoaded) {
        void loadSuggestions();
        return;
      }
      const timer = window.setTimeout(() => void loadSuggestions(), 350);
      return () => window.clearTimeout(timer);
      // Becoming stale while the rules are on screen must not reload them.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rulesVisible, suggestionsLoaded, loadSuggestions]);

    useEffect(() => {
      setVisibleBlockedCount(BLOCKED_BATCH_SIZE);
      setVisibleTrashCount(TRASH_BATCH_SIZE);
    }, [tab]);

    useEffect(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    }, [tab, drilldown]);

    useEffect(() => {
      if (tab !== "recoverable" || drilldown) return;
      const sentinel = trashSentinelRef.current;
      const root = scrollContainerRef.current;
      if (!sentinel || !root || visibleTrashCount >= trashImages.length) return;
      const observer = new IntersectionObserver(
        (obsEntries) => {
          if (obsEntries.some((e) => e.isIntersecting)) {
            setVisibleTrashCount((prev) => Math.min(trashImages.length, prev + TRASH_BATCH_SIZE));
          }
        },
        { root, rootMargin: "600px 0px" },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [tab, drilldown, visibleTrashCount, trashImages.length]);

    useEffect(() => {
      if (tab !== "blocked" || drilldown) return;
      const sentinel = ledgerSentinelRef.current;
      const root = scrollContainerRef.current;
      if (!sentinel || !root || visibleBlockedCount >= entries.length) return;
      const observer = new IntersectionObserver(
        (obsEntries) => {
          if (obsEntries.some((e) => e.isIntersecting)) {
            setVisibleBlockedCount((prev) => Math.min(entries.length, prev + BLOCKED_BATCH_SIZE));
          }
        },
        { root, rootMargin: "320px 0px" },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [tab, drilldown, visibleBlockedCount, entries.length]);

    useEffect(() => {
      if (!drilldown) {
        setRefinementTags([]);
        setDrilldownMatches([]);
        return;
      }
      let cancelled = false;
      const loadDrilldown = async () => {
        setDrilldownLoading(true);
        try {
          const purityParam = [...purities].sort().join(",");
          if (drilldown.kind === "uploader" && drilldown.uploader) {
            const [searchRes, poolPage, favPage] = await Promise.all([
              window.wayper.searchImages({ uploader: drilldown.uploader }),
              window.wayper.getImagesPage({
                mode: "pool",
                purity: purityParam,
                orient: orientation,
                offset: 0,
                limit: 300,
              }),
              window.wayper.getImagesPage({
                mode: "favorites",
                purity: purityParam,
                orient: orientation,
                offset: 0,
                limit: 300,
              }),
            ]);
            if (cancelled) return;
            const matchSet = new Set(searchRes.matches ?? []);
            const combined = [...(poolPage.items ?? []), ...(favPage.items ?? [])];
            const seen = new Set<string>();
            const matched = combined.filter((item) => {
              if (seen.has(item.path)) return false;
              if (matchSet.has(item.name) || matchSet.has(item.path)) {
                seen.add(item.path);
                return true;
              }
              return false;
            });
            setRefinementTags([]);
            setDrilldownMatches(matched);
          } else if (drilldown.tags.length > 0) {
            const [searchRes, refineRes, poolPage, favPage] = await Promise.all([
              window.wayper.searchImages({ tags: drilldown.tags }),
              window.wayper.getTagSuggestions(drilldown.tags).catch(() => ({ suggestions: [] })),
              window.wayper.getImagesPage({
                mode: "pool",
                purity: purityParam,
                orient: orientation,
                offset: 0,
                limit: 300,
              }),
              window.wayper.getImagesPage({
                mode: "favorites",
                purity: purityParam,
                orient: orientation,
                offset: 0,
                limit: 300,
              }),
            ]);
            if (cancelled) return;
            const matchSet = new Set(searchRes.matches ?? []);
            const combined = [...(poolPage.items ?? []), ...(favPage.items ?? [])];
            const seen = new Set<string>();
            const matched = combined.filter((item) => {
              if (seen.has(item.path)) return false;
              if (matchSet.has(item.name) || matchSet.has(item.path)) {
                seen.add(item.path);
                return true;
              }
              return false;
            });
            const currentNorm = new Set(drilldown.tags.map((x) => normalizeTag(x)));
            setRefinementTags(
              (refineRes.suggestions ?? [])
                .filter((s) => !currentNorm.has(normalizeTag(s.tag)))
                .slice(0, 14),
            );
            setDrilldownMatches(matched);
          }
        } catch (err) {
          console.error("Failed loading drilldown:", err);
        } finally {
          if (!cancelled) setDrilldownLoading(false);
        }
      };
      void loadDrilldown();
      return () => {
        cancelled = true;
      };
    }, [drilldown, purities, orientation]);

    const applyExclusionMutation = async (
      type: "tag" | "combo" | "uploader",
      tags: string[],
      action: "add" | "remove",
    ) => {
      if (!config || tags.length === 0) return;
      const wh = config.wallhaven;
      if (type === "uploader") {
        const target = tags[0].replace(/^@/, "").trim();
        const nextUploaders =
          action === "add"
            ? dedupeStringsCaseInsensitive([...(wh.exclude_uploaders ?? []), target])
            : (wh.exclude_uploaders ?? []).filter((u) => casefold(u) !== casefold(target));
        await window.wayper.patchConfig({ wallhaven: { exclude_uploaders: nextUploaders } });
      } else if (type === "combo" || tags.length >= 2) {
        const targetKey = comboIdentityKey(tags);
        const nextCombos =
          action === "add"
            ? dedupeCombos([...(wh.exclude_combos ?? []), tags], { dropSupersets: true })
            : (wh.exclude_combos ?? []).filter((c) => comboIdentityKey(c) !== targetKey);
        await window.wayper.patchConfig({ wallhaven: { exclude_combos: nextCombos } });
      } else {
        const norm = normalizeTag(tags[0]);
        const nextTags =
          action === "add"
            ? dedupeTagsNormalized([...(wh.exclude_tags ?? []), norm])
            : (wh.exclude_tags ?? []).filter((x) => normalizeTag(x) !== norm);
        await window.wayper.patchConfig({ wallhaven: { exclude_tags: nextTags } });
      }
      await onRefreshConfigAndStatus();
      setSuggestionsStale(true);
    };

    const handleTrashThumbError = async (filename: string) => {
      if (checkedTrashFilesRef.current.has(filename)) return;
      checkedTrashFilesRef.current.add(filename);
      try {
        const access = await window.wayper.checkTrashAccess(filename);
        if (!access.readable || access.forbidden) {
          setTrashPermissionIssue({ forbidden: access.forbidden, checked: true });
        }
      } catch {
        // ignore
      }
    };

    const handleRestore = async (item: ImageItem) => {
      try {
        await window.wayper.restoreImage(item.path);
        setTrashImages((prev) => prev.filter((x) => x.name !== item.name && x.path !== item.path));
        setEntries((prev) => prev.filter((e) => e.filename !== item.name));
        await onRefreshConfigAndStatus();
        onNotify(`${t("Restore")}: ${item.name}`, "success");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : "Could not restore wallpaper", "error");
      }
    };

    const handleUnblock = async (entry: BlocklistEntry) => {
      try {
        await window.wayper.removeBlocklistEntry(entry.filename);
        setEntries((prev) => prev.filter((e) => e.filename !== entry.filename));
        setTrashImages((prev) => prev.filter((i) => i.name !== entry.filename));
        await onRefreshConfigAndStatus();
        onNotify(`${t("Unblock")}: ${entry.filename}`, "success");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : "Could not unblock entry", "error");
      }
    };

    const popDrilldown = useCallback((): boolean => {
      if (!drilldown) return false;
      if (drilldown.kind === "tags" && drilldown.tags.length > 1) {
        setDrilldown({ kind: "tags", tags: drilldown.tags.slice(0, -1) });
      } else {
        setDrilldown(null);
      }
      return true;
    }, [drilldown]);

    const openDrilldownForSearch = useCallback((rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        setDrilldown(null);
        return;
      }
      if (trimmed.startsWith("@") && trimmed.length > 1) {
        const up = trimmed.slice(1).trim();
        setDrilldown({ kind: "uploader", tags: [up], uploader: up });
        return;
      }
      const parts = trimmed
        .split(/[+,，]+/)
        .map((p) => normalizeTag(p))
        .filter(Boolean);
      if (parts.length > 0) {
        setDrilldown({ kind: "tags", tags: parts });
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        selectTab: (nextTab) => {
          setDrilldown(null);
          setTab(nextTab);
        },
        cycleTab: (delta) => {
          setDrilldown(null);
          setTab((current) => {
            const index = BLOCKLIST_TABS.indexOf(current) + delta;
            return BLOCKLIST_TABS[(index + BLOCKLIST_TABS.length) % BLOCKLIST_TABS.length];
          });
        },
        popDrilldown,
        clearDrilldown: () => setDrilldown(null),
        hasDrilldown: () => drilldown !== null,
        openDrilldownForSearch,
        refresh: loadBlocklistData,
      }),
      [popDrilldown, drilldown, openDrilldownForSearch, loadBlocklistData],
    );

    const recoverableCount = trashImages.length;
    const isMac = window.wayper.platform === "darwin";

    const drillType: "tag" | "combo" | "uploader" =
      drilldown?.kind === "uploader"
        ? "uploader"
        : (drilldown?.tags.length ?? 0) >= 2
          ? "combo"
          : "tag";

    const drillApplied = drilldown
      ? isRuleApplied(
          rulesState,
          drillType,
          drilldown.kind === "uploader" && drilldown.uploader
            ? [drilldown.uploader]
            : drilldown.tags,
        )
      : false;

    const tagRows: RuleRow[] = tagSuggestions.map((item) => ({
      key: `tag-${item.tag}`,
      type: "tag",
      label: item.tag,
      tags: [item.tag],
      banned: item.banned,
      kept: item.kept + item.favorites,
      applied: isRuleApplied(rulesState, "tag", [item.tag]),
    }));
    const comboRows: RuleRow[] = comboSuggestions.map((item) => ({
      key: `combo-${comboIdentityKey(item.tags)}`,
      type: "combo",
      label: item.tags.join(" + "),
      tags: [...item.tags],
      banned: item.banned,
      kept: item.kept + item.favorites,
      applied: isRuleApplied(rulesState, "combo", item.tags),
    }));
    const uploaderRows: RuleRow[] = uploaderSuggestions.map((item) => ({
      key: `uploader-${item.uploader}`,
      type: "uploader",
      label: `@${item.uploader}`,
      tags: [item.uploader],
      banned: item.ban_count,
      kept: item.kept_count + item.fav_count,
      applied: isRuleApplied(rulesState, "uploader", [item.uploader]),
    }));
    const ruleColumns: Array<[string, RuleRow[]]> = [
      [t("Tags"), tagRows],
      [t("Combos"), comboRows],
      [t("Uploaders"), uploaderRows],
    ];
    const hasRuleRows = ruleColumns.some(([, rows]) => rows.length > 0);

    const openRule = (row: RuleRow) =>
      setDrilldown(
        row.type === "uploader"
          ? { kind: "uploader", tags: row.tags, uploader: row.tags[0] }
          : { kind: "tags", tags: row.tags },
      );

    const toggleRule = async (row: RuleRow) => {
      if (pendingRuleKey) return;
      setPendingRuleKey(row.key);
      try {
        await applyExclusionMutation(row.type, row.tags, row.applied ? "remove" : "add");
        onNotify(row.applied ? t("Removed") : t("Applied"), "success");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : "Failed updating exclusion rule", "error");
      } finally {
        setPendingRuleKey(null);
      }
    };

    // Counts for the rule being inspected, when it came from the suggestions.
    const drillStats = drilldown
      ? ([...tagRows, ...comboRows, ...uploaderRows].find((row) =>
          drilldown.kind === "uploader"
            ? row.type === "uploader" && casefold(row.tags[0]) === casefold(drilldown.uploader ?? "")
            : row.type !== "uploader" &&
              comboIdentityKey(row.tags) === comboIdentityKey(drilldown.tags),
        ) ?? null)
      : null;

    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="page-scroll flex-1 scroll-pt-20 scroll-pb-28 space-y-5 overflow-y-auto px-6 pt-[68px] pb-28"
        >
          <div className="flex items-center">
            <div role="tablist" className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-0.5">
              {(
                [
                  ["recoverable", t("Recoverable"), recoverableCount],
                  ["blocked", t("All Blocked"), entries.length],
                  ["rules", t("Exclusion rules"), null],
                ] as Array<[BlocklistTab, string, number | null]>
              ).map(([value, label, count]) => {
                const active = tab === value && !drilldown;
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setDrilldown(null);
                      setTab(value);
                    }}
                    className={`relative inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
                      active ? "text-ink" : "text-ink-3 hover:text-ink-2"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="blocklist-tab-pill"
                        className="absolute inset-0 rounded-full bg-white/[0.13]"
                        transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
                      />
                    )}
                    <span className="relative">{label}</span>
                    {count !== null && entriesLoaded && (
                      <span
                        className={`relative tabular-nums ${active ? "text-ink-2" : "text-ink-3"}`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {trashPermissionIssue && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warn/10 px-4 py-3 text-[13px] text-warn">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
                <span>
                  {isMac && trashPermissionIssue.forbidden
                    ? t("Trash access requires Full Disk Access")
                    : t("Trash folder is not readable")}
                </span>
              </div>
              {isMac && (
                <button
                  type="button"
                  onClick={() =>
                    void window.wayper.openExternal(
                      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
                    )
                  }
                  className="inline-flex h-7 items-center rounded-lg bg-white/[0.08] px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.14]"
                >
                  {t("Open System Settings")}
                </button>
              )}
            </div>
          )}

          {drilldown ? (
            <section className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <button
                    type="button"
                    onClick={() => popDrilldown()}
                    title={`${t("Back")} [Esc]`}
                    aria-label={t("Back")}
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-ink-2 transition-colors hover:bg-white/[0.12] hover:text-ink"
                  >
                    <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                  </button>

                  <div className="min-w-0">
                    <h2 className="m-0 flex flex-wrap items-baseline gap-x-2 text-[22px] leading-9 font-semibold tracking-[-0.02em]">
                      {drilldown.kind === "uploader" ? (
                        <span className="text-ink">
                          <span className="text-ink-3">@</span>
                          {drilldown.uploader}
                        </span>
                      ) : (
                        drilldown.tags.map((seg, idx) => (
                          <React.Fragment key={`crumb-${seg}-${idx}`}>
                            {idx > 0 && <span className="font-normal text-ink-3">+</span>}
                            <button
                              type="button"
                              onClick={() =>
                                setDrilldown({
                                  kind: "tags",
                                  tags: drilldown.tags.slice(0, idx + 1),
                                })
                              }
                              className={`transition-colors ${
                                idx === drilldown.tags.length - 1
                                  ? "text-ink"
                                  : "text-ink-2 hover:text-ink"
                              }`}
                            >
                              {seg}
                            </button>
                          </React.Fragment>
                        ))
                      )}
                    </h2>
                    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-5 text-[12.5px] text-ink-3">
                      {drillStats && (
                        <>
                          <span>
                            <span className="mr-1.5 tabular-nums text-ink-2">
                              {drillStats.banned}
                            </span>
                            {t("blocked")}
                          </span>
                          <span>
                            <span className="mr-1.5 tabular-nums text-ink-2">{drillStats.kept}</span>
                            {t("kept")}
                          </span>
                        </>
                      )}
                      {!drilldownLoading && (
                        <span>
                          <span className="mr-1.5 tabular-nums text-ink-2">
                            {drilldownMatches.length}
                          </span>
                          {t("in your library now")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    void applyExclusionMutation(
                      drillType,
                      drilldown.kind === "uploader" && drilldown.uploader
                        ? [drilldown.uploader]
                        : drilldown.tags,
                      drillApplied ? "remove" : "add",
                    ).catch((err: unknown) =>
                      onNotify(
                        err instanceof Error ? err.message : "Failed updating exclusion rule",
                        "error",
                      ),
                    )
                  }
                  className={`mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium whitespace-nowrap transition-colors ${
                    drillApplied
                      ? "bg-white/[0.08] text-ink hover:bg-drop/15 hover:text-drop"
                      : "bg-accent text-on-accent hover:bg-accent-hi"
                  }`}
                >
                  {drillApplied && <Check className="h-3.5 w-3.5 text-keep" strokeWidth={2.25} />}
                  {drillApplied
                    ? t("Remove")
                    : drillType === "combo"
                      ? t("Exclude combo")
                      : drillType === "uploader"
                        ? t("Exclude uploader")
                        : t("Exclude")}
                </button>
              </div>

              {drilldown.kind === "tags" && refinementTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1.5 text-[12.5px] text-ink-3">{t("Refine with")}</span>
                  {refinementTags.map((rt) => (
                    <button
                      key={`ref-${rt.tag}`}
                      type="button"
                      onClick={() =>
                        setDrilldown({
                          kind: "tags",
                          tags: [...drilldown.tags, normalizeTag(rt.tag)],
                        })
                      }
                      title={`${rt.banned} ${t("blocked")}, ${rt.kept} ${t("kept")}`}
                      className="group/refine inline-flex h-7 items-center gap-1.5 rounded-full pr-3 pl-2 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors hover:bg-white/[0.07] hover:text-ink"
                    >
                      <Plus
                        className="h-3 w-3 text-ink-3 transition-colors group-hover/refine:text-ink"
                        strokeWidth={2}
                      />
                      <span>{rt.tag}</span>
                      <span className="tabular-nums text-[11.5px] text-ink-3">{rt.banned}</span>
                    </button>
                  ))}
                </div>
              )}

              <div>
                {drilldownLoading ? (
                  <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-2">
                    <Loader2 className="h-4 w-4 animate-spin text-ink-3" />
                    <span>{t("Loading library...")}</span>
                  </div>
                ) : drilldownMatches.length === 0 ? (
                  <p className="py-4 text-[12.5px] text-ink-2">{t("No matches found")}</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                    {drilldownMatches.map((img) => (
                      <div
                        key={`drill-img-${img.path}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenLibraryLightbox(img, drilldownMatches)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenLibraryLightbox(img, drilldownMatches);
                          }
                        }}
                        className="wallpaper-card aspect-[16/10] cursor-pointer"
                      >
                        <img
                          src={thumbUrl(img.path)}
                          alt={img.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : tab === "rules" ? (
            <section>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <p className="m-0 max-w-[560px] text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "What shows up most in the wallpapers you blocked. Exclude one and new downloads skip it.",
                  )}
                </p>
                <div className="flex items-center gap-4 text-[12px] text-ink-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-3.5 rounded-[3px] bg-white/20" />
                    {t("blocked")}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-3.5 rounded-[3px] bg-keep/55" />
                    {t("kept")}
                  </span>
                </div>
              </div>
              {suggestionsLoaded && !hasRuleRows ? (
                <p className="m-0 py-10 text-center text-[13.5px] text-ink-2">
                  {t("No rule suggestions yet")}
                </p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-x-6 gap-y-7">
                  {ruleColumns
                    .filter(([, rows]) => !suggestionsLoaded || rows.length > 0)
                    .map(([title, rows]) => (
                      <RuleColumn
                        key={title}
                        title={title}
                        rows={rows}
                        loading={!suggestionsLoaded}
                        pendingKey={pendingRuleKey}
                        excludeLabel={t("Exclude")}
                        removeLabel={t("Remove")}
                        onOpen={openRule}
                        onToggle={(row) => void toggleRule(row)}
                      />
                    ))}
                </div>
              )}
            </section>
          ) : !entriesLoaded ? (
            <div className="flex items-center justify-center py-16 text-ink-2">
              <Loader2 className="h-5 w-5 animate-spin text-ink-3" strokeWidth={1.75} />
            </div>
          ) : tab === "recoverable" ? (
            trashImages.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <p className="m-0 text-[13.5px] text-ink-2">
                  {t("No recoverable wallpapers in system trash")}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3">
                {trashImages.slice(0, visibleTrashCount).map((item) => (
                  <div
                    key={`trash-${item.name}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenTrashLightbox(item, trashImages)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenTrashLightbox(item, trashImages);
                      }
                    }}
                    className="wallpaper-card group aspect-[16/10] cursor-pointer"
                  >
                    <img
                      src={trashThumbUrl(item.name)}
                      alt={item.name}
                      loading="lazy"
                      decoding="async"
                      onError={() => void handleTrashThumbError(item.name)}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
                    />
                    <div className="card-actions absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-2 pt-8 pb-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRestore(item);
                        }}
                        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-black/70 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-white hover:text-black"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>{t("Restore")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenWallhaven(item.name);
                        }}
                        title={`${t("Open on Wallhaven")} [O]`}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white/85 transition-colors hover:bg-white hover:text-black"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {visibleTrashCount < trashImages.length && (
                  <div ref={trashSentinelRef} className="col-span-full h-px" aria-hidden="true" />
                )}
              </div>
            )
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <p className="m-0 text-[13.5px] text-ink-2">{t("No blocked wallpapers recorded")}</p>
            </div>
          ) : (
            <div>
              <div className="divide-y divide-line">
                {entries.slice(0, visibleBlockedCount).map((entry) => (
                  <div
                    key={`bl-row-${entry.filename}`}
                    className="group flex h-10 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.04]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onOpenWallhaven(entry.filename)}
                        className="truncate text-[13px] tabular-nums text-ink underline-offset-2 hover:underline"
                      >
                        {entry.filename}
                      </button>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            entry.recoverable ? "bg-keep" : "bg-white/20"
                          }`}
                        />
                        {entry.recoverable ? t("In Trash") : t("Deleted")}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-[12px] tabular-nums text-ink-3">
                        {formatTimestamp(entry.timestamp, locale)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleUnblock(entry)}
                        className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 opacity-0 transition-[opacity,background-color,color] duration-100 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-ink focus-visible:opacity-100"
                      >
                        <Undo2 className="h-3 w-3" />
                        <span>{t("Unblock")}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {visibleBlockedCount < entries.length && (
                <div
                  ref={ledgerSentinelRef}
                  className="flex items-center justify-center py-4"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleBlockedCount((prev) =>
                        Math.min(entries.length, prev + BLOCKED_BATCH_SIZE),
                      )
                    }
                    className="inline-flex h-7 items-center rounded-lg bg-white/[0.06] px-3 text-[12.5px] tabular-nums text-ink-2 transition-colors hover:bg-white/[0.11] hover:text-ink"
                  >
                    {visibleBlockedCount} / {entries.length} (+{BLOCKED_BATCH_SIZE})
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

BlocklistWorkspace.displayName = "BlocklistWorkspace";
