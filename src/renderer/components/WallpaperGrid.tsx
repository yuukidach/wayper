import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Ban,
  ExternalLink,
  Heart,
  Loader2,
  MonitorUp,
  ThumbsDown,
} from "lucide-react";
import type { ImageItem, Orientation, Purity } from "../../shared/types";
import { casefold } from "../../shared/tags";
import type { GalleryDensity, GalleryFraming } from "../lib/gallery-prefs";
import { prewarmLightboxPreview } from "../lib/lightbox-preview";
import { thumbUrl } from "../lib/media";
import { motionDuration, motionEasing, prefersReducedMotion, scrollMotion } from "../lib/motion";

const PAGE_SIZE = 120;

type RemovalKind = "dislike" | "ban";

function sameItems(left: ImageItem[], right: ImageItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.path === right[index].path && item.is_favorite === right[index].is_favorite,
  );
}

export interface WallpaperGridHandle {
  navigateByKey: (key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight") => void;
  locateCurrent: () => Promise<boolean>;
  jumpToTop: () => void;
  jumpToBottom: () => void;
  getFocusedItem: () => ImageItem | null;
  openFocusedInLightbox: () => boolean;
  clearFocus: () => void;
  removeFocused: (kind: RemovalKind) => boolean;
  refresh: () => void;
}

interface WallpaperGridProps {
  t: (key: string) => string;
  mode: "pool" | "favorites";
  purities: Purity[];
  orientation: Orientation;
  density?: GalleryDensity;
  framing?: GalleryFraming;
  activeImagePath: string | null;
  searchQuery: string;
  searchMatches: Set<string> | null;
  refreshToken: number;
  /** Scrolls with the grid, above the first row. */
  header?: React.ReactNode;
  onFilteredCountChange: (count: number | null) => void;
  onOpenLightbox: (item: ImageItem, list: ImageItem[]) => void;
  onSetWallpaper: (item: ImageItem) => void;
  onToggleFavorite: (item: ImageItem) => Promise<{ new_path: string; is_favorite: boolean } | null>;
  onDislike: (item: ImageItem) => Promise<boolean>;
  onBan: (item: ImageItem) => Promise<boolean>;
  onOpenWallhaven: (filenameOrPath: string) => void;
  onClearFilter: () => void;
}

export const WallpaperGrid = memo(forwardRef<WallpaperGridHandle, WallpaperGridProps>(
  (
    {
      t,
      mode,
      purities,
      orientation,
      density = "standard",
      framing = "fill",
      activeImagePath,
      searchQuery,
      searchMatches,
      refreshToken,
      header,
      onFilteredCountChange,
      onOpenLightbox,
      onSetWallpaper,
      onToggleFavorite,
      onDislike,
      onBan,
      onOpenWallhaven,
      onClearFilter,
    },
    ref,
  ) => {
    const [allItems, setAllItems] = useState<ImageItem[]>([]);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [initialLoading, setInitialLoading] = useState<boolean>(true);
    // What the grid is laid out for.  It trails the requested context until the
    // new page arrives, so the previous cards stay in place instead of blinking
    // out for a spinner.
    const [shown, setShown] = useState<{ orientation: Orientation; epoch: number }>({
      orientation,
      epoch: 0,
    });
    const [loadingMore, setLoadingMore] = useState<boolean>(false);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const contextSeqRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const initialLoadingRef = useRef(true);
    const reconcileSeqRef = useRef(0);
    const lastRefreshTokenRef = useRef(refreshToken);
    const pendingRemovalsRef = useRef<Set<string>>(new Set());
    const reflowFromRef = useRef<Map<string, DOMRect> | null>(null);
    const prewarmTimerRef = useRef<number | null>(null);
    const allItemsRef = useRef<ImageItem[]>(allItems);
    allItemsRef.current = allItems;

    const clearPrewarmTimer = useCallback(() => {
      if (prewarmTimerRef.current !== null) {
        window.clearTimeout(prewarmTimerRef.current);
        prewarmTimerRef.current = null;
      }
    }, []);

    const scheduleTilePrewarm = useCallback(
      (item: ImageItem, delayMs: number) => {
        clearPrewarmTimer();
        if (delayMs <= 0) {
          prewarmLightboxPreview(item, "library");
          return;
        }
        prewarmTimerRef.current = window.setTimeout(() => {
          prewarmTimerRef.current = null;
          prewarmLightboxPreview(item, "library");
        }, delayMs);
      },
      [clearPrewarmTimer],
    );

    useEffect(() => clearPrewarmTimer, [clearPrewarmTimer]);

    const purityParam = useMemo(() => [...purities].sort().join(","), [purities]);

    const loadFirstPage = useCallback(async () => {
      const seq = ++contextSeqRef.current;
      loadingMoreRef.current = false;
      initialLoadingRef.current = true;
      setInitialLoading(true);
      setLoadingMore(false);
      const showContext = () => {
        setShown((prev) => ({ orientation, epoch: prev.epoch + 1 }));
        scrollRef.current?.scrollTo({ top: 0 });
      };
      try {
        const page = await window.wayper.getImagesPage({
          mode,
          purity: purityParam,
          orient: orientation,
          offset: 0,
          limit: PAGE_SIZE,
        });
        if (seq !== contextSeqRef.current) return;
        setAllItems(page.items ?? []);
        setNextOffset(page.next_offset ?? null);
        showContext();
        setFocusedIndex((prev) => {
          if (prev < 0) return -1;
          const len = (page.items ?? []).length;
          return len === 0 ? -1 : Math.min(prev, len - 1);
        });
      } catch (err) {
        console.error("Failed to fetch images page:", err);
        if (seq === contextSeqRef.current) {
          setAllItems([]);
          setNextOffset(null);
          showContext();
        }
      } finally {
        if (seq === contextSeqRef.current) {
          initialLoadingRef.current = false;
          setInitialLoading(false);
        }
      }
    }, [mode, purityParam, orientation]);

    useEffect(() => {
      void loadFirstPage();
    }, [loadFirstPage]);

    // Remember where the nearby cards are so they can glide to their new slots.
    const captureLayout = useCallback(() => {
      const root = scrollRef.current;
      if (!root || prefersReducedMotion()) return;
      const bounds = root.getBoundingClientRect();
      const rects = new Map<string, DOMRect>();
      for (const [itemPath, card] of cardRefs.current) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom < bounds.top - bounds.height || rect.top > bounds.bottom + bounds.height) {
          continue;
        }
        rects.set(itemPath, rect);
      }
      reflowFromRef.current = rects;
    }, []);

    // Library changes are merged into the loaded range in place: no spinner and
    // no scroll reset, only a change of context reloads the grid from scratch.
    const reconcile = useCallback(async () => {
      if (initialLoadingRef.current) return;
      const contextSeq = contextSeqRef.current;
      const seq = ++reconcileSeqRef.current;
      const hidden = new Set(pendingRemovalsRef.current);
      const wanted = Math.max(PAGE_SIZE, allItemsRef.current.length + hidden.size);
      const fetched: ImageItem[] = [];
      let cursor: number | null = 0;
      try {
        while (cursor !== null && fetched.length < wanted) {
          const page = await window.wayper.getImagesPage({
            mode,
            purity: purityParam,
            orient: orientation,
            offset: cursor,
            limit: wanted - fetched.length,
          });
          if (contextSeq !== contextSeqRef.current || seq !== reconcileSeqRef.current) return;
          fetched.push(...(page.items ?? []));
          cursor = page.next_offset ?? null;
        }
      } catch (err) {
        console.error("Failed to reconcile images:", err);
        return;
      }
      for (const itemPath of pendingRemovalsRef.current) hidden.add(itemPath);
      const next = hidden.size > 0 ? fetched.filter((item) => !hidden.has(item.path)) : fetched;
      if (!sameItems(allItemsRef.current, next)) {
        captureLayout();
        setAllItems(next);
      }
      setNextOffset(cursor);
    }, [mode, purityParam, orientation, captureLayout]);

    useEffect(() => {
      if (lastRefreshTokenRef.current === refreshToken) return;
      lastRefreshTokenRef.current = refreshToken;
      void reconcile();
    }, [refreshToken, reconcile]);

    const loadNextPage = useCallback(async (): Promise<{
      appended: ImageItem[];
      next: number | null;
    } | null> => {
      if (loadingMoreRef.current || nextOffset === null) return null;
      const seq = contextSeqRef.current;
      loadingMoreRef.current = true;
      setLoadingMore(true);
      try {
        const page = await window.wayper.getImagesPage({
          mode,
          purity: purityParam,
          orient: orientation,
          offset: nextOffset,
          limit: PAGE_SIZE,
        });
        if (seq !== contextSeqRef.current) return null;
        const incoming = page.items ?? [];
        setAllItems((prev) => {
          const existingPaths = new Set(prev.map((i) => i.path));
          const deduped = incoming.filter((i) => !existingPaths.has(i.path));
          return [...prev, ...deduped];
        });
        setNextOffset(page.next_offset ?? null);
        return { appended: incoming, next: page.next_offset ?? null };
      } catch (err) {
        console.error("Failed to load next page:", err);
        return null;
      } finally {
        if (seq === contextSeqRef.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    }, [mode, purityParam, orientation, nextOffset]);

    // When client-side search/filter is active, automatically fetch any remaining pages
    const hasFilter = searchMatches !== null || Boolean(searchQuery.trim());
    useEffect(() => {
      if (!hasFilter || nextOffset === null || initialLoading) return;
      let cancelled = false;
      const seq = contextSeqRef.current;

      const drainRemaining = async () => {
        let cursor: number | null = nextOffset;
        const accumulated: ImageItem[] = [];
        loadingMoreRef.current = true;
        setLoadingMore(true);
        try {
          while (!cancelled && cursor !== null && seq === contextSeqRef.current) {
            const page = await window.wayper.getImagesPage({
              mode,
              purity: purityParam,
              orient: orientation,
              offset: cursor,
              limit: PAGE_SIZE,
            });
            if (cancelled || seq !== contextSeqRef.current) return;
            accumulated.push(...(page.items ?? []));
            cursor = page.next_offset ?? null;
          }
          if (!cancelled && seq === contextSeqRef.current) {
            setAllItems((prev) => {
              const seen = new Set(prev.map((i) => i.path));
              const extra = accumulated.filter((i) => !seen.has(i.path));
              return [...prev, ...extra];
            });
            setNextOffset(null);
          }
        } catch (err) {
          console.error("Failed draining pages for search:", err);
        } finally {
          if (seq === contextSeqRef.current) {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          }
        }
      };

      void drainRemaining();
      return () => {
        cancelled = true;
      };
    }, [hasFilter, nextOffset, initialLoading, mode, purityParam, orientation]);

    // IntersectionObserver for smooth infinite scroll
    useEffect(() => {
      const sentinel = sentinelRef.current;
      const root = scrollRef.current;
      if (!sentinel || !root || nextOffset === null || initialLoading || hasFilter) return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            void loadNextPage();
          }
        },
        { root, rootMargin: "640px 0px" },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [nextOffset, initialLoading, hasFilter, loadNextPage]);

    const filteredItems = useMemo(() => {
      if (!searchMatches && !searchQuery.trim()) return allItems;
      const foldedQuery = casefold(searchQuery.trim());
      return allItems.filter((item) => {
        if (searchMatches) {
          if (searchMatches.has(item.name) || searchMatches.has(item.path)) return true;
        }
        if (foldedQuery && !foldedQuery.startsWith("@") && !foldedQuery.includes("+")) {
          if (casefold(item.name).includes(foldedQuery)) return true;
        }
        return false;
      });
    }, [allItems, searchMatches, searchQuery]);

    useLayoutEffect(() => {
      const before = reflowFromRef.current;
      if (!before) return;
      reflowFromRef.current = null;
      const moves: Array<{ card: HTMLDivElement; dx: number; dy: number }> = [];
      for (const [itemPath, from] of before) {
        const card = cardRefs.current.get(itemPath);
        if (!card) continue;
        const to = card.getBoundingClientRect();
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (dx !== 0 || dy !== 0) moves.push({ card, dx, dy });
      }
      for (const { card, dx, dy } of moves) {
        card.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: motionDuration.normal * 1000, easing: motionEasing },
        );
      }
    }, [filteredItems]);

    useEffect(() => {
      if (focusedIndex >= filteredItems.length) setFocusedIndex(filteredItems.length - 1);
    }, [focusedIndex, filteredItems.length]);

    // The card leaves at once; the library catches up in the background and
    // the card only comes back if the request fails.
    const removeCard = useCallback(
      async (item: ImageItem, kind: RemovalKind) => {
        if (pendingRemovalsRef.current.has(item.path)) return;
        pendingRemovalsRef.current.add(item.path);
        const request = kind === "dislike" ? onDislike(item) : onBan(item);
        const card = cardRefs.current.get(item.path);
        if (card && !prefersReducedMotion()) {
          const exit = card.animate(
            [
              { opacity: 1, transform: "scale(1)" },
              { opacity: 0, transform: "scale(0.94)" },
            ],
            { duration: 140, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
          );
          await Promise.race([
            exit.finished.catch(() => undefined),
            new Promise((resolve) => window.setTimeout(resolve, 220)),
          ]);
        }
        captureLayout();
        setAllItems((prev) => prev.filter((entry) => entry.path !== item.path));
        const ok = await request;
        pendingRemovalsRef.current.delete(item.path);
        if (!ok) void reconcile();
      },
      [onDislike, onBan, captureLayout, reconcile],
    );

    useEffect(() => {
      if (hasFilter) {
        onFilteredCountChange(filteredItems.length);
      } else {
        onFilteredCountChange(null);
      }
    }, [hasFilter, filteredItems.length, onFilteredCountChange]);

    const focusCardAtIndex = useCallback(
      (index: number, behavior: ScrollBehavior = scrollMotion()) => {
        if (filteredItems.length === 0) {
          setFocusedIndex(-1);
          return;
        }
        const clamped = Math.max(0, Math.min(filteredItems.length - 1, index));
        setFocusedIndex(clamped);
        const target = filteredItems[clamped];
        if (target) {
          const el = cardRefs.current.get(target.path);
          if (el) {
            el.focus({ preventScroll: true });
            el.scrollIntoView({ block: "nearest", behavior });
          }
        }
      },
      [filteredItems],
    );

    const getColumnCount = (): number => {
      const grid = gridRef.current;
      if (!grid) return 4;
      const template = window.getComputedStyle(grid).gridTemplateColumns;
      if (!template || template === "none") return 1;
      return Math.max(1, template.trim().split(/\s+/).length);
    };

    useImperativeHandle(
      ref,
      () => ({
        navigateByKey: (key) => {
          if (filteredItems.length === 0) return;
          const cols = getColumnCount();
          if (focusedIndex < 0) {
            focusCardAtIndex(0);
            return;
          }
          let next = focusedIndex;
          if (key === "ArrowRight") next = Math.min(filteredItems.length - 1, focusedIndex + 1);
          else if (key === "ArrowLeft") next = Math.max(0, focusedIndex - 1);
          else if (key === "ArrowDown")
            next = Math.min(filteredItems.length - 1, focusedIndex + cols);
          else if (key === "ArrowUp") next = Math.max(0, focusedIndex - cols);
          focusCardAtIndex(next);
        },
        locateCurrent: async () => {
          if (!activeImagePath) return false;
          const existingIdx = filteredItems.findIndex((i) => i.path === activeImagePath);
          if (existingIdx >= 0) {
            setFocusedIndex(existingIdx);
            const el = cardRefs.current.get(activeImagePath);
            if (el) {
              el.focus({ preventScroll: true });
              el.scrollIntoView({ block: "center", behavior: scrollMotion() });
            }
            return true;
          }

          // Fetch remaining pages if not yet loaded
          if (nextOffset !== null && !hasFilter) {
            const seq = contextSeqRef.current;
            let cursor: number | null = nextOffset;
            const extra: ImageItem[] = [];
            let found = false;
            loadingMoreRef.current = true;
            setLoadingMore(true);
            try {
              while (cursor !== null && seq === contextSeqRef.current) {
                const page = await window.wayper.getImagesPage({
                  mode,
                  purity: purityParam,
                  orient: orientation,
                  offset: cursor,
                  limit: PAGE_SIZE,
                });
                if (seq !== contextSeqRef.current) return false;
                const pageItems = page.items ?? [];
                extra.push(...pageItems);
                cursor = page.next_offset ?? null;
                if (pageItems.some((i) => i.path === activeImagePath)) {
                  found = true;
                  break;
                }
              }
              if (seq === contextSeqRef.current && extra.length > 0) {
                setAllItems((prev) => {
                  const seen = new Set(prev.map((i) => i.path));
                  const merged = [...prev, ...extra.filter((i) => !seen.has(i.path))];
                  const targetIdx = merged.findIndex((i) => i.path === activeImagePath);
                  if (targetIdx >= 0) {
                    window.requestAnimationFrame(() => {
                      setFocusedIndex(targetIdx);
                      const el = cardRefs.current.get(activeImagePath);
                      if (el) {
                        el.focus({ preventScroll: true });
                        el.scrollIntoView({ block: "center", behavior: scrollMotion() });
                      }
                    });
                  }
                  return merged;
                });
                setNextOffset(cursor);
              }
              return found;
            } finally {
              if (seq === contextSeqRef.current) {
                loadingMoreRef.current = false;
                setLoadingMore(false);
              }
            }
          }
          return false;
        },
        jumpToTop: () => {
          scrollRef.current?.scrollTo({ top: 0, behavior: scrollMotion() });
          if (filteredItems.length > 0) {
            focusCardAtIndex(0);
          }
        },
        jumpToBottom: () => {
          if (scrollRef.current) {
            scrollRef.current.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: scrollMotion(),
            });
          }
          if (filteredItems.length > 0) {
            focusCardAtIndex(filteredItems.length - 1);
          }
        },
        getFocusedItem: () => {
          if (focusedIndex >= 0 && focusedIndex < filteredItems.length) {
            return filteredItems[focusedIndex];
          }
          return null;
        },
        openFocusedInLightbox: () => {
          if (focusedIndex >= 0 && focusedIndex < filteredItems.length) {
            onOpenLightbox(filteredItems[focusedIndex], filteredItems);
            return true;
          }
          return false;
        },
        clearFocus: () => {
          setFocusedIndex(-1);
        },
        removeFocused: (kind) => {
          if (focusedIndex < 0 || focusedIndex >= filteredItems.length) return false;
          void removeCard(filteredItems[focusedIndex], kind);
          return true;
        },
        refresh: () => {
          void reconcile();
        },
      }),
      [
        filteredItems,
        focusedIndex,
        focusCardAtIndex,
        activeImagePath,
        nextOffset,
        hasFilter,
        mode,
        purityParam,
        orientation,
        removeCard,
        reconcile,
        onOpenLightbox,
      ],
    );

    const handleCardFavorite = async (e: React.MouseEvent, item: ImageItem) => {
      e.stopPropagation();
      const res = await onToggleFavorite(item);
      if (!res) return;
      setAllItems((prev) => {
        if (mode === "favorites" && !res.is_favorite) {
          return prev.filter((x) => x.path !== item.path);
        }
        return prev.map((x) =>
          x.path === item.path ? { ...x, path: res.new_path, is_favorite: res.is_favorite } : x,
        );
      });
    };

    const handleCardRemove = (e: React.MouseEvent, item: ImageItem, kind: RemovalKind) => {
      e.stopPropagation();
      void removeCard(item, kind);
    };

    const isPortraitGrid = shown.orientation === "portrait";
    const isMatte = framing === "matte";
    const gridColumnsClass = isPortraitGrid
      ? density === "compact"
        ? "grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-2.5"
        : density === "gallery"
          ? "grid-cols-[repeat(auto-fill,minmax(256px,1fr))] gap-4"
          : "grid-cols-[repeat(auto-fill,minmax(194px,1fr))] gap-3"
      : density === "compact"
        ? "grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-2.5"
        : density === "gallery"
          ? "grid-cols-[repeat(auto-fill,minmax(372px,1fr))] gap-4"
          : "grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3";
    const skeletonAspectClass = isPortraitGrid ? "aspect-[10/16]" : "aspect-[16/10]";

    const placeholderHeight = header ? "min-h-[36vh]" : "min-h-[72vh]";
    let placeholder: React.ReactNode = null;
    if (initialLoading && allItems.length === 0) {
      placeholder = (
        <div
          aria-label={t("Loading library...")}
          className={`grid ${gridColumnsClass}`}
        >
          {Array.from({ length: isPortraitGrid ? 10 : 8 }).map((_, idx) => (
            <div
              key={`skeleton-${idx}`}
              className={`wallpaper-skeleton ${skeletonAspectClass}`}
            />
          ))}
        </div>
      );
    } else if (filteredItems.length === 0) {
      if (hasFilter) {
        placeholder = (
          <div
            className={`flex ${placeholderHeight} flex-col items-center justify-center gap-2 px-6 text-center`}
          >
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {t("No matches found")}
            </h2>
            <p className="m-0 max-w-sm truncate text-[13px] text-ink-2">{searchQuery}</p>
            <button
              type="button"
              onClick={onClearFilter}
              className="mt-3 inline-flex h-8 items-center rounded-lg bg-white/[0.07] px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-white/[0.12]"
            >
              {t("Clear filter")}
            </button>
          </div>
        );
      } else {
        placeholder = (
          <div
            className={`flex ${placeholderHeight} flex-col items-center justify-center gap-2 px-6 text-center`}
          >
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {mode === "favorites" ? t("No favorites yet") : t("No wallpapers in Pool yet")}
            </h2>
            <p className="m-0 max-w-sm text-[13px] leading-relaxed text-ink-2">
              {mode === "favorites"
                ? t("Mark wallpapers you love with [F] to build your collection and guide the model.")
                : t("Press Next [L] or trigger a sync to pull fresh wallpapers from Wallhaven.")}
            </p>
          </div>
        );
      }
    }

    return (
      <div
        ref={scrollRef}
        className="page-scroll h-full w-full scroll-pt-20 scroll-pb-28 overflow-y-auto px-6 pt-[68px] pb-24"
      >
        {header}
        {placeholder}
        <div
          key={shown.epoch}
          ref={gridRef}
          hidden={placeholder !== null}
          className={`grid-enter grid ${gridColumnsClass} ${initialLoading ? "grid-pending" : ""}`}
        >
          {filteredItems.map((item, idx) => {
            const isCurrent = activeImagePath === item.path;
            const isFocused = focusedIndex === idx;
            const aspectClass =
              (item.orientation ?? shown.orientation) === "portrait"
                ? "aspect-[10/16]"
                : "aspect-[16/10]";

            return (
              <div
                key={item.path}
                ref={(node) => {
                  if (node) cardRefs.current.set(item.path, node);
                  else cardRefs.current.delete(item.path);
                }}
                role="button"
                tabIndex={0}
                data-path={item.path}
                data-focused={isFocused ? "true" : "false"}
                onPointerEnter={() => scheduleTilePrewarm(item, 55)}
                onPointerLeave={clearPrewarmTimer}
                onPointerDown={() => scheduleTilePrewarm(item, 0)}
                onFocus={() => {
                  setFocusedIndex(idx);
                  scheduleTilePrewarm(item, 40);
                }}
                onClick={() => onOpenLightbox(item, filteredItems)}
                className={`wallpaper-card group cursor-pointer ${aspectClass} ${
                  isMatte ? "bg-[#0f0f11]" : ""
                } ${
                  isCurrent ? "current" : ""
                }`}
              >
                <img
                  src={thumbUrl(item.path)}
                  alt={item.name}
                  loading="lazy"
                  decoding="async"
                  ref={(node) => {
                    if (node?.complete && node.naturalWidth > 0) node.style.opacity = "1";
                  }}
                  onLoad={(event) => {
                    event.currentTarget.style.visibility = "";
                    event.currentTarget.style.opacity = "1";
                  }}
                  onError={(event) => {
                    // Keep the neutral card instead of the browser's broken-image glyph.
                    event.currentTarget.style.visibility = "hidden";
                  }}
                  className={`wallpaper-thumbnail h-full w-full opacity-0 ${
                    isMatte
                      ? "object-contain p-3.5 drop-shadow-[0_12px_24px_rgb(0_0_0/0.75)]"
                      : "object-cover"
                  }`}
                />

                {/* Top Status Indicators */}
                <div className="pointer-events-none absolute top-2 right-2 left-2 flex items-center justify-between gap-1.5">
                  {isCurrent ? (
                    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-black/62 px-2.5 text-[11px] font-medium text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] backdrop-blur-md">
                      <span className="h-1.5 w-1.5 rounded-full bg-keep" />
                      {t("Active")}
                    </span>
                  ) : (
                    <span />
                  )}

                  {item.is_favorite && mode !== "favorites" && (
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-black/62 text-fav shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-md">
                      <Heart className="h-3 w-3 fill-current" />
                    </span>
                  )}
                </div>

                {/* Bottom Hover / Focus Contact-Sheet Action Bar */}
                <div className="card-actions absolute inset-x-0 bottom-0 flex items-end justify-between gap-1.5 bg-gradient-to-t from-black/75 via-black/28 to-transparent px-2 pt-10 pb-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetWallpaper(item);
                    }}
                    title={`${t("Set Wallpaper")} [Enter]`}
                    aria-label={t("Set Wallpaper")}
                    className="set-wallpaper-btn inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-white/92 text-[12px] font-medium text-black shadow-[0_2px_8px_rgb(0_0_0/0.4)] transition-colors hover:bg-white"
                  >
                    <MonitorUp className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="set-wallpaper-label truncate">{t("Set Wallpaper")}</span>
                  </button>

                  <div className="flex shrink-0 items-center rounded-full bg-black/58 p-0.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-md">
                    <button
                      type="button"
                      onClick={(e) => void handleCardFavorite(e, item)}
                      title={`${item.is_favorite ? t("Unfavorite") : t("Favorite")} [F]`}
                      className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-white/15 ${
                        item.is_favorite ? "text-fav" : "text-white/75 hover:text-white"
                      }`}
                    >
                      <Heart className={`h-3.5 w-3.5 ${item.is_favorite ? "fill-current" : ""}`} />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => handleCardRemove(e, item, "dislike")}
                      title={`${t("Dislike")} [D]`}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-white/75 transition-colors hover:bg-drop/30 hover:text-white"
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => handleCardRemove(e, item, "ban")}
                      title={`${t("Ban")} [X]`}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-white/75 transition-colors hover:bg-drop/30 hover:text-white"
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenWallhaven(item.name);
                      }}
                      title={`${t("Open on Wallhaven")} [O]`}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-white/75 transition-colors hover:bg-white/15 hover:text-white"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div ref={sentinelRef} className="flex h-12 items-center justify-center">
          {loadingMore && <Loader2 className="h-4 w-4 animate-spin text-ink-3" strokeWidth={1.75} />}
        </div>
      </div>
    );
  },
));

WallpaperGrid.displayName = "WallpaperGrid";
