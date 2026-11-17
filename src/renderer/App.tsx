import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigPayload,
  DiskUsageResponse,
  FilterStrategy,
  GalleryMode,
  ImageItem,
  LanguagePreference,
  MonitorInfo,
  Orientation,
  Purity,
  ReviewCandidateItem,
  SearchResponse,
  StatusResponse,
  UpdateCheckResponse,
} from "../shared/types";
import { createTranslator, normalizeLanguagePreference, resolveLocale } from "../shared/i18n";
import { normalizeTag, wallhavenUrl } from "../shared/tags";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CommandPalette } from "./components/CommandPalette";
import { NowDock } from "./components/NowDock";
import { NowStage } from "./components/NowStage";
import { preloadAmbient, useAmbient } from "./lib/ambient";
import { decodeImage } from "./lib/decoded-image";
import {
  loadGalleryPreferences,
  saveGalleryPreferences,
  type GalleryDensity,
  type GalleryPreferences,
} from "./lib/gallery-prefs";
import {
  getReadyLightboxPreview,
  prepareLightboxPreview,
} from "./lib/lightbox-preview";
import { basenameFromPath, previewUrl, thumbUrl } from "./lib/media";
import { motionCssVariables, motionTransition } from "./lib/motion";
import { TopBar, type TopBarHandle } from "./components/TopBar";
import { WallpaperGrid, type WallpaperGridHandle } from "./components/WallpaperGrid";
import {
  reviewScopeKey,
  ReviewWorkspace,
  type ReviewLane,
  type ReviewPrefetchSnapshot,
  type ReviewWorkspaceHandle,
} from "./components/ReviewWorkspace";
import {
  BlocklistWorkspace,
  type BlocklistWorkspaceHandle,
} from "./components/BlocklistWorkspace";
import { Lightbox, type LightboxSession } from "./components/Lightbox";
import type { SettingsTab } from "./components/SettingsView";
import { ToastHost, type ToastMessage, type ToastTone } from "./components/ToastHost";

const SettingsView = lazy(async () => {
  const mod = await import("./components/SettingsView");
  return { default: mod.SettingsView };
});

const PURITY_ORDER: Purity[] = ["sfw", "sketchy", "nsfw"];

/* Views are numbered in header order; the letters are the older bindings. */
const MODE_KEYS: Record<string, GalleryMode> = {
  "1": "pool",
  "2": "favorites",
  "3": "model-review",
  "4": "trash",
  p: "pool",
  v: "favorites",
  m: "model-review",
  b: "trash",
};

export const App: React.FC = () => {
  const reducedMotion = useReducedMotion();
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [diskUsage, setDiskUsage] = useState<DiskUsageResponse | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [activeMonitorName, setActiveMonitorName] = useState<string | null>(null);
  const [purities, setPuritiesState] = useState<Purity[]>(["sfw"]);
  // Backend responses carry a fresh array every time; keeping the previous
  // reference for equal content stops dependent effects from re-running.
  const setPurities = useCallback((next: Purity[]) => {
    setPuritiesState((prev) =>
      prev.length === next.length && prev.every((purity, index) => purity === next[index])
        ? prev
        : next,
    );
  }, []);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);

  const [view, setView] = useState<"workspace" | "settings">("workspace");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [mode, setMode] = useState<GalleryMode>("pool");
  const [reviewLane, setReviewLane] = useState<ReviewLane>("held");
  const [heldCount, setHeldCount] = useState<number>(0);
  const [recommendedCount, setRecommendedCount] = useState<number>(0);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewPrefetchSnapshot | null>(null);
  const [clearingAutoHeld, setClearingAutoHeld] = useState<boolean>(false);

  const [previewLang, setPreviewLang] = useState<LanguagePreference | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchMatches, setSearchMatches] = useState<Set<string> | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const [shakingPurity, setShakingPurity] = useState<Purity | null>(null);
  const [purityHint, setPurityHint] = useState<string | null>(null);


  const [lightbox, setLightbox] = useState<LightboxSession | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [galleryPrefs, setGalleryPrefs] = useState<GalleryPreferences>(() =>
    loadGalleryPreferences(),
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [refreshToken, setRefreshToken] = useState<number>(0);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<WallpaperGridHandle | null>(null);
  const reviewRef = useRef<ReviewWorkspaceHandle | null>(null);
  const blocklistRef = useRef<BlocklistWorkspaceHandle | null>(null);
  const topBarRef = useRef<TopBarHandle | null>(null);
  const searchSeqRef = useRef(0);
  const pendingGRef = useRef<number | null>(null);
  const purityHintTimerRef = useRef<number | null>(null);
  const toastSeqRef = useRef(0);
  const lightboxRequestRef = useRef(0);
  const pendingLightboxRef = useRef(false);
  const reviewPrefetchSeqRef = useRef(0);
  const bootCompletedRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(
    () => () => {
      if (pendingGRef.current !== null) window.clearTimeout(pendingGRef.current);
      if (purityHintTimerRef.current !== null) window.clearTimeout(purityHintTimerRef.current);
    },
    [],
  );

  const handleChangeGalleryPrefs = useCallback((next: GalleryPreferences) => {
    setGalleryPrefs(next);
    saveGalleryPreferences(next);
  }, []);

  const handleCycleDensity = useCallback(() => {
    setGalleryPrefs((prev) => {
      const order: GalleryDensity[] = ["compact", "standard", "gallery"];
      const nextDensity = order[(order.indexOf(prev.density) + 1) % order.length];
      const next = { ...prev, density: nextDensity };
      saveGalleryPreferences(next);
      return next;
    });
  }, []);

  const handleToggleFraming = useCallback(() => {
    setGalleryPrefs((prev) => {
      const next: GalleryPreferences = {
        ...prev,
        framing: prev.framing === "matte" ? "fill" : "matte",
      };
      saveGalleryPreferences(next);
      return next;
    });
  }, []);

  const effectiveLangPref = previewLang ?? normalizeLanguagePreference(config?.language ?? "auto");
  const locale = useMemo(() => resolveLocale(effectiveLangPref), [effectiveLangPref]);
  const t = useMemo(() => createTranslator(locale), [locale]);

  const notify = useCallback((text: string, tone: ToastTone = "info") => {
    const id = ++toastSeqRef.current;
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3400);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const closeLightbox = useCallback(() => {
    pendingLightboxRef.current = false;
    lightboxRequestRef.current += 1;
    setLightbox(null);
  }, []);

  const openLightboxSession = useCallback((nextSession: LightboxSession) => {
    const currentItem = nextSession.items[nextSession.index];
    if (!currentItem) return;
    const requestId = ++lightboxRequestRef.current;
    if (getReadyLightboxPreview(currentItem, nextSession.context)) {
      pendingLightboxRef.current = false;
      setLightbox(nextSession);
      return;
    }
    pendingLightboxRef.current = true;
    void prepareLightboxPreview(currentItem, nextSession.context).then(() => {
      if (lightboxRequestRef.current !== requestId) return;
      pendingLightboxRef.current = false;
      setLightbox(nextSession);
    });
  }, []);

  useEffect(() => {
    pendingLightboxRef.current = false;
    lightboxRequestRef.current += 1;
  }, [mode, view]);

  const activeMonitor = useMemo(() => {
    if (monitors.length === 0) return null;
    return monitors.find((m) => m.name === activeMonitorName) ?? monitors[0];
  }, [monitors, activeMonitorName]);

  const activeOrientation: Orientation = activeMonitor?.orientation ?? "landscape";

  const refreshStatusAndCounts = useCallback(
    async (orientOverride?: Orientation, monitorOverride?: string | null) => {
      const orient = orientOverride ?? activeOrientation;
      const mon = monitorOverride !== undefined ? monitorOverride : activeMonitor?.name;
      try {
        const [st, du] = await Promise.all([
          window.wayper.getStatus({
            orient,
            include_recoverable: true,
            monitor: mon ?? undefined,
          }),
          window.wayper.getDiskUsage(),
        ]);
        setStatus(st);
        setDiskUsage(du);
        if (st.mode?.length) {
          setPurities(st.mode);
        }
      } catch (err) {
        console.error("Failed refreshing status:", err);
      }
    },
    [activeOrientation, activeMonitor?.name],
  );

  const refreshReviewCountsBackground = useCallback(
    async (puritiesArg: Purity[], orientArg: Orientation) => {
      const seq = ++reviewPrefetchSeqRef.current;
      const scopeKey = reviewScopeKey(puritiesArg, orientArg);
      const prewarmTopCandidate = (item: ReviewCandidateItem | undefined) => {
        if (!item || modeRef.current === "model-review") return;
        window.setTimeout(() => {
          if (reviewPrefetchSeqRef.current !== seq) return;
          void decodeImage(previewUrl(item.path));
          void preloadAmbient(thumbUrl(item.path));
        }, 60);
      };

      const heldPromise = window.wayper
        .getModelReview({ purities: puritiesArg, orient: orientArg, limit: 80 })
        .then((heldRes) => {
          if (reviewPrefetchSeqRef.current !== seq) return null;
          setHeldCount(heldRes.items?.length ?? heldRes.pending_count ?? 0);
          setReviewSnapshot((prev) => ({
            scopeKey,
            held: heldRes,
            recommended: prev?.scopeKey === scopeKey ? prev.recommended : null,
          }));
          if (heldRes.items?.[0]) {
            prewarmTopCandidate(heldRes.items[0]);
          }
          return heldRes;
        })
        .catch(() => null);

      const recPromise = window.wayper
        .getPreferenceSuggestions({
          purities: puritiesArg,
          orient: orientArg,
          limit: 60,
        })
        .then(async (recRes) => {
          if (reviewPrefetchSeqRef.current !== seq) return;
          setRecommendedCount(recRes.items?.length ?? 0);
          setReviewSnapshot((prev) => ({
            scopeKey,
            held: prev?.scopeKey === scopeKey ? prev.held : null,
            recommended: recRes,
          }));
          const heldRes = await heldPromise;
          if (reviewPrefetchSeqRef.current !== seq) return;
          if ((heldRes?.items?.length ?? 0) === 0 && recRes.items?.[0]) {
            prewarmTopCandidate(recRes.items[0]);
          }
        })
        .catch(() => undefined);

      await Promise.all([heldPromise, recPromise]);
    },
    [],
  );

  const refreshMonitors = useCallback(async () => {
    try {
      const list = await window.wayper.getMonitors();
      setMonitors(list ?? []);
      setActiveMonitorName((prev) => {
        if (prev && list.some((m) => m.name === prev)) return prev;
        return list[0]?.name ?? null;
      });
      return list ?? [];
    } catch (err) {
      console.error("Failed fetching monitors:", err);
      return [];
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await window.wayper.getConfig();
      setConfig(cfg);
      if (cfg.mode?.length) {
        setPurities(cfg.mode);
      }
      return cfg;
    } catch (err) {
      console.error("Failed fetching config:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    const boot = async () => {
      const [cfg, mons] = await Promise.all([refreshConfig(), refreshMonitors()]);
      const firstMon = mons[0] ?? null;
      const orient = firstMon?.orientation ?? "landscape";
      const activePurities = cfg?.mode?.length ? cfg.mode : (["sfw"] as Purity[]);
      await Promise.all([
        refreshStatusAndCounts(orient, firstMon?.name ?? null),
        refreshReviewCountsBackground(activePurities, orient),
        window.wayper
          .checkUpdate(false)
          .then((u) => setUpdateInfo(u))
          .catch(() => null),
      ]);
      bootCompletedRef.current = true;
    };
    void boot();
  }, [refreshConfig, refreshMonitors, refreshStatusAndCounts, refreshReviewCountsBackground]);

  useEffect(() => {
    if (!config || !bootCompletedRef.current) return;
    void refreshStatusAndCounts(activeOrientation, activeMonitor?.name ?? null);
    if (modeRef.current !== "model-review") {
      void refreshReviewCountsBackground(purities, activeOrientation);
    }
  }, [
    activeOrientation,
    activeMonitor?.name,
    purities,
    config,
    refreshStatusAndCounts,
    refreshReviewCountsBackground,
  ]);

  useEffect(() => {
    const unsubscribe = window.wayper.onEvent((event) => {
      switch (event.type) {
        case "mode":
          setPurities(event.purities);
          setRefreshToken((n) => n + 1);
          break;
        case "library":
          void refreshStatusAndCounts();
          if (modeRef.current !== "model-review") {
            void refreshReviewCountsBackground(purities, activeOrientation);
          }
          setRefreshToken((n) => n + 1);
          break;
        case "wallpaper":
          void refreshMonitors();
          void refreshStatusAndCounts();
          break;
        case "monitors":
          void refreshMonitors();
          break;
        case "config":
          void refreshConfig();
          void refreshStatusAndCounts();
          break;
        case "rotation":
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  auto_rotation: event.auto_rotation,
                  rotation_paused: event.rotation_paused,
                }
              : prev,
          );
          break;
        case "model-updated":
          void refreshStatusAndCounts();
          if (modeRef.current !== "model-review") {
            void refreshReviewCountsBackground(purities, activeOrientation);
          }
          setRefreshToken((n) => n + 1);
          break;
      }
    });
    return unsubscribe;
  }, [
    purities,
    activeOrientation,
    refreshConfig,
    refreshMonitors,
    refreshStatusAndCounts,
    refreshReviewCountsBackground,
  ]);

  const triggerPurityRejection = useCallback((purity: Purity, hintText: string | null) => {
    setShakingPurity(null);
    window.requestAnimationFrame(() => {
      setShakingPurity(purity);
    });
    if (hintText) {
      setPurityHint(hintText);
    }
    if (purityHintTimerRef.current !== null) {
      window.clearTimeout(purityHintTimerRef.current);
    }
    purityHintTimerRef.current = window.setTimeout(() => {
      setShakingPurity(null);
      setPurityHint(null);
    }, 2000);
  }, []);

  const handleTogglePurity = useCallback(
    async (target: Purity) => {
      const currentlyActive = purities.includes(target);
      if (!currentlyActive) {
        if (config?.safe_mode && (target === "sketchy" || target === "nsfw")) {
          triggerPurityRejection(target, t("Safe mode is enabled"));
          return;
        }
        if (!config?.has_api_key && target === "nsfw") {
          triggerPurityRejection(target, t("API key required for NSFW"));
          return;
        }
      } else if (purities.length <= 1) {
        triggerPurityRejection(target, null);
        return;
      }

      const nextSet = new Set(purities);
      if (currentlyActive) nextSet.delete(target);
      else nextSet.add(target);
      const nextOrdered = PURITY_ORDER.filter((p) => nextSet.has(p));
      if (nextOrdered.length === 0) return;

      setPurities(nextOrdered);
      try {
        const res = await window.wayper.setMode(nextOrdered);
        if (res.purities?.length) setPurities(res.purities);
        setRefreshToken((n) => n + 1);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not change purity", "error");
      }
    },
    [purities, config, triggerPurityRejection, t, notify],
  );

  const handleChangeFilterStrategy = useCallback(
    async (strategy: FilterStrategy) => {
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              wallhaven: { ...prev.wallhaven, filter_strategy: strategy, filter_mode: strategy },
            }
          : prev,
      );
      try {
        await window.wayper.patchConfig({
          wallhaven: { filter_strategy: strategy, filter_mode: strategy },
        });
        await refreshConfig();
        await refreshStatusAndCounts();
      } catch (err) {
        notify(err instanceof Error ? err.message : "Failed updating filter strategy", "error");
      }
    },
    [refreshConfig, refreshStatusAndCounts, notify],
  );

  const handleSelectMonitor = useCallback((monitorName: string) => {
    setActiveMonitorName(monitorName);
  }, []);

  const handleCommitSearch = useCallback(
    async (rawQuery: string): Promise<SearchResponse | null> => {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        searchSeqRef.current += 1;
        setSearchQuery("");
        setSearchMatches(null);
        setMatchCount(null);
        setIsSearching(false);
        return null;
      }

      setSearchQuery(trimmed);
      if (view === "settings") setView("workspace");

      if (mode === "trash") {
        blocklistRef.current?.openDrilldownForSearch(trimmed);
        return null;
      }
      if (mode === "model-review") {
        setMode("pool");
      }

      const seq = ++searchSeqRef.current;
      setIsSearching(true);
      try {
        const res = trimmed.startsWith("@")
          ? await window.wayper.searchImages({ uploader: trimmed.slice(1).trim() })
          : trimmed.includes("+")
            ? await window.wayper.searchImages({
                tags: trimmed
                  .split("+")
                  .map((s) => normalizeTag(s))
                  .filter(Boolean),
              })
            : await window.wayper.searchImages({ query: trimmed });
        if (seq !== searchSeqRef.current) return null;
        setSearchMatches(new Set(res.matches ?? []));
        return res;
      } catch (err) {
        console.error("Search failed:", err);
        return null;
      } finally {
        if (seq === searchSeqRef.current) setIsSearching(false);
      }
    },
    [view, mode],
  );

  const handleSelectUploaderFilter = useCallback(
    async (uploaderRaw: string) => {
      const clean = uploaderRaw.replace(/^@/, "").trim();
      if (!clean) return;
      const display = `@${clean}`;
      setSearchQuery(display);
      if (view === "settings") setView("workspace");
      if (mode === "trash") {
        blocklistRef.current?.openDrilldownForSearch(display);
        return;
      }
      if (mode === "model-review") {
        setMode("pool");
      }
      const seq = ++searchSeqRef.current;
      setIsSearching(true);
      try {
        const res = await window.wayper.searchImages({ uploader: clean });
        if (seq !== searchSeqRef.current) return;
        setSearchMatches(new Set(res.matches ?? []));
      } finally {
        if (seq === searchSeqRef.current) setIsSearching(false);
      }
    },
    [view, mode],
  );

  const handleSelectTagFilter = useCallback(
    async (tagRaw: string) => {
      const norm = normalizeTag(tagRaw);
      if (!norm) return;
      setSearchQuery(norm);
      if (view === "settings") setView("workspace");
      if (mode === "trash") {
        blocklistRef.current?.openDrilldownForSearch(norm);
        return;
      }
      if (mode === "model-review") {
        setMode("pool");
      }
      const seq = ++searchSeqRef.current;
      setIsSearching(true);
      try {
        const res = await window.wayper.searchImages({ tags: [norm] });
        if (seq !== searchSeqRef.current) return;
        setSearchMatches(new Set(res.matches ?? []));
      } finally {
        if (seq === searchSeqRef.current) setIsSearching(false);
      }
    },
    [view, mode],
  );

  const handleClearSearch = useCallback(() => {
    searchSeqRef.current += 1;
    setSearchQuery("");
    setSearchMatches(null);
    setMatchCount(null);
    setIsSearching(false);
    blocklistRef.current?.clearDrilldown();
  }, []);

  const handleControl = useCallback(
    async (action: "next" | "prev" | "fav" | "unfav" | "ban" | "dislike" | "unban") => {
      try {
        await window.wayper.controlAction(action, {
          monitor_name: activeMonitor?.name ?? null,
        });
        await Promise.all([refreshMonitors(), refreshStatusAndCounts()]);
        if (action !== "next" && action !== "prev") {
          setRefreshToken((n) => n + 1);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : `Action ${action} failed`, "error");
      }
    },
    [activeMonitor?.name, refreshMonitors, refreshStatusAndCounts, notify],
  );

  const handleSetWallpaper = useCallback(
    async (imagePath: string) => {
      const targetMon = activeMonitor?.name ?? monitors[0]?.name ?? "";
      try {
        await window.wayper.setWallpaper(targetMon, imagePath);
        await Promise.all([refreshMonitors(), refreshStatusAndCounts()]);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Failed setting wallpaper", "error");
      }
    },
    [activeMonitor?.name, monitors, refreshMonitors, refreshStatusAndCounts, notify],
  );

  const handleSetGreeter = useCallback(
    async (imagePath: string) => {
      try {
        await window.wayper.setGreeter(imagePath);
        await refreshConfig();
        notify(t("Set Greeter"), "success");
      } catch (err) {
        notify(err instanceof Error ? err.message : "Failed setting greeter", "error");
      }
    },
    [refreshConfig, notify, t],
  );

  const handleToggleFavorite = useCallback(
    async (imagePath: string): Promise<{ new_path: string; is_favorite: boolean } | null> => {
      try {
        const res = await window.wayper.toggleFavorite(imagePath);
        setLightbox((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            items: prev.items.map((entry) =>
              entry.path === imagePath
                ? { ...entry, path: res.new_path, is_favorite: res.is_favorite }
                : entry,
            ),
          };
        });
        await refreshStatusAndCounts();
        return { new_path: res.new_path, is_favorite: res.is_favorite };
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not toggle favorite", "error");
        return null;
      }
    },
    [refreshStatusAndCounts, notify],
  );

  const handleDislikePath = useCallback(
    async (imagePath: string): Promise<boolean> => {
      try {
        await window.wayper.dislikeImage(imagePath, {
          monitor: activeMonitor?.name ?? undefined,
        });
        await Promise.all([refreshMonitors(), refreshStatusAndCounts()]);
        return true;
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not dislike wallpaper", "error");
        return false;
      }
    },
    [activeMonitor?.name, refreshMonitors, refreshStatusAndCounts, notify],
  );

  const handleBanPath = useCallback(
    async (imagePath: string): Promise<boolean> => {
      try {
        await window.wayper.banImage(imagePath, {
          monitor: activeMonitor?.name ?? undefined,
        });
        await Promise.all([refreshMonitors(), refreshStatusAndCounts()]);
        return true;
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not ban wallpaper", "error");
        return false;
      }
    },
    [activeMonitor?.name, refreshMonitors, refreshStatusAndCounts, notify],
  );

  const handleLocateCurrent = useCallback(async () => {
    if (view !== "workspace" || (mode !== "pool" && mode !== "favorites")) {
      setView("workspace");
      setMode("pool");
      window.setTimeout(() => {
        void gridRef.current?.locateCurrent();
      }, 120);
      return;
    }
    const found = await gridRef.current?.locateCurrent();
    if (!found && mode === "favorites") {
      setMode("pool");
      window.setTimeout(() => {
        void gridRef.current?.locateCurrent();
      }, 120);
    }
  }, [view, mode]);

  const handleClearAutoHeld = useCallback(async () => {
    if (clearingAutoHeld || heldCount <= 0) return;
    setClearingAutoHeld(true);
    try {
      await window.wayper.clearModelReview({
        purities,
        orientation: activeOrientation,
      });
      setHeldCount(0);
      await reviewRef.current?.refresh();
      await refreshStatusAndCounts();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed clearing auto-held queue", "error");
    } finally {
      setClearingAutoHeld(false);
    }
  }, [clearingAutoHeld, heldCount, purities, activeOrientation, refreshStatusAndCounts, notify]);

  const handleRotationButton = useCallback(async () => {
    const isPaused = Boolean(status?.rotation_paused);
    if ((config?.interval_min ?? 5) <= 0 || (!status?.auto_rotation && !isPaused)) {
      setSettingsTab("general");
      setPreviewLang(null);
      setView("settings");
      return;
    }
    try {
      const nextAction = isPaused ? "resume" : "pause";
      const res = await window.wayper.setRotation(nextAction);
      setStatus((prev) =>
        prev
          ? { ...prev, auto_rotation: res.auto_rotation, rotation_paused: res.rotation_paused }
          : prev,
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not toggle auto-rotation", "error");
    }
  }, [status, config, notify]);

  const closeSettingsRevertingPreview = useCallback(() => {
    setPreviewLang(null);
    setView("workspace");
  }, []);

  const handleOpenWallhaven = useCallback((filenameOrPath: string) => {
    void window.wayper.openExternal(wallhavenUrl(filenameOrPath));
  }, []);

  const handleCopyColor = useCallback(
    (hex: string) => {
      window.wayper.copyToClipboard(hex);
      notify(`${t("Copied")} ${hex}`, "info");
    },
    [notify, t],
  );

  const handleInspectStageImage = useCallback(
    (imagePath: string) => {
      openLightboxSession({
        context: "library",
        index: 0,
        items: [
          {
            path: imagePath,
            name: basenameFromPath(imagePath),
            is_favorite: imagePath.startsWith("favorites/"),
            orientation: activeOrientation,
          },
        ],
      });
    },
    [openLightboxSession, activeOrientation],
  );

  const handleRetrainFromPalette = useCallback(async () => {
    try {
      await window.wayper.retrainModelNow();
      await Promise.all([
        refreshStatusAndCounts(),
        refreshReviewCountsBackground(purities, activeOrientation),
      ]);
      setRefreshToken((n) => n + 1);
      notify(t("Model Ready"), "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Retrain failed", "error");
    }
  }, [purities, activeOrientation, refreshStatusAndCounts, refreshReviewCountsBackground, notify, t]);

  const handleLightboxReviewDecision = useCallback(
    async (item: ReviewCandidateItem, lane: ReviewLane, action: "keep" | "ban") => {
      try {
        const isHeld = Boolean(item.auto_filtered) || lane === "held";
        if (isHeld) {
          await window.wayper.resolveModelReview(item.path, action);
        } else if (action === "keep") {
          await window.wayper.sendPreferenceFeedback(item.path, "keep");
        } else {
          await window.wayper.banImage(item.path, {
            monitor: activeMonitor?.name ?? undefined,
            preference_context: "model_review",
          });
        }

        setLightbox((prev) => {
          if (!prev) return null;
          const remaining = prev.items.filter((x) => x.path !== item.path);
          if (remaining.length === 0) return null;
          return {
            ...prev,
            items: remaining,
            index: Math.min(prev.index, remaining.length - 1),
          };
        });
        void reviewRef.current?.refresh();
      } catch (err) {
        notify(err instanceof Error ? err.message : "Review decision failed", "error");
      }
    },
    [activeMonitor?.name, notify],
  );

  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3) return;
      if (lightbox) {
        e.preventDefault();
        closeLightbox();
        return;
      }
      if (view === "workspace" && mode === "trash" && blocklistRef.current?.hasDrilldown()) {
        e.preventDefault();
        blocklistRef.current.popDrilldown();
        return;
      }
      if (searchQuery || searchMatches) {
        e.preventDefault();
        handleClearSearch();
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [lightbox, view, mode, searchQuery, searchMatches, handleClearSearch, closeLightbox]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (lightbox) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (commandPaletteOpen) return;
      if (pendingLightboxRef.current && e.key === "Escape") {
        e.preventDefault();
        pendingLightboxRef.current = false;
        lightboxRequestRef.current += 1;
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        if (target.tagName === "INPUT") return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (view === "settings") {
        if (e.key === "Escape" || e.key === "s" || e.key === "S") {
          e.preventDefault();
          closeSettingsRevertingPreview();
        }
        return;
      }

      if (e.key === "F1") {
        e.preventDefault();
        void handleTogglePurity("sfw");
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        void handleTogglePurity("sketchy");
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        void handleTogglePurity("nsfw");
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        topBarRef.current?.toggleViewOptions();
        return;
      }

      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit && e.shiftKey) {
        const mon = monitors[Number(digit) - 1];
        if (mon) {
          e.preventDefault();
          handleSelectMonitor(mon.name);
        }
        return;
      }

      const nextMode = e.shiftKey ? undefined : MODE_KEYS[e.key.toLowerCase()];
      if (nextMode) {
        e.preventDefault();
        setMode(nextMode);
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        setPreviewLang(null);
        setView("settings");
        return;
      }

      if (mode === "model-review") {
        const onBtn = Boolean(target?.closest("button"));
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          reviewRef.current?.moveSelection(-1);
          return;
        }
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          reviewRef.current?.moveSelection(1);
          return;
        }
        if ((e.key === "Enter" || e.key === " ") && !onBtn) {
          e.preventDefault();
          reviewRef.current?.openCurrentInLightbox();
          return;
        }
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          void reviewRef.current?.decideCurrent("keep");
          return;
        }
        if (e.key === "d" || e.key === "D") {
          e.preventDefault();
          void reviewRef.current?.decideCurrent("ban");
          return;
        }
        if (e.key === "o" || e.key === "O") {
          const cur = reviewRef.current?.getCurrentItem();
          if (cur) {
            e.preventDefault();
            handleOpenWallhaven(cur.name);
          }
          return;
        }
        if (
          ["x", "X", "Delete", "/", "h", "H", "l", "L", "f", "F", "u", "U", "g", "G"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          return;
        }
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (mode === "trash") {
        if (e.key === "[") {
          e.preventDefault();
          blocklistRef.current?.cycleTab(-1);
          return;
        }
        if (e.key === "]") {
          e.preventDefault();
          blocklistRef.current?.cycleTab(1);
          return;
        }
        if (e.key === "Escape") {
          if (blocklistRef.current?.popDrilldown()) {
            e.preventDefault();
            return;
          }
        }
      }

      if (e.key === "Escape") {
        if (searchQuery || searchMatches) {
          e.preventDefault();
          handleClearSearch();
        } else {
          gridRef.current?.clearFocus();
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        }
        return;
      }

      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        void handleControl("next");
        return;
      }
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        void handleControl("prev");
        return;
      }
      if (e.key === "u" || e.key === "U") {
        e.preventDefault();
        void handleControl("unban");
        return;
      }

      if (mode === "pool" || mode === "favorites") {
        if (
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight"
        ) {
          e.preventDefault();
          gridRef.current?.navigateByKey(e.key);
          return;
        }

        if (e.key === "g") {
          e.preventDefault();
          if (pendingGRef.current !== null) {
            window.clearTimeout(pendingGRef.current);
            pendingGRef.current = null;
            gridRef.current?.jumpToTop();
          } else {
            pendingGRef.current = window.setTimeout(() => {
              pendingGRef.current = null;
              void handleLocateCurrent();
            }, 280);
          }
          return;
        }

        if (e.key === "G") {
          e.preventDefault();
          if (pendingGRef.current !== null) {
            window.clearTimeout(pendingGRef.current);
            pendingGRef.current = null;
          }
          gridRef.current?.jumpToBottom();
          return;
        }

        const focusedCardItem = gridRef.current?.getFocusedItem() ?? null;

        if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          if (focusedCardItem) {
            void handleToggleFavorite(focusedCardItem.path).then(() => {
              setRefreshToken((n) => n + 1);
            });
          } else {
            void handleControl("fav");
          }
          return;
        }

        if (e.key === "d" || e.key === "D") {
          e.preventDefault();
          if (!gridRef.current?.removeFocused("dislike")) void handleControl("dislike");
          return;
        }

        if (e.key === "x" || e.key === "X" || e.key === "Delete") {
          e.preventDefault();
          if (!gridRef.current?.removeFocused("ban")) void handleControl("ban");
          return;
        }

        if (e.key === "o" || e.key === "O") {
          if (focusedCardItem) {
            e.preventDefault();
            handleOpenWallhaven(focusedCardItem.name);
          }
          return;
        }

        if (e.key === " " && !target?.closest("button")) {
          e.preventDefault();
          if (!gridRef.current?.openFocusedInLightbox()) {
            void handleControl("next");
          }
          return;
        }

        if (e.key === "Enter" && !target?.closest("button")) {
          e.preventDefault();
          if (focusedCardItem) {
            void handleSetWallpaper(focusedCardItem.path);
          } else {
            void handleControl("next");
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    lightbox,
    commandPaletteOpen,
    view,
    mode,
    monitors,
    searchQuery,
    searchMatches,
    closeSettingsRevertingPreview,
    handleTogglePurity,
    handleSelectMonitor,
    handleClearSearch,
    handleControl,
    handleLocateCurrent,
    handleToggleFavorite,
    handleDislikePath,
    handleBanPath,
    handleOpenWallhaven,
    handleSetWallpaper,
  ]);

  const handleOpenLibraryLightbox = useCallback((item: ImageItem, items: ImageItem[]) => {
    openLightboxSession({
      context: "library",
      index: Math.max(0, items.findIndex((entry) => entry.path === item.path)),
      items,
    });
  }, [openLightboxSession]);
  const handleSetGridWallpaper = useCallback((item: ImageItem) => {
    void handleSetWallpaper(item.path);
  }, [handleSetWallpaper]);
  const handleToggleGridFavorite = useCallback((item: ImageItem) => {
    return handleToggleFavorite(item.path);
  }, [handleToggleFavorite]);
  const handleToggleLightboxFavorite = useCallback(
    async (imagePath: string) => {
      const toggled = await handleToggleFavorite(imagePath);
      if (toggled) {
        setRefreshToken((count) => count + 1);
      }
      return toggled;
    },
    [handleToggleFavorite],
  );
  const handleDislikeGridImage = useCallback((item: ImageItem) => {
    return handleDislikePath(item.path);
  }, [handleDislikePath]);
  const handleBanGridImage = useCallback((item: ImageItem) => {
    return handleBanPath(item.path);
  }, [handleBanPath]);

  const filterStrategy: FilterStrategy = config?.wallhaven?.filter_strategy ?? "rules";
  const viewKey = mode === "model-review" ? "review" : mode === "trash" ? "blocklist" : "library";
  const openUpdate = () => {
    if (updateInfo?.release_url) {
      void window.wayper.openExternal(updateInfo.release_url);
    }
  };

  const hasSearch = Boolean(searchQuery || searchMatches);
  const stageVisible =
    (mode === "pool" || mode === "favorites") && monitors.length > 0 && !hasSearch;
  // Review lights the window from its own candidate.
  const ambient = useAmbient(
    mode !== "model-review" && activeMonitor?.current_image
      ? thumbUrl(activeMonitor.current_image)
      : null,
  );
  const stageHeader = useMemo(() => stageVisible ? (
    <NowStage
      t={t}
      monitors={monitors}
      activeMonitorName={activeMonitor?.name ?? null}
      onSelectMonitor={handleSelectMonitor}
      status={status}
      config={config}
      onRotationAction={() => void handleRotationButton()}
      onPrev={() => void handleControl("prev")}
      onNext={() => void handleControl("next")}
      onLocate={() => void handleLocateCurrent()}
      onUndo={() => void handleControl("unban")}
      onFavorite={(favorite) => void handleControl(favorite ? "fav" : "unfav")}
      onDislike={() => void handleControl("dislike")}
      onInspectCurrent={handleInspectStageImage}
      onSelectTag={(tg) => void handleSelectTagFilter(tg)}
      onSelectUploader={(u) => void handleSelectUploaderFilter(u)}
      onOpenWallhaven={handleOpenWallhaven}
      onCopyColor={handleCopyColor}
    />
  ) : null, [
    stageVisible, t, monitors, activeMonitor?.name, handleSelectMonitor, status, config,
    handleRotationButton, handleControl, handleLocateCurrent,
    handleInspectStageImage, handleSelectTagFilter, handleSelectUploaderFilter,
    handleOpenWallhaven, handleCopyColor,
  ]);

  return (
    <div style={motionCssVariables} className="page-scroll-scope relative h-screen w-screen overflow-hidden bg-frame text-ink">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <AnimatePresence initial={false}>
          {ambient && (
            <motion.img
              key={ambient.source}
              src={ambient.url}
              alt=""
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={motionTransition.ambient}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
        </AnimatePresence>
        <div className="ambient-shade absolute inset-0" />
      </div>

      <TopBar
        ref={topBarRef}
        t={t}
        view={view}
        immersive={mode === "model-review"}
        overlayOpen={view === "settings" || commandPaletteOpen || Boolean(lightbox)}
        mode={mode}
        onSelectMode={(nextMode) => {
          if (view === "settings") closeSettingsRevertingPreview();
          setMode(nextMode);
        }}
        onToggleSettings={() => {
          if (view === "settings") {
            closeSettingsRevertingPreview();
          } else {
            setPreviewLang(null);
            setView("settings");
          }
        }}
        status={status}
        heldCount={heldCount}
        recommendedCount={recommendedCount}
        filterStrategy={filterStrategy}
        onChangeFilterStrategy={(s) => void handleChangeFilterStrategy(s)}
        purities={purities}
        shakingPurity={shakingPurity}
        purityHint={purityHint}
        onTogglePurity={(p) => void handleTogglePurity(p)}
        config={config}
        diskUsage={diskUsage}
        updateInfo={updateInfo}
        onOpenUpdate={openUpdate}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        activeFilterLabel={searchMatches ? searchQuery : null}
        matchCount={matchCount}
        isSearching={isSearching}
        onCommitSearch={handleCommitSearch}
        onSelectUploader={(u) => void handleSelectUploaderFilter(u)}
        onSelectTag={(tg) => void handleSelectTagFilter(tg)}
        onClearSearch={handleClearSearch}
        galleryPrefs={galleryPrefs}
        onChangeGalleryPrefs={handleChangeGalleryPrefs}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      />

      <main
        key={viewKey}
        className="workspace-enter absolute inset-0 flex flex-col overflow-hidden"
      >
            {mode === "model-review" ? (
              <ReviewWorkspace
                ref={reviewRef}
                t={t}
                clearingAutoHeld={clearingAutoHeld}
                onClearAutoHeld={() => void handleClearAutoHeld()}
                purities={purities}
                orientation={activeOrientation}
                monitors={monitors}
                activeMonitorName={activeMonitor?.name ?? null}
                onSelectMonitor={handleSelectMonitor}
                lane={reviewLane}
                onLaneChange={setReviewLane}
                refreshToken={refreshToken}
                initialSnapshot={reviewSnapshot}
                onSnapshotChange={setReviewSnapshot}
                onCountsChange={(held, rec) => {
                  setHeldCount(held);
                  setRecommendedCount(rec);
                }}
                onOpenReviewLightbox={(item, items, lane) => {
                  const idx = Math.max(
                    0,
                    items.findIndex((x) => x.path === item.path),
                  );
                  openLightboxSession({
                    context: "review",
                    index: idx,
                    items,
                    reviewLane: lane,
                  });
                }}
                onBrowsePool={() => setMode("pool")}
                onOpenWallhaven={handleOpenWallhaven}
                onSelectTag={(tg) => void handleSelectTagFilter(tg)}
                onSelectUploader={(u) => void handleSelectUploaderFilter(u)}
                onNotify={notify}
              />
            ) : mode === "trash" ? (
              <BlocklistWorkspace
                ref={blocklistRef}
                t={t}
                locale={locale}
                config={config}
                purities={purities}
                orientation={activeOrientation}
                density={galleryPrefs.density}
                framing={galleryPrefs.framing}
                refreshToken={refreshToken}
                onRefreshConfigAndStatus={async () => {
                  await Promise.all([refreshConfig(), refreshStatusAndCounts()]);
                }}
                onManageRules={() => {
                  setSettingsTab("filters");
                  setPreviewLang(null);
                  setView("settings");
                }}
                onOpenTrashLightbox={(item, list) => {
                  const idx = Math.max(
                    0,
                    list.findIndex((x) => x.name === item.name),
                  );
                  openLightboxSession({
                    context: "trash",
                    index: idx,
                    items: list,
                  });
                }}
                onOpenLibraryLightbox={handleOpenLibraryLightbox}
                onOpenWallhaven={handleOpenWallhaven}
                onNotify={notify}
              />
            ) : (
              <WallpaperGrid
                ref={gridRef}
                t={t}
                mode={mode === "favorites" ? "favorites" : "pool"}
                purities={purities}
                orientation={activeOrientation}
                density={galleryPrefs.density}
                framing={galleryPrefs.framing}
                activeImagePath={activeMonitor?.current_image ?? null}
                searchQuery={searchQuery}
                searchMatches={searchMatches}
                refreshToken={refreshToken}
                header={stageHeader}
                onFilteredCountChange={setMatchCount}
                onOpenLightbox={handleOpenLibraryLightbox}
                onSetWallpaper={handleSetGridWallpaper}
                onToggleFavorite={handleToggleGridFavorite}
                onDislike={handleDislikeGridImage}
                onBan={handleBanGridImage}
                onOpenWallhaven={handleOpenWallhaven}
                onClearFilter={handleClearSearch}
              />
            )}
      </main>

      <AnimatePresence initial={false}>
        {mode !== "model-review" && (
          <motion.div
            key="now-dock"
            initial={{ opacity: 0, transform: reducedMotion ? "none" : "translate3d(0, 12px, 0)" }}
            animate={{ opacity: 1, transform: "translate3d(0, 0, 0)" }}
            exit={{ opacity: 0, transform: reducedMotion ? "none" : "translate3d(0, 8px, 0)" }}
            transition={motionTransition.normal}
            className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4"
          >
            <div className={`pointer-events-auto ${stageVisible ? "dock-after-stage" : ""}`}>
              <NowDock
                t={t}
                monitors={monitors}
                activeMonitorName={activeMonitor?.name ?? null}
                onSelectMonitor={handleSelectMonitor}
                status={status}
                config={config}
                onRotationAction={() => void handleRotationButton()}
                onPrev={() => void handleControl("prev")}
                onNext={() => void handleControl("next")}
                onLocate={() => void handleLocateCurrent()}
                onUndo={() => void handleControl("unban")}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {view === "settings" && config && (
          <motion.div
            key="settings-sheet"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionTransition.fast}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeSettingsRevertingPreview();
            }}
            className="sheet-scrim absolute inset-0 z-40 flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ opacity: 0, transform: reducedMotion ? "none" : "translate3d(0, 12px, 0) scale(0.98)" }}
              animate={{ opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }}
              exit={{ opacity: 0, transform: reducedMotion ? "none" : "translate3d(0, 8px, 0) scale(0.99)" }}
              transition={motionTransition.normal}
              role="dialog"
              aria-modal="true"
              aria-label={t("Settings")}
              className="sheet-surface flex h-[min(680px,100%)] w-[min(880px,100%)] overflow-hidden rounded-[22px]"
            >
              <Suspense fallback={<div className="flex-1" />}>
                <SettingsView
                  t={t}
                  locale={locale}
                  config={config}
                  initialTab={settingsTab}
                  onPreviewLanguage={(pref) => setPreviewLang(pref)}
                  onCancel={closeSettingsRevertingPreview}
                  onSaved={async () => {
                    setPreviewLang(null);
                    await Promise.all([refreshConfig(), refreshStatusAndCounts()]);
                    setRefreshToken((n) => n + 1);
                    setView("workspace");
                  }}
                  onNotify={notify}
                />
              </Suspense>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <Lightbox
        t={t}
        session={lightbox}
        config={config}
        onClose={closeLightbox}
        onChangeIndex={(nextIdx) =>
          setLightbox((prev) => (prev ? { ...prev, index: nextIdx } : null))
        }
        onSetWallpaper={handleSetWallpaper}
        onSetGreeter={handleSetGreeter}
        onToggleFavorite={handleToggleLightboxFavorite}
        onDislikeLibrary={async (p) => {
          const ok = await handleDislikePath(p);
          if (ok) setRefreshToken((n) => n + 1);
          return ok;
        }}
        onBanLibrary={async (p) => {
          const ok = await handleBanPath(p);
          if (ok) setRefreshToken((n) => n + 1);
          return ok;
        }}
        onRestoreTrash={async (p, name) => {
          try {
            await window.wayper.restoreImage(p);
            await refreshStatusAndCounts();
            setRefreshToken((n) => n + 1);
            notify(`${t("Restore")}: ${name}`, "success");
            return true;
          } catch (err) {
            notify(err instanceof Error ? err.message : "Restore failed", "error");
            return false;
          }
        }}
        onDecisionReview={handleLightboxReviewDecision}
        onOpenWallhaven={handleOpenWallhaven}
        onFilterByTag={(tag) => void handleSelectTagFilter(tag)}
        onFilterByUploader={(uploader) => void handleSelectUploaderFilter(uploader)}
        onNotify={notify}
      />

      <CommandPalette
        open={commandPaletteOpen}
        t={t}
        mode={mode}
        density={galleryPrefs.density}
        framing={galleryPrefs.framing}
        rotationOff={
          (config?.interval_min ?? 5) <= 0 ||
          (!status?.auto_rotation && !status?.rotation_paused)
        }
        rotationPaused={Boolean(status?.rotation_paused)}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectMode={(nextMode) => {
          if (view === "settings") closeSettingsRevertingPreview();
          setMode(nextMode);
        }}
        onOpenSettings={() => {
          setPreviewLang(null);
          setView("settings");
        }}
        onNextWallpaper={() => void handleControl("next")}
        onPrevWallpaper={() => void handleControl("prev")}
        onLocateCurrent={() => void handleLocateCurrent()}
        onToggleRotation={() => void handleRotationButton()}
        onCycleDensity={handleCycleDensity}
        onToggleFraming={handleToggleFraming}
        onRetrainModel={() => void handleRetrainFromPalette()}
      />

      <ToastHost t={t} toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
