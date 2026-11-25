import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ArrowDownToLine,
  AtSign,
  Command,
  Hash,
  Keyboard,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import appIcon from "../../../assets/icon-64.png";
import type {
  ConfigPayload,
  DiskUsageResponse,
  FilterStrategy,
  GalleryMode,
  Purity,
  SearchResponse,
  StatusResponse,
  UpdateCheckResponse,
} from "../../shared/types";
import type {
  GalleryDensity,
  GalleryFraming,
  GalleryPreferences,
} from "../lib/gallery-prefs";
import { motionTransition } from "../lib/motion";

interface SuggestionEntry {
  kind: "uploader" | "tag";
  value: string;
  label: string;
}

export interface TopBarHandle {
  toggleViewOptions: () => void;
}

interface TopBarProps {
  t: (key: string) => string;
  view: "workspace" | "settings";
  immersive: boolean;
  overlayOpen?: boolean;
  mode: GalleryMode;
  onSelectMode: (mode: GalleryMode) => void;
  onToggleSettings: () => void;
  status: StatusResponse | null;
  heldCount: number;
  recommendedCount: number;
  filterStrategy: FilterStrategy;
  onChangeFilterStrategy: (strategy: FilterStrategy) => void;
  purities: Purity[];
  shakingPurity: Purity | null;
  purityHint: string | null;
  onTogglePurity: (purity: Purity) => void;
  config: ConfigPayload | null;
  diskUsage: DiskUsageResponse | null;
  updateInfo: UpdateCheckResponse | null;
  onOpenUpdate: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchQuery: string;
  activeFilterLabel: string | null;
  matchCount: number | null;
  isSearching: boolean;
  onCommitSearch: (query: string) => Promise<SearchResponse | null> | void;
  onSelectUploader: (uploader: string) => void;
  onSelectTag: (tag: string) => void;
  onClearSearch: () => void;
  galleryPrefs: GalleryPreferences;
  onChangeGalleryPrefs: (next: GalleryPreferences) => void;
  onOpenCommandPalette: () => void;
}

const PURITY_DOT: Record<Purity, string> = {
  sfw: "bg-keep",
  sketchy: "bg-warn",
  nsfw: "bg-drop",
};

const ICON_BUTTON =
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink";

function formatStorage(megabytes: number): string {
  if (megabytes >= 1000) {
    const gigabytes = megabytes / 1000;
    return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
  }
  return `${Math.round(megabytes)} MB`;
}

export const TopBar = forwardRef<TopBarHandle, TopBarProps>(function TopBar(
  {
    t,
    view,
    immersive,
    overlayOpen = false,
    mode,
    onSelectMode,
    onToggleSettings,
    status,
    heldCount,
    recommendedCount,
    filterStrategy,
    onChangeFilterStrategy,
    purities,
    shakingPurity,
    purityHint,
    onTogglePurity,
    config,
    diskUsage,
    updateInfo,
    onOpenUpdate,
    searchInputRef,
    searchQuery,
    activeFilterLabel,
    matchCount,
    isSearching,
    onCommitSearch,
    onSelectUploader,
    onSelectTag,
    onClearSearch,
    galleryPrefs,
    onChangeGalleryPrefs,
    onOpenCommandPalette,
  },
  ref,
) {
  const platform = window.wayper.platform;
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const hasFramelessDrag = isMac || isWin;

  const [draft, setDraft] = useState(searchQuery);
  const [openDropdown, setOpenDropdown] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setDraft(searchQuery);
    if (!searchQuery) {
      setSuggestions([]);
      setActiveIndex(-1);
      setOpenDropdown(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpenDropdown(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const scheduleSearch = (rawValue: string) => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
      requestSeqRef.current += 1;
      setSuggestions([]);
      setActiveIndex(-1);
      setOpenDropdown(false);
      onClearSearch();
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      const seq = ++requestSeqRef.current;
      try {
        const committed = await onCommitSearch(trimmed);
        const res =
          committed ??
          (trimmed.startsWith("@") || trimmed.includes("+")
            ? await window.wayper.searchImages({ query: trimmed })
            : null);
        if (seq !== requestSeqRef.current) return;
        if (!res) {
          setSuggestions([]);
          setOpenDropdown(false);
          return;
        }
        const uploaderItems: SuggestionEntry[] = (res.uploader_suggestions ?? [])
          .slice(0, 6)
          .map((u) => ({
            kind: "uploader",
            value: u,
            label: u.startsWith("@") ? u : `@${u}`,
          }));
        const tagItems: SuggestionEntry[] = (res.suggestions ?? []).slice(0, 10).map((tag) => ({
          kind: "tag",
          value: tag,
          label: tag,
        }));
        const combined = [...uploaderItems, ...tagItems];
        setSuggestions(combined);
        setActiveIndex(-1);
        setOpenDropdown(combined.length > 0 && document.activeElement === searchInputRef.current);
      } catch {
        if (seq !== requestSeqRef.current) return;
        setSuggestions([]);
        setOpenDropdown(false);
      }
    }, 200);
  };

  const applySuggestion = (entry: SuggestionEntry) => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    setOpenDropdown(false);
    setActiveIndex(-1);
    if (entry.kind === "uploader") {
      const clean = entry.value.replace(/^@/, "");
      setDraft(`@${clean}`);
      onSelectUploader(clean);
    } else {
      setDraft(entry.value);
      onSelectTag(entry.value);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (suggestions.length > 0) {
        e.preventDefault();
        setOpenDropdown(true);
        setActiveIndex((prev) => (prev + 1) % suggestions.length);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      if (suggestions.length > 0) {
        e.preventDefault();
        setOpenDropdown(true);
        setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (openDropdown && activeIndex >= 0 && suggestions[activeIndex]) {
        applySuggestion(suggestions[activeIndex]);
      } else {
        const trimmed = draft.trim();
        setOpenDropdown(false);
        if (!trimmed) {
          onClearSearch();
        } else if (trimmed.startsWith("@") && trimmed.length > 1 && !trimmed.includes(" ")) {
          onSelectUploader(trimmed.slice(1));
        } else {
          onCommitSearch(trimmed);
        }
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (openDropdown) {
        setOpenDropdown(false);
        setActiveIndex(-1);
      } else if (draft || searchQuery || activeFilterLabel) {
        setDraft("");
        setSuggestions([]);
        onClearSearch();
      } else {
        searchInputRef.current?.blur();
      }
    }
  };

  const hasQueryOrFilter = Boolean(draft || searchQuery || activeFilterLabel);


  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({ toggleViewOptions: () => setFiltersOpen((open) => !open) }),
    [],
  );

  useEffect(() => {
    if (purityHint) setFiltersOpen(true);
  }, [purityHint]);

  useEffect(() => {
    setFiltersOpen(false);
    setOpenDropdown(false);
  }, [mode, view, overlayOpen]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(event.target as Node)) {
        setFiltersOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setFiltersOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [filtersOpen]);

  const reviewTotal = heldCount + recommendedCount;
  const navItems: Array<{
    value: GalleryMode;
    label: string;
    hint: string;
    count?: number;
    badge?: number;
  }> = [
    { value: "pool", label: t("Pool"), hint: "1", count: status?.pool_count },
    { value: "favorites", label: t("Favorites"), hint: "2", count: status?.favorites_count },
    { value: "model-review", label: t("Review"), hint: "3", badge: reviewTotal },
    { value: "trash", label: t("Blocklist"), hint: "4" },
  ];

  const purityItems: Array<{ value: Purity; label: string; kbd: string }> = [
    { value: "sfw", label: t("SFW"), kbd: "F1" },
    { value: "sketchy", label: t("Sketchy"), kbd: "F2" },
    { value: "nsfw", label: t("NSFW"), kbd: "F3" },
  ];

  const strategyItems: Array<{ value: FilterStrategy; label: string }> = [
    { value: "rules", label: t("Rules") },
    { value: "model", label: t("Model") },
    { value: "rules+model", label: t("Both") },
  ];
  const densityItems: Array<{ value: GalleryDensity; label: string }> = [
    { value: "compact", label: t("Compact") },
    { value: "standard", label: t("Standard") },
    { value: "gallery", label: t("Gallery") },
  ];
  const framingItems: Array<{ value: GalleryFraming; label: string }> = [
    { value: "fill", label: t("Fill") },
    { value: "matte", label: t("Matte") },
  ];

  const usedMb = diskUsage?.used_mb ?? 0;
  const quotaMb = diskUsage?.quota_mb ?? config?.quota_mb ?? 4000;
  const usedPct = quotaMb > 0 ? Math.min(100, Math.round((usedMb / quotaMb) * 100)) : 0;
  const meterColor = usedPct >= 90 ? "bg-drop" : usedPct >= 75 ? "bg-warn" : "bg-ink";
  const horizontalPadding = isMac
    ? "pl-[82px] pr-6"
    : isWin
      ? "pl-6 pr-[144px]"
      : "px-6";

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[60px]">
      <div className="topbar-veil" hidden={immersive} aria-hidden="true">
        <i />
        <b />
      </div>
      <div
        className={`pointer-events-auto relative grid h-full grid-cols-[1fr_minmax(150px,380px)_1fr] items-center gap-4 ${horizontalPadding} ${
          hasFramelessDrag ? "app-drag" : ""
        }`}
      >
        <div className="app-no-drag flex items-center gap-3.5 justify-self-start">
        {!isMac && (
          <img
            src={appIcon}
            alt="Wayper"
            className="h-6 w-6 shrink-0 rounded-[7px] shadow-[0_2px_8px_rgb(0_0_0/0.35)]"
            draggable={false}
          />
        )}

        <nav className="flex shrink-0 items-center gap-px rounded-full bg-white/[0.055] p-[3px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.045)]">
          {navItems.map((item) => {
            const active = view === "workspace" && mode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => onSelectMode(item.value)}
                title={`${item.label} [${item.hint}]`}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-[30px] items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_1.5px_rgb(255_255_255/0.6)] max-[820px]:px-3 ${
                  active ? "text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-full bg-white/[0.13] shadow-[inset_0_1px_0_rgb(255_255_255/0.09),0_1px_3px_rgb(0_0_0/0.35)]"
                    transition={motionTransition.select}
                  />
                )}
                <span className="relative">{item.label}</span>
                {typeof item.count === "number" && (
                  <span
                    className={`relative text-[11.5px] font-normal tabular-nums transition-colors duration-150 max-[900px]:hidden ${
                      active ? "text-ink-2" : "text-ink-3"
                    }`}
                  >
                    {item.count}
                  </span>
                )}
                {item.badge ? (
                  <span
                    title={`${t("Auto-held")}: ${heldCount} · ${t("Recommended")}: ${recommendedCount}`}
                    className="relative flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10.5px] leading-none font-semibold tabular-nums text-on-accent"
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        </div>

      <div ref={wrapperRef} className="relative min-w-0">
        <div className="app-no-drag group flex h-8 items-center gap-2 rounded-full bg-white/[0.06] px-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)] transition-colors hover:bg-white/[0.08] focus-within:bg-white/[0.095] focus-within:shadow-[0_0_0_1px_rgb(255_255_255/0.22)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-3 transition-colors group-focus-within:text-ink-2" />
          <input
            ref={searchInputRef}
            id="search-input"
            type="text"
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              scheduleSearch(next);
            }}
            onFocus={() => {
              if (suggestions.length > 0) setOpenDropdown(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("Search tags, @uploader, or filename...")}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-[13px] text-ink placeholder-ink-3 outline-none"
          />

          {hasQueryOrFilter && matchCount !== null && (
            <span className="shrink-0 text-[12px] tabular-nums text-ink-3">
              {isSearching ? "…" : matchCount}
            </span>
          )}

          {hasQueryOrFilter ? (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setSuggestions([]);
                setOpenDropdown(false);
                onClearSearch();
              }}
              title={`${t("Clear search")} (Esc)`}
              aria-label={t("Clear search")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-white/10 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="keycap">/</kbd>
          )}
        </div>

        <AnimatePresence>
        {openDropdown && suggestions.length > 0 && (
          <motion.div
            role="listbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionTransition.fast}
            className="absolute top-[calc(100%+6px)] left-1/2 z-40 max-h-[380px] w-full min-w-[300px] -translate-x-1/2 overflow-y-auto glass rounded-2xl p-1.5"
          >
            {suggestions.map((entry, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <button
                  key={`${entry.kind}-${entry.value}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => applySuggestion(entry)}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                    isSelected ? "bg-white/[0.09] text-ink" : "text-ink-2"
                  }`}
                >
                  {entry.kind === "uploader" ? (
                    <AtSign className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  ) : (
                    <Hash className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {entry.kind === "uploader" ? entry.value.replace(/^@/, "") : entry.label}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-ink-3">
                    {entry.kind === "uploader" ? t("Uploader") : t("Tag")}
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
        </AnimatePresence>
      </div>

        <div className="app-no-drag flex items-center gap-1 justify-self-end">
        {updateInfo?.update_available && (
          <button
            type="button"
            onClick={onOpenUpdate}
            title={`${t("Update available")}${updateInfo.latest_version ? ` (${updateInfo.latest_version})` : ""}`}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.08] mr-1.5 px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-white/[0.14] max-[900px]:hidden"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span className="tabular-nums">
              {updateInfo.latest_version
                ? `v${updateInfo.latest_version.replace(/^v/, "")}`
                : t("Update available")}
            </span>
          </button>
        )}

        <div ref={filtersRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            title={`${t("View options")} [F4]`}
            aria-label={t("View options")}
            aria-expanded={filtersOpen}
            className={`flex h-8 shrink-0 items-center gap-2 rounded-full pr-2.5 pl-2.5 text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink ${
              filtersOpen ? "bg-white/[0.1] text-ink" : ""
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
            <span className="flex items-center gap-[3px]">
              {purityItems.map((p) => (
                <span
                  key={p.value}
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${
                    purities.includes(p.value) ? PURITY_DOT[p.value] : "bg-white/15"
                  } ${shakingPurity === p.value ? "animate-shake" : ""}`}
                />
              ))}
            </span>
          </button>

          <AnimatePresence>
            {filtersOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={motionTransition.fast}
                style={{ transformOrigin: "top right" }}
                className="glass absolute top-[calc(100%+8px)] right-0 z-40 flex w-[300px] flex-col gap-4 rounded-2xl p-4"
              >
                <div>
                  <div className="mb-2 flex items-center justify-between text-[12.5px] text-ink-3">
                    <span>{t("Purity")}</span>
                    <span className="flex items-center gap-1" aria-hidden="true">
                      {purityItems.map((p) => (
                        <kbd key={p.value} className="keycap">
                          {p.kbd}
                        </kbd>
                      ))}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {purityItems.map((p) => {
                      const active = purities.includes(p.value);
                      return (
                        <button
                          key={p.value}
                          type="button"
                          aria-pressed={active}
                          title={`${p.label} [${p.kbd}]`}
                          onClick={() => onTogglePurity(p.value)}
                          className={`flex h-9 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium transition-colors ${
                            active
                              ? "bg-white/[0.12] text-ink"
                              : "bg-white/[0.04] text-ink-3 hover:bg-white/[0.07] hover:text-ink-2"
                          } ${shakingPurity === p.value ? "animate-shake" : ""}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full transition-colors ${
                              active ? PURITY_DOT[p.value] : "bg-white/15"
                            }`}
                          />
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  {purityHint && (
                    <div role="status" className="mt-2 text-[12px] leading-snug text-warn">
                      {purityHint}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-2 text-[12.5px] text-ink-3">{t("Filter Strategy")}</div>
                  <div
                    role="radiogroup"
                    aria-label={t("Filter Strategy")}
                    className="grid grid-cols-3 gap-0.5 rounded-xl bg-white/[0.05] p-0.5"
                  >
                    {strategyItems.map((item) => {
                      const selected = filterStrategy === item.value;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => onChangeFilterStrategy(item.value)}
                          className={`relative h-8 rounded-[10px] text-[13px] font-medium transition-colors ${
                            selected ? "text-ink" : "text-ink-3 hover:text-ink-2"
                          }`}
                        >
                          {selected && (
                            <motion.span
                              layoutId="strategy-pill"
                              className="absolute inset-0 rounded-[10px] bg-white/[0.13] shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
                              transition={motionTransition.select}
                            />
                          )}
                          <span className="relative">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3 border-t border-white/[0.07] pt-3.5">
                  <div>
                    <div className="mb-2 text-[12.5px] text-ink-3">{t("Grid Size")}</div>
                    <div
                      role="radiogroup"
                      aria-label={t("Grid Size")}
                      className="grid grid-cols-3 gap-0.5 rounded-xl bg-white/[0.05] p-0.5"
                    >
                      {densityItems.map((item) => {
                        const selected = galleryPrefs.density === item.value;
                        return (
                          <button
                            key={item.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() =>
                              onChangeGalleryPrefs({ ...galleryPrefs, density: item.value })
                            }
                            className={`relative h-8 rounded-[10px] text-[12.5px] font-medium transition-colors ${
                              selected ? "text-ink" : "text-ink-3 hover:text-ink-2"
                            }`}
                          >
                            {selected && (
                              <motion.span
                                layoutId="density-pill"
                                className="absolute inset-0 rounded-[10px] bg-white/[0.13] shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
                                transition={motionTransition.select}
                              />
                            )}
                            <span className="relative">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-[12.5px] text-ink-3">{t("Framing")}</div>
                    <div
                      role="radiogroup"
                      aria-label={t("Framing")}
                      className="grid grid-cols-2 gap-0.5 rounded-xl bg-white/[0.05] p-0.5"
                    >
                      {framingItems.map((item) => {
                        const selected = galleryPrefs.framing === item.value;
                        return (
                          <button
                            key={item.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() =>
                              onChangeGalleryPrefs({ ...galleryPrefs, framing: item.value })
                            }
                            className={`relative h-8 rounded-[10px] text-[12.5px] font-medium transition-colors ${
                              selected ? "text-ink" : "text-ink-3 hover:text-ink-2"
                            }`}
                          >
                            {selected && (
                              <motion.span
                                layoutId="framing-pill"
                                className="absolute inset-0 rounded-[10px] bg-white/[0.13] shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
                                transition={motionTransition.select}
                              />
                            )}
                            <span className="relative">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-baseline justify-between text-[12.5px]">
                    <span className="text-ink-3">{t("Storage")}</span>
                    <span className="tabular-nums text-ink-2">
                      {diskUsage ? `${formatStorage(usedMb)} / ${formatStorage(quotaMb)}` : "—"}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${meterColor}`}
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={onOpenCommandPalette}
          title={`${t("Commands & shortcuts")} [? / ${isMac ? "⌘K" : "Ctrl+K"}]`}
          aria-label={t("Commands & shortcuts")}
          className={ICON_BUTTON}
        >
          {isMac ? (
            <Command className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <Keyboard className="h-4 w-4" strokeWidth={1.75} />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleSettings}
          title={`${t("Settings")} [S]`}
          aria-label={t("Settings")}
          className={`${ICON_BUTTON} ${view === "settings" ? "bg-white/[0.1] text-ink" : ""}`}
        >
          <Settings2 className="h-4 w-4" strokeWidth={1.75} />
        </button>
        </div>
      </div>
    </header>
  );
});
