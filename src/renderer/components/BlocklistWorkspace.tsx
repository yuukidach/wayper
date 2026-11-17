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
  ChevronRight,
  ExternalLink,
  ImageOff,
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
import {
  prewarmLightboxPreview,
  type LightboxPreviewContext,
  type LightboxPreviewItem,
} from "../lib/lightbox-preview";
import type { GalleryDensity, GalleryFraming } from "../lib/gallery-prefs";
import { formatTimestamp, thumbUrl, trashThumbUrl } from "../lib/media";
import { motionTransition } from "../lib/motion";

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
  density?: GalleryDensity;
  framing?: GalleryFraming;
  refreshToken: number;
  onRefreshConfigAndStatus: () => Promise<void>;
  onOpenTrashLightbox: (item: ImageItem, list: ImageItem[]) => void;
  onOpenLibraryLightbox: (item: ImageItem, list: ImageItem[]) => void;
  onOpenWallhaven: (filenameOrPath: string) => void;
  onManageRules: () => void;
  onNotify: (text: string, tone?: "info" | "success" | "error") => void;
}

const BLOCKED_BATCH_SIZE = 100;
const TRASH_BATCH_SIZE = 60;
const RULE_ROWS_PER_COLUMN = 15;
const RULE_SKELETON_WIDTHS = [58, 44, 66, 38, 52, 47, 34, 41];

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

interface RuleTableProps {
  title: string;
  rows: RuleRow[];
  loading: boolean;
  blockedLabel: string;
  keptLabel: string;
  excludeLabel: string;
  undoLabel: string;
  onOpen: (row: RuleRow) => void;
  onToggle: (row: RuleRow) => void;
}

const RuleName: React.FC<{ row: RuleRow }> = ({ row }) =>
  row.type === "uploader" ? (
    <>
      <span className="text-ink-3">@</span>
      {row.tags[0]}
    </>
  ) : (
    <>
      {row.tags.map((tag, index) => (
        <React.Fragment key={`${tag}-${index}`}>
          {index > 0 && <span className="mx-1.5 text-ink-3">+</span>}
          {tag}
        </React.Fragment>
      ))}
    </>
  );

/**
 * One kind of rule as a small table.  The column headings say what the two
 * numbers are, the order is the ranking, and the action is always in view.
 */
const RuleTable: React.FC<RuleTableProps> = ({
  title,
  rows,
  loading,
  blockedLabel,
  keptLabel,
  excludeLabel,
  undoLabel,
  onOpen,
  onToggle,
}) => {
  const scale = Math.max(1, ...rows.map((row) => row.banned + row.kept));
  return (
  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(40px,0.55fr)_auto_auto_auto] content-start gap-x-4 rounded-2xl bg-white/[0.025] p-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
    <div className="col-span-5 grid h-[36px] grid-cols-subgrid items-center px-3 text-[12px] text-ink-3 shadow-[inset_0_-1px_0_var(--color-line)]">
      <h3 className="m-0 text-[12.5px] font-medium text-ink">{title}</h3>
      <span aria-hidden="true" />
      <span className="text-right">{blockedLabel}</span>
      <span className="text-right">{keptLabel}</span>
      {/* Holds the action column at its final width while the rows load. */}
      <span aria-hidden="true" className="invisible px-[10px] font-medium whitespace-nowrap">
        {excludeLabel}
      </span>
    </div>
    {loading ? (
      <ul className="col-span-5 m-0 list-none p-0 pt-1" aria-hidden="true">
        {RULE_SKELETON_WIDTHS.map((width) => (
          <li key={width} className="flex h-[36px] items-center px-3">
            <span
              className="h-2.5 animate-pulse rounded-full bg-white/[0.07]"
              style={{ width: `${width}%` }}
            />
          </li>
        ))}
      </ul>
    ) : (
      <ul className="col-span-5 m-0 grid list-none grid-cols-subgrid p-0 pt-1">
        {rows.map((row) => (
          <li
            key={row.key}
            className="group/rule col-span-5 grid h-[36px] grid-cols-subgrid items-center rounded-lg px-3 transition-colors hover:bg-white/[0.05] has-[:focus-visible]:bg-white/[0.05]"
          >
            <button
              type="button"
              onClick={() => onOpen(row)}
              title={row.label}
              className="col-span-4 grid h-full grid-cols-subgrid items-center rounded-md text-left outline-offset-0"
            >
              <span
                className={`flex min-w-0 items-center gap-1.5 text-[13.5px] ${
                  row.applied ? "text-ink-3" : "text-ink"
                }`}
              >
                {row.applied && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-keep" strokeWidth={2.25} />
                )}
                <span className="truncate">
                  <RuleName row={row} />
                </span>
              </span>
              <span
                aria-hidden="true"
                className="flex h-1.5 min-w-0 overflow-hidden rounded-full bg-white/[0.06]"
              >
                <span
                  className={`h-full transition-colors ${
                    row.applied ? "bg-white/20" : "bg-drop/70 group-hover/rule:bg-drop"
                  }`}
                  style={{ width: `${(row.banned / scale) * 100}%` }}
                />
                <span
                  className={`h-full ${row.applied ? "bg-white/10" : "bg-keep/60"}`}
                  style={{ width: `${(row.kept / scale) * 100}%` }}
                />
              </span>
              <span
                className={`text-right text-[13px] tabular-nums ${
                  row.applied ? "text-ink-3" : "text-ink"
                }`}
              >
                {row.banned}
              </span>
              <span className="text-right text-[13px] tabular-nums text-ink-3">{row.kept}</span>
            </button>
            <button
              type="button"
              onClick={() => onToggle(row)}
              className={`inline-flex h-[24px] items-center justify-self-end rounded-full px-[10px] text-[12px] font-medium whitespace-nowrap transition-colors duration-100 ${
                row.applied
                  ? "text-ink-3 hover:bg-white/[0.1] hover:text-ink"
                  : "bg-white/[0.06] text-ink-2 group-hover/rule:bg-white/[0.13] group-hover/rule:text-ink hover:!bg-accent hover:!text-on-accent"
              }`}
            >
              {row.applied ? undoLabel : excludeLabel}
            </button>
          </li>
        ))}
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
      density = "standard",
      framing = "fill",
      refreshToken,
      onRefreshConfigAndStatus,
      onOpenTrashLightbox,
      onOpenLibraryLightbox,
      onOpenWallhaven,
      onManageRules,
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
    // A toggled rule shows its new state at once; the saved config confirms it.
    const [ruleOverrides, setRuleOverrides] = useState<Record<string, boolean>>({});
    const savingRulesRef = useRef<Set<string>>(new Set());
    const suggestionSeqRef = useRef(0);
    const prewarmTimerRef = useRef<number | null>(null);

    const clearPrewarmTimer = useCallback(() => {
      if (prewarmTimerRef.current !== null) {
        window.clearTimeout(prewarmTimerRef.current);
        prewarmTimerRef.current = null;
      }
    }, []);

    const scheduleTilePrewarm = useCallback(
      (item: LightboxPreviewItem, context: LightboxPreviewContext, delayMs: number) => {
        clearPrewarmTimer();
        if (delayMs <= 0) {
          prewarmLightboxPreview(item, context);
          return;
        }
        prewarmTimerRef.current = window.setTimeout(() => {
          prewarmTimerRef.current = null;
          prewarmLightboxPreview(item, context);
        }, delayMs);
      },
      [clearPrewarmTimer],
    );

    useEffect(() => clearPrewarmTimer, [clearPrewarmTimer]);

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

    // Rule edits run one at a time against the lists as last written, so two
    // quick clicks cannot overwrite each other with a stale config.
    const ruleListsRef = useRef<ExclusionRulesState>(rulesState);
    const ruleQueueRef = useRef<Promise<void>>(Promise.resolve());
    const queuedRuleEditsRef = useRef(0);
    useEffect(() => {
      if (queuedRuleEditsRef.current === 0) ruleListsRef.current = rulesState;
    }, [rulesState]);

    const applyExclusionMutation = async (
      type: "tag" | "combo" | "uploader",
      tags: string[],
      action: "add" | "remove",
    ) => {
      if (!config || tags.length === 0) return;
      const edit = async () => {
        const lists = ruleListsRef.current;
        if (type === "uploader") {
          const target = tags[0].replace(/^@/, "").trim();
          const nextUploaders =
            action === "add"
              ? dedupeStringsCaseInsensitive([...lists.excludeUploaders, target])
              : lists.excludeUploaders.filter((u) => casefold(u) !== casefold(target));
          await window.wayper.patchConfig({ wallhaven: { exclude_uploaders: nextUploaders } });
          ruleListsRef.current = { ...lists, excludeUploaders: nextUploaders };
        } else if (type === "combo" || tags.length >= 2) {
          const targetKey = comboIdentityKey(tags);
          const nextCombos =
            action === "add"
              ? dedupeCombos([...lists.excludeCombos, tags], { dropSupersets: true })
              : lists.excludeCombos.filter((c) => comboIdentityKey(c) !== targetKey);
          await window.wayper.patchConfig({ wallhaven: { exclude_combos: nextCombos } });
          ruleListsRef.current = { ...lists, excludeCombos: nextCombos };
        } else {
          const norm = normalizeTag(tags[0]);
          const nextTags =
            action === "add"
              ? dedupeTagsNormalized([...lists.excludeTags, norm])
              : lists.excludeTags.filter((x) => normalizeTag(x) !== norm);
          await window.wayper.patchConfig({ wallhaven: { exclude_tags: nextTags } });
          ruleListsRef.current = { ...lists, excludeTags: nextTags };
        }
        await onRefreshConfigAndStatus();
        setSuggestionsStale(true);
      };
      queuedRuleEditsRef.current += 1;
      const task = ruleQueueRef.current.then(edit);
      ruleQueueRef.current = task.catch(() => undefined);
      try {
        await task;
      } finally {
        queuedRuleEditsRef.current -= 1;
      }
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
    const isMatte = framing === "matte";
    const cardGridClass =
      density === "compact"
        ? "grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-2.5"
        : density === "gallery"
          ? "grid-cols-[repeat(auto-fill,minmax(372px,1fr))] gap-4"
          : "grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3";

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
      applied:
        ruleOverrides[`tag-${item.tag}`] ?? isRuleApplied(rulesState, "tag", [item.tag]),
    }));
    const comboRows: RuleRow[] = comboSuggestions.map((item) => ({
      key: `combo-${comboIdentityKey(item.tags)}`,
      type: "combo",
      label: item.tags.join(" + "),
      tags: [...item.tags],
      banned: item.banned,
      kept: item.kept + item.favorites,
      applied:
        ruleOverrides[`combo-${comboIdentityKey(item.tags)}`] ??
        isRuleApplied(rulesState, "combo", item.tags),
    }));
    const uploaderRows: RuleRow[] = uploaderSuggestions.map((item) => ({
      key: `uploader-${item.uploader}`,
      type: "uploader",
      label: `@${item.uploader}`,
      tags: [item.uploader],
      banned: item.ban_count,
      kept: item.kept_count + item.fav_count,
      applied:
        ruleOverrides[`uploader-${item.uploader}`] ??
        isRuleApplied(rulesState, "uploader", [item.uploader]),
    }));
    const ruleColumns: Array<[string, RuleRow[]]> = [
      [t("Tags"), tagRows],
      [t("Tag combos"), comboRows],
      [t("Uploaders"), uploaderRows],
    ];
    const activeRuleCount =
      rulesState.excludeTags.length +
      rulesState.excludeCombos.length +
      rulesState.excludeUploaders.length;
    const hasRuleRows = ruleColumns.some(([, rows]) => rows.length > 0);

    const openRule = (row: RuleRow) =>
      setDrilldown(
        row.type === "uploader"
          ? { kind: "uploader", tags: row.tags, uploader: row.tags[0] }
          : { kind: "tags", tags: row.tags },
      );

    const toggleRule = async (row: RuleRow) => {
      if (savingRulesRef.current.has(row.key)) return;
      savingRulesRef.current.add(row.key);
      setRuleOverrides((prev) => ({ ...prev, [row.key]: !row.applied }));
      try {
        await applyExclusionMutation(row.type, row.tags, row.applied ? "remove" : "add");
        onNotify(row.applied ? t("Exclusion undone") : t("Excluded"), "success");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : "Failed updating exclusion rule", "error");
      } finally {
        savingRulesRef.current.delete(row.key);
        setRuleOverrides((prev) => {
          const next = { ...prev };
          delete next[row.key];
          return next;
        });
      }
    };

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
                        transition={motionTransition.select}
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
                            {t("Blocked")}
                            <span className="ml-1.5 tabular-nums text-ink">{drillStats.banned}</span>
                          </span>
                          <span>
                            {t("Kept")}
                            <span className="ml-1.5 tabular-nums text-ink">{drillStats.kept}</span>
                          </span>
                        </>
                      )}
                      {!drilldownLoading && (
                        <span>
                          {t("In your library")}
                          <span className="ml-1.5 tabular-nums text-ink">
                            {drilldownMatches.length}
                          </span>
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
                  <span className="mr-1.5 text-[12.5px] text-ink-3">{t("Often blocked together with")}</span>
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
                      title={`${t("Blocked")} ${rt.banned}, ${t("Kept")} ${rt.kept}`}
                      className="group/refine inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.06] pr-3 pl-2 text-[12.5px] text-ink-2 transition-colors hover:bg-white/[0.12] hover:text-ink"
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
                  <div className={`grid ${cardGridClass}`}>
                    {drilldownMatches.map((img) => (
                      <div
                        key={`drill-img-${img.path}`}
                        data-path={img.path}
                        role="button"
                        tabIndex={0}
                        onPointerEnter={() => scheduleTilePrewarm(img, "library", 55)}
                        onPointerLeave={clearPrewarmTimer}
                        onPointerDown={() => scheduleTilePrewarm(img, "library", 0)}
                        onFocus={() => scheduleTilePrewarm(img, "library", 40)}
                        onClick={() => onOpenLibraryLightbox(img, drilldownMatches)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenLibraryLightbox(img, drilldownMatches);
                          }
                        }}
                        className={`wallpaper-card aspect-[16/10] cursor-pointer ${
                          isMatte ? "bg-[#0f0f11]" : ""
                        }`}
                      >
                        <img
                          src={thumbUrl(img.path)}
                          alt={img.name}
                          loading="lazy"
                          className={`h-full w-full ${
                            isMatte
                              ? "object-contain p-3.5 drop-shadow-[0_12px_24px_rgb(0_0_0/0.75)]"
                              : "object-cover"
                          }`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : tab === "rules" ? (
            <section className="w-full">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <p className="m-0 max-w-[720px] text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "What shows up most in the wallpapers you blocked. Exclude one and new downloads skip it.",
                  )}
                </p>
                {activeRuleCount > 0 && (
                  <button
                    type="button"
                    onClick={onManageRules}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-1.5 pl-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-white/[0.07] hover:text-ink"
                  >
                    <span>{t("Excluded so far")}</span>
                    <span className="tabular-nums text-ink-3">{activeRuleCount}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              {suggestionsLoaded && !hasRuleRows ? (
                <p className="m-0 py-10 text-center text-[13.5px] text-ink-2">
                  {t("No rule suggestions yet")}
                </p>
              ) : (
              <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-4">
                  {ruleColumns
                    .filter(([, rows]) => !suggestionsLoaded || rows.length > 0)
                    .map(([title, rows]) => (
                      <RuleTable
                        key={title}
                        title={title}
                        rows={rows}
                        loading={!suggestionsLoaded}
                        blockedLabel={t("Blocked")}
                        keptLabel={t("Kept")}
                        excludeLabel={t("Exclude")}
                        undoLabel={t("Undo")}
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
              <div className={`grid ${cardGridClass}`}>
                {trashImages.slice(0, visibleTrashCount).map((item) => (
                  <div
                    key={`trash-${item.name}`}
                    data-path={item.path}
                    role="button"
                    tabIndex={0}
                    onPointerEnter={() => scheduleTilePrewarm(item, "trash", 55)}
                    onPointerLeave={clearPrewarmTimer}
                    onPointerDown={() => scheduleTilePrewarm(item, "trash", 0)}
                    onFocus={() => scheduleTilePrewarm(item, "trash", 40)}
                    onClick={() => onOpenTrashLightbox(item, trashImages)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenTrashLightbox(item, trashImages);
                      }
                    }}
                    className={`wallpaper-card group aspect-[16/10] cursor-pointer ${
                      isMatte ? "bg-[#0f0f11]" : ""
                    }`}
                  >
                    <img
                      src={trashThumbUrl(item.name)}
                      alt={item.name}
                      loading="lazy"
                      decoding="async"
                      onError={() => void handleTrashThumbError(item.name)}
                      className={`wallpaper-thumbnail h-full w-full ${
                        isMatte
                          ? "object-contain p-3.5 drop-shadow-[0_12px_24px_rgb(0_0_0/0.75)]"
                          : "object-cover"
                      }`}
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
            <div className="w-full">
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-2.5">
                {entries.slice(0, visibleBlockedCount).map((entry) => (
                  <div
                    key={`bl-row-${entry.filename}`}
                    className="group flex h-16 items-center gap-3 rounded-xl bg-white/[0.025] p-2 pr-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors hover:bg-white/[0.05]"
                  >
                    <span className="relative flex h-12 w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.05] text-ink-3">
                      {entry.recoverable ? (
                        <img
                          src={trashThumbUrl(entry.filename)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                          }}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <ImageOff className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onOpenWallhaven(entry.filename)}
                        title={`${t("Open on Wallhaven")} [O]`}
                        className="block max-w-full truncate text-[13px] tabular-nums text-ink underline-offset-2 hover:underline"
                      >
                        {entry.filename}
                      </button>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            entry.recoverable ? "bg-keep" : "bg-white/20"
                          }`}
                        />
                        <span className="shrink-0">
                          {entry.recoverable ? t("In Trash") : t("Deleted")}
                        </span>
                        <span className="shrink-0 text-white/20">·</span>
                        <span className="truncate tabular-nums">
                          {formatTimestamp(entry.timestamp, locale)}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleUnblock(entry)}
                      title={t("Unblock")}
                      aria-label={t("Unblock")}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 opacity-0 transition-[opacity,background-color,color] duration-100 group-hover:opacity-100 hover:bg-white/[0.1] hover:text-ink focus-visible:opacity-100"
                    >
                      <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
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
