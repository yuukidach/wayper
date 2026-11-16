import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Heart,
  Info,
  Lock,
  MonitorUp,
  RotateCcw,
  ThumbsDown,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type {
  ConfigPayload,
  ImageItem,
  ImageMetadata,
  ReviewCandidateItem,
} from "../../shared/types";
import { tagItems } from "../../shared/tags";
import {
  extractUploaderName,
  formatFileSize,
  fullImgUrl,
  normalizeHexColor,
  previewUrl,
  thumbUrl,
  trashThumbUrl,
  trashUrl,
} from "../lib/media";
import { useAmbient } from "../lib/ambient";
import type { ReviewLane } from "./ReviewWorkspace";

export type LightboxContextKind = "library" | "trash" | "review";

export interface LightboxSession {
  context: LightboxContextKind;
  index: number;
  items: Array<ImageItem | ReviewCandidateItem>;
  reviewLane?: ReviewLane;
}

interface LightboxProps {
  t: (key: string) => string;
  session: LightboxSession | null;
  config: ConfigPayload | null;
  onClose: () => void;
  onChangeIndex: (nextIndex: number) => void;
  onSetWallpaper: (path: string) => Promise<void>;
  onSetGreeter: (path: string) => Promise<void>;
  onToggleFavorite: (path: string) => Promise<{ new_path: string; is_favorite: boolean } | null>;
  onDislikeLibrary: (path: string) => Promise<boolean>;
  onBanLibrary: (path: string) => Promise<boolean>;
  onRestoreTrash: (path: string, name: string) => Promise<boolean>;
  onDecisionReview: (
    item: ReviewCandidateItem,
    lane: ReviewLane,
    action: "keep" | "ban",
  ) => Promise<void>;
  onOpenWallhaven: (filenameOrPath: string) => void;
  onFilterByTag: (tag: string) => void;
  onFilterByUploader: (uploader: string) => void;
  onNotify: (text: string, tone?: "info" | "success" | "error") => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;
const metadataCache = new Map<string, ImageMetadata | null>();

const topIconButton =
  "flex h-8 w-8 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white";
const dockPrimary =
  "inline-flex h-10 items-center gap-2 rounded-xl bg-accent pr-3 pl-3.5 text-[13.5px] font-semibold text-on-accent transition-colors hover:bg-accent-hi";
const dockIcon =
  "flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink";
const dockIconDanger =
  "flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-drop/15 hover:text-drop";

export const Lightbox: React.FC<LightboxProps> = ({
  t,
  session,
  config,
  onClose,
  onChangeIndex,
  onSetWallpaper,
  onSetGreeter,
  onToggleFavorite,
  onDislikeLibrary,
  onBanLibrary,
  onRestoreTrash,
  onDecisionReview,
  onOpenWallhaven,
  onFilterByTag,
  onFilterByUploader,
  onNotify,
}) => {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [fullSrcReady, setFullSrcReady] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [favOverride, setFavOverride] = useState<Record<string, boolean>>({});

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const current = session ? session.items[session.index] ?? null : null;

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setFullSrcReady(false);
    setNaturalSize(null);

    if (!current || !session) return;
    const hiResSrc =
      session.context === "trash" ? trashUrl(current.name) : fullImgUrl(current.path);

    let cancelled = false;
    const loader = new Image();
    loader.decoding = "async";
    loader.onload = () => {
      if (cancelled) return;
      setNaturalSize({ w: loader.naturalWidth, h: loader.naturalHeight });
      setFullSrcReady(true);
    };
    loader.src = hiResSrc;
    return () => {
      cancelled = true;
    };
  }, [current?.path, current?.name, session?.context]);

  useEffect(() => {
    if (!inspectorOpen || !current) return;
    const key = current.name;
    if (metadataCache.has(key)) {
      setMetadata(metadataCache.get(key) ?? null);
      setMetaLoading(false);
      return;
    }
    let cancelled = false;
    setMetaLoading(true);
    window.wayper
      .getImageMetadata(current.name)
      .then((res) => {
        if (cancelled) return;
        metadataCache.set(key, res);
        setMetadata(res);
      })
      .catch(() => {
        if (!cancelled) setMetadata(null);
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorOpen, current?.name]);

  const clampScale = (next: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));

  const zoomAnchoredAt = useCallback(
    (nextScaleRaw: number, clientX?: number, clientY?: number) => {
      const stage = stageRef.current;
      const nextScale = clampScale(nextScaleRaw);
      if (!stage) {
        setScale(nextScale);
        if (nextScale <= 1) setPan({ x: 0, y: 0 });
        return;
      }
      const rect = stage.getBoundingClientRect();
      const cx = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const cy = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);

      setScale((prevScale) => {
        if (nextScale === 1) {
          setPan({ x: 0, y: 0 });
          return 1;
        }
        const ratio = nextScale / prevScale;
        setPan((prevPan) => ({
          x: cx - (cx - prevPan.x) * ratio,
          y: cy - (cy - prevPan.y) * ratio,
        }));
        return nextScale;
      });
    },
    [],
  );

  const resetZoom = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const toggleOneToOne = useCallback(
    (e: React.MouseEvent) => {
      const imgEl = imgRef.current;
      if (!imgEl) return;
      if (Math.abs(scale - 1) > 0.03) {
        resetZoom();
        return;
      }
      const baseWidth = imgEl.clientWidth || 1;
      const natWidth = naturalSize?.w || imgEl.naturalWidth || baseWidth;
      const oneToOneScale = clampScale(natWidth / baseWidth);
      if (Math.abs(oneToOneScale - 1) < 0.05) {
        zoomAnchoredAt(2, e.clientX, e.clientY);
      } else {
        zoomAnchoredAt(oneToOneScale, e.clientX, e.clientY);
      }
    },
    [scale, naturalSize, resetZoom, zoomAnchoredAt],
  );

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
    zoomAnchoredAt(scale * factor, e.clientX, e.clientY);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || scale <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handlePointerUp = () => {
    setDragging(false);
    dragStartRef.current = null;
  };

  const navigateItem = useCallback(
    (delta: -1 | 1) => {
      if (!session || session.items.length <= 1) return;
      const next = (session.index + delta + session.items.length) % session.items.length;
      onChangeIndex(next);
    },
    [session, onChangeIndex],
  );

  const arrowPanOrNavigate = useCallback(
    (delta: -1 | 1) => {
      if (!session) return;
      if (session.context === "review") {
        navigateItem(delta);
        return;
      }
      const imgEl = imgRef.current;
      const stageEl = stageRef.current;
      if (scale > 1.02 && imgEl && stageEl) {
        const maxOverflowX = Math.max(0, (imgEl.clientWidth * scale - stageEl.clientWidth) / 2);
        const step = 120;
        if (delta === -1 && pan.x < maxOverflowX - 4) {
          setPan((p) => ({ ...p, x: Math.min(maxOverflowX, p.x + step) }));
          return;
        }
        if (delta === 1 && pan.x > -maxOverflowX + 4) {
          setPan((p) => ({ ...p, x: Math.max(-maxOverflowX, p.x - step) }));
          return;
        }
      }
      navigateItem(delta);
    },
    [session, scale, pan.x, navigateItem],
  );

  useEffect(() => {
    if (!session || !current) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.stopPropagation();

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          return;
        case "i":
        case "I":
          e.preventDefault();
          setInspectorOpen((v) => !v);
          return;
        case "ArrowLeft":
          e.preventDefault();
          arrowPanOrNavigate(-1);
          return;
        case "ArrowRight":
          e.preventDefault();
          arrowPanOrNavigate(1);
          return;
        case "+":
        case "=":
          e.preventDefault();
          zoomAnchoredAt(scale * ZOOM_STEP);
          return;
        case "-":
          e.preventDefault();
          zoomAnchoredAt(scale / ZOOM_STEP);
          return;
        case "0":
          e.preventDefault();
          resetZoom();
          return;
        case "o":
        case "O":
          e.preventDefault();
          onOpenWallhaven(current.name);
          return;
        case " ":
          if (!target?.closest("button")) {
            e.preventDefault();
            onClose();
          }
          return;
        case "Enter":
          if (target?.closest("button")) return;
          e.preventDefault();
          if (session.context === "library") {
            void onSetWallpaper(current.path).then(() => onClose());
          }
          return;
        case "f":
        case "F":
          if (session.context === "library") {
            e.preventDefault();
            void onToggleFavorite(current.path).then((res) => {
              if (res) {
                setFavOverride((prev) => ({ ...prev, [current.name]: res.is_favorite }));
              }
            });
          }
          return;
        case "a":
        case "A":
          if (session.context === "review") {
            e.preventDefault();
            void onDecisionReview(
              current as ReviewCandidateItem,
              session.reviewLane ?? "held",
              "keep",
            );
          }
          return;
        case "d":
        case "D":
          e.preventDefault();
          if (session.context === "review") {
            void onDecisionReview(
              current as ReviewCandidateItem,
              session.reviewLane ?? "held",
              "ban",
            );
          } else if (session.context === "library") {
            void onDislikeLibrary(current.path).then((ok) => {
              if (ok) onClose();
            });
          }
          return;
        case "x":
        case "X":
        case "Delete":
          if (session.context === "library") {
            e.preventDefault();
            void onBanLibrary(current.path).then((ok) => {
              if (ok) onClose();
            });
          }
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    session,
    current,
    scale,
    arrowPanOrNavigate,
    zoomAnchoredAt,
    resetZoom,
    onClose,
    onOpenWallhaven,
    onSetWallpaper,
    onToggleFavorite,
    onDecisionReview,
    onDislikeLibrary,
    onBanLibrary,
  ]);

  const ambient = useAmbient(
    current && session
      ? session.context === "trash"
        ? trashThumbUrl(current.name)
        : thumbUrl(current.path)
      : null,
  );

  const displaySrc = useMemo(() => {
    if (!current || !session) return "";
    if (session.context === "trash") {
      return fullSrcReady ? trashUrl(current.name) : trashThumbUrl(current.name);
    }
    return fullSrcReady ? fullImgUrl(current.path) : previewUrl(current.path);
  }, [current, session, fullSrcReady]);

  const isFav = useMemo(() => {
    if (!current) return false;
    if (current.name in favOverride) return favOverride[current.name];
    return "is_favorite" in current ? Boolean(current.is_favorite) : false;
  }, [current, favOverride]);

  const uploaderName = useMemo(() => extractUploaderName(metadata), [metadata]);
  const normalizedTags = useMemo(
    () => tagItems(metadata?.tag_details ?? metadata?.tags ?? []),
    [metadata],
  );
  const resolutionText = useMemo(() => {
    if (metadata?.dimension_x && metadata?.dimension_y) {
      return `${metadata.dimension_x} × ${metadata.dimension_y}`;
    }
    if (metadata?.resolution) {
      return metadata.resolution.replace(/x/i, " × ");
    }
    if (naturalSize) {
      return `${naturalSize.w} × ${naturalSize.h}`;
    }
    return "—";
  }, [metadata, naturalSize]);

  // Grow out of the tile that was opened, so the image never just "appears".
  const openOrigin = useRef("50% 50%");
  const wasOpen = useRef(false);
  if (session && current && !wasOpen.current) {
    const tile = Array.from(document.querySelectorAll<HTMLElement>("[data-path]")).find(
      (node) => node.dataset.path === current.path,
    );
    const rect = tile?.getBoundingClientRect();
    openOrigin.current = rect
      ? `${Math.round(rect.left + rect.width / 2)}px ${Math.round(rect.top + rect.height / 2)}px`
      : "50% 50%";
  }
  wasOpen.current = Boolean(session && current);

  return (
    <AnimatePresence>
      {session && current && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 flex overflow-hidden bg-[#070707] select-none"
        >
          {/* The viewed image lights its own room. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <AnimatePresence initial={false}>
              {ambient && (
                <motion.img
                  key={ambient.source}
                  src={ambient.url}
                  alt=""
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.55 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: "linear" }}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </AnimatePresence>
            <div className="absolute inset-0 bg-black/55" />
          </div>
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="pointer-events-none absolute top-0 right-0 left-0 z-20 flex h-14 items-center justify-between gap-4 px-5">
              <div className="flex min-w-0 items-baseline gap-2.5 text-[13px]">
                <span className="truncate font-medium text-white/90">{current.name}</span>
                <span className="shrink-0 tabular-nums text-white/45">
                  {session.index + 1} / {session.items.length}
                </span>
              </div>

              <div className="pointer-events-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => zoomAnchoredAt(scale / ZOOM_STEP)}
                  title={`${t("Zoom out")} [-]`}
                  aria-label={t("Zoom out")}
                  className={topIconButton}
                >
                  <ZoomOut className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={resetZoom}
                  title={`${t("Reset zoom")} [0]`}
                  className="h-8 min-w-[46px] rounded-lg px-1.5 text-[12.5px] tabular-nums text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {Math.round(scale * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => zoomAnchoredAt(scale * ZOOM_STEP)}
                  title={`${t("Zoom in")} [+]`}
                  aria-label={t("Zoom in")}
                  className={topIconButton}
                >
                  <ZoomIn className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <span className="mx-1 h-4 w-px bg-white/15" />
                <button
                  type="button"
                  onClick={onClose}
                  title={`${t("Close")} [Esc]`}
                  aria-label={t("Close")}
                  className={topIconButton}
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            <motion.div
              ref={stageRef}
              initial={{ scale: 0.3, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.8 }}
              style={{ transformOrigin: openOrigin.current }}
              onWheel={handleWheel}
              onDoubleClick={toggleOneToOne}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onClick={(e) => {
                if (e.target === stageRef.current && scale === 1) {
                  onClose();
                }
              }}
              className={`relative flex flex-1 items-center justify-center overflow-hidden px-16 pt-14 pb-[88px] ${
                scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
              }`}
            >
              <img
                ref={imgRef}
                src={displaySrc}
                alt={current.name}
                draggable={false}
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
                  transition: dragging ? "none" : "transform 110ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
                className="max-h-full max-w-full rounded-lg object-contain shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] select-none"
              />

              {session.items.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateItem(-1);
                    }}
                    className="absolute left-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 backdrop-blur-md transition-colors hover:bg-white/[0.16] hover:text-white"
                    aria-label="Previous"
                  >
                    <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateItem(1);
                    }}
                    className="absolute right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 backdrop-blur-md transition-colors hover:bg-white/[0.16] hover:text-white"
                    aria-label="Next"
                  >
                    <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                </>
              )}
            </motion.div>

            <div className="pointer-events-none absolute right-0 bottom-5 left-0 z-20 flex justify-center px-4">
              <div className="pointer-events-auto flex items-center gap-1 dock-surface rounded-[20px] p-1.5">
                {session.context === "library" && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onSetWallpaper(current.path).then(() => onClose())}
                      className={dockPrimary}
                    >
                      <MonitorUp className="h-4 w-4" strokeWidth={1.75} />
                      <span>{t("Set Wallpaper")}</span>
                      <kbd className="keycap keycap-on-accent">↵</kbd>
                    </button>

                    {config?.greeter?.available && (
                      <button
                        type="button"
                        onClick={() => void onSetGreeter(current.path)}
                        title={t("Set Greeter")}
                        aria-label={t("Set Greeter")}
                        className={dockIcon}
                      >
                        <Lock className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    )}

                    <span className="mx-1 h-5 w-px bg-white/[0.1]" />

                    <button
                      type="button"
                      onClick={() =>
                        void onToggleFavorite(current.path).then((res) => {
                          if (res) {
                            setFavOverride((prev) => ({
                              ...prev,
                              [current.name]: res.is_favorite,
                            }));
                          }
                        })
                      }
                      title={`${isFav ? t("Unfavorite") : t("Favorite")} [F]`}
                      aria-label={isFav ? t("Unfavorite") : t("Favorite")}
                      aria-pressed={isFav}
                      className={`${dockIcon} ${isFav ? "text-ink!" : ""}`}
                    >
                      <Heart
                        className={`h-4 w-4 ${isFav ? "fill-current" : ""}`}
                        strokeWidth={1.75}
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void onDislikeLibrary(current.path).then((ok) => {
                          if (ok) onClose();
                        })
                      }
                      title={`${t("Dislike")} [D]`}
                      aria-label={t("Dislike")}
                      className={dockIconDanger}
                    >
                      <ThumbsDown className="h-4 w-4" strokeWidth={1.75} />
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void onBanLibrary(current.path).then((ok) => {
                          if (ok) onClose();
                        })
                      }
                      title={`${t("Ban")} [X]`}
                      aria-label={t("Ban")}
                      className={dockIconDanger}
                    >
                      <Ban className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </>
                )}

                {session.context === "trash" && (
                  <button
                    type="button"
                    onClick={() =>
                      void onRestoreTrash(current.path, current.name).then((ok) => {
                        if (ok) onClose();
                      })
                    }
                    className={dockPrimary}
                  >
                    <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                    <span>{t("Restore")}</span>
                  </button>
                )}

                {session.context === "review" && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void onDecisionReview(
                          current as ReviewCandidateItem,
                          session.reviewLane ?? "held",
                          "keep",
                        )
                      }
                      className="inline-flex h-10 items-center gap-2 rounded-xl pr-3 pl-3.5 text-[13.5px] font-medium text-ink transition-colors hover:bg-keep/15 hover:text-keep"
                    >
                      <Check className="h-4 w-4" strokeWidth={2} />
                      <span>{t("Keep")}</span>
                      <kbd className="keycap">A</kbd>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void onDecisionReview(
                          current as ReviewCandidateItem,
                          session.reviewLane ?? "held",
                          "ban",
                        )
                      }
                      className="inline-flex h-10 items-center gap-2 rounded-xl pr-3 pl-3.5 text-[13.5px] font-medium text-ink transition-colors hover:bg-drop/15 hover:text-drop"
                    >
                      <X className="h-4 w-4" strokeWidth={2} />
                      <span>{t("Dislike")}</span>
                      <kbd className="keycap">D</kbd>
                    </button>
                  </>
                )}

                <span className="mx-1 h-5 w-px bg-white/[0.1]" />

                <button
                  type="button"
                  onClick={() => setInspectorOpen((v) => !v)}
                  title={`${t("Details")} [I]`}
                  aria-label={t("Details")}
                  aria-pressed={inspectorOpen}
                  className={`${dockIcon} ${inspectorOpen ? "bg-white/[0.12] text-ink!" : ""}`}
                >
                  <Info className="h-4 w-4" strokeWidth={1.75} />
                </button>

                <button
                  type="button"
                  onClick={() => onOpenWallhaven(current.name)}
                  title={`${t("Open on Wallhaven")} [O]`}
                  aria-label={t("Open on Wallhaven")}
                  className={dockIcon}
                >
                  <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {inspectorOpen && (
              <motion.aside
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 332, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="relative flex h-full shrink-0 flex-col overflow-hidden bg-black/45 shadow-[inset_1px_0_0_var(--color-line)]"
              >
                <div className="flex h-14 w-[332px] shrink-0 items-center justify-between pr-3 pl-5">
                  <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">
                    {t("Details")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setInspectorOpen(false)}
                    aria-label={t("Close")}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-white/[0.07] hover:text-ink"
                  >
                    <X className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>

                <div className="flex w-[332px] flex-1 flex-col gap-6 overflow-y-auto px-5 pb-6 text-[13px]">
                  <dl className="m-0 divide-y divide-line">
                    {(
                      [
                        [t("Resolution"), resolutionText],
                        [t("Size"), formatFileSize(metadata?.file_size) || "—"],
                        [
                          t("Category"),
                          [
                            metadata?.category,
                            metadata?.purity && /^n?sfw$/i.test(metadata.purity)
                              ? metadata.purity.toUpperCase()
                              : metadata?.purity,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—",
                        ],
                      ] as Array<[string, string]>
                    ).map(([label, value]) => (
                      <div key={label} className="flex h-9 items-center justify-between gap-4">
                        <dt className="text-ink-3">{label}</dt>
                        <dd className="m-0 truncate tabular-nums text-ink first-letter:uppercase">
                          {metaLoading && value === "—" ? "…" : value}
                        </dd>
                      </div>
                    ))}
                    <div className="flex h-9 items-center justify-between gap-4">
                      <dt className="text-ink-3">{t("Uploader")}</dt>
                      <dd className="m-0 min-w-0">
                        {uploaderName ? (
                          <button
                            type="button"
                            onClick={() => {
                              onFilterByUploader(uploaderName);
                              onClose();
                            }}
                            className="block max-w-full truncate text-ink underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/70"
                          >
                            @{uploaderName}
                          </button>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </dd>
                    </div>
                  </dl>

                  {metadata?.colors && metadata.colors.length > 0 && (
                    <div className="space-y-2.5">
                      <div className="text-[12.5px] font-medium text-ink-3">{t("Palette")}</div>
                      <div className="flex h-8 overflow-hidden rounded-lg">
                        {metadata.colors.map((rawColor) => {
                          const hex = normalizeHexColor(rawColor);
                          return (
                            <button
                              key={hex}
                              type="button"
                              onClick={() => {
                                window.wayper.copyToClipboard(hex);
                                setCopiedHex(hex);
                                onNotify(`${t("Copied")} ${hex}`, "info");
                                window.setTimeout(() => setCopiedHex(null), 1500);
                              }}
                              title={copiedHex === hex ? t("Copied") : hex}
                              aria-label={`Copy ${hex}`}
                              className="h-full flex-1 transition-[flex-grow] duration-200 hover:flex-[1.6]"
                              style={{ backgroundColor: hex }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {normalizedTags.length > 0 && (
                    <div className="space-y-2.5">
                      <div className="text-[12.5px] font-medium text-ink-3">
                        {t("Tags & Concepts")}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {normalizedTags.map(([normKey, displayLabel]) => (
                          <button
                            key={normKey}
                            type="button"
                            onClick={() => {
                              onFilterByTag(normKey);
                              onClose();
                            }}
                            className="inline-flex h-7 items-center rounded-full bg-white/[0.06] px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-white/[0.12] hover:text-ink"
                          >
                            {displayLabel}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
