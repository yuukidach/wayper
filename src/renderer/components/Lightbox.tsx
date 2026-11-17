import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import type {
  ConfigPayload,
  ImageItem,
  ReviewCandidateItem,
} from "../../shared/types";
import { tagItems } from "../../shared/tags";
import {
  extractUploaderName,
  formatFileSize,
  normalizeHexColor,
  thumbUrl,
  trashThumbUrl,
} from "../lib/media";
import { useAmbient } from "../lib/ambient";
import { prewarmLightboxPreview } from "../lib/lightbox-preview";
import { useImageMetadata } from "../lib/metadata-cache";
import { motionTransition } from "../lib/motion";
import { LightboxImage } from "./LightboxImage";
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

const topIconButton =
  "flex h-8 w-8 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white";
const dockPrimary =
  "inline-flex h-10 items-center gap-2 rounded-xl bg-accent pr-3 pl-3.5 text-[13.5px] font-semibold text-on-accent transition-colors hover:bg-accent-hi";
const dockIcon =
  "flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink";
const dockIconDanger =
  "flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-drop/15 hover:text-drop";

const LightboxView: React.FC<Omit<LightboxProps, "session"> & { session: LightboxSession }> = ({
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
  const [entered, setEntered] = useState(false);
  const [direction, setDirection] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [favOverride, setFavOverride] = useState<Record<string, boolean>>({});

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const zoomRef = useRef({ scale: 1, pan: { x: 0, y: 0 } });
  const zoomFrameRef = useRef<number | null>(null);
  const oneToOneRef = useRef<{ x: number; y: number } | null>(null);
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();

  const current = session.items[session.index];
  const { metadata, loading: metaLoading } = useImageMetadata(
    current?.name,
    Boolean(inspectorOpen && entered && isPresent),
  );

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useLayoutEffect(() => {
    zoomRef.current = { scale: 1, pan: { x: 0, y: 0 } };
    oneToOneRef.current = null;
    dragStartRef.current = null;
    setScale(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    setNaturalSize(null);
  }, [current.path]);

  useEffect(() => () => {
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
  }, []);

  const scheduleZoom = useCallback(() => {
    if (zoomFrameRef.current !== null) return;
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      setScale(zoomRef.current.scale);
      setPan(zoomRef.current.pan);
    });
  }, []);

  const handleEntered = useCallback(() => setEntered(true), []);

  useEffect(() => {
    if (!isPresent || session.items.length <= 1) return;
    const delayMs = entered ? 35 : 140;
    const timer = window.setTimeout(() => {
      const nextIndex = (session.index + 1) % session.items.length;
      const prevIndex = (session.index - 1 + session.items.length) % session.items.length;
      prewarmLightboxPreview(session.items[nextIndex], session.context);
      if (prevIndex !== nextIndex) {
        prewarmLightboxPreview(session.items[prevIndex], session.context);
      }
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [entered, isPresent, session.context, session.index, session.items]);

  const clampScale = (next: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));

  const zoomAnchoredAt = useCallback(
    (nextScaleRaw: number, clientX?: number, clientY?: number) => {
      const stage = stageRef.current?.querySelector("[data-lightbox-area]") ?? stageRef.current;
      const nextScale = clampScale(nextScaleRaw);
      if (!stage) {
        zoomRef.current = { scale: nextScale, pan: { x: 0, y: 0 } };
        scheduleZoom();
        return;
      }
      const rect = stage.getBoundingClientRect();
      const cx = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const cy = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);

      const previous = zoomRef.current;
      const ratio = nextScale / previous.scale;
      zoomRef.current = {
        scale: nextScale,
        pan: nextScale === 1 ? { x: 0, y: 0 } : {
          x: cx - (cx - previous.pan.x) * ratio,
          y: cy - (cy - previous.pan.y) * ratio,
        },
      };
      scheduleZoom();
    },
    [scheduleZoom],
  );

  const resetZoom = useCallback(() => {
    oneToOneRef.current = null;
    zoomRef.current = { scale: 1, pan: { x: 0, y: 0 } };
    scheduleZoom();
  }, [scheduleZoom]);

  const handleNaturalSize = useCallback((size: { w: number; h: number }) => {
    setNaturalSize(size);
    const anchor = oneToOneRef.current;
    if (anchor && imgRef.current) {
      oneToOneRef.current = null;
      zoomAnchoredAt(size.w / Math.max(1, imgRef.current.clientWidth), anchor.x, anchor.y);
    }
  }, [zoomAnchoredAt]);

  const toggleOneToOne = useCallback(
    (e: React.MouseEvent) => {
      const imgEl = imgRef.current;
      if (!imgEl) return;
      if (Math.abs(scale - 1) > 0.03) {
        resetZoom();
        return;
      }
      const baseWidth = imgEl.clientWidth || 1;
      if (!naturalSize) {
        oneToOneRef.current = { x: e.clientX, y: e.clientY };
        zoomAnchoredAt(2, e.clientX, e.clientY);
        return;
      }
      const natWidth = naturalSize.w;
      const oneToOneScale = clampScale(natWidth / baseWidth);
      if (Math.abs(oneToOneScale - 1) < 0.05) {
        zoomAnchoredAt(2, e.clientX, e.clientY);
      } else {
        zoomAnchoredAt(oneToOneScale, e.clientX, e.clientY);
      }
    },
    [scale, naturalSize, resetZoom, zoomAnchoredAt],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !isPresent) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      oneToOneRef.current = null;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const delta = Math.max(-120, Math.min(120, event.deltaY * unit));
      zoomAnchoredAt(zoomRef.current.scale * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [isPresent, zoomAnchoredAt]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || scale <= 1) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: zoomRef.current.pan.x,
      panY: zoomRef.current.pan.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    zoomRef.current.pan = {
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    };
    scheduleZoom();
  };

  const handlePointerUp = () => {
    setDragging(false);
    dragStartRef.current = null;
  };

  const navigateItem = useCallback(
    (delta: -1 | 1) => {
      if (!session || session.items.length <= 1) return;
      setDirection(delta);
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
          zoomRef.current.pan = { ...pan, x: Math.min(maxOverflowX, pan.x + step) };
          scheduleZoom();
          return;
        }
        if (delta === 1 && pan.x > -maxOverflowX + 4) {
          zoomRef.current.pan = { ...pan, x: Math.max(-maxOverflowX, pan.x - step) };
          scheduleZoom();
          return;
        }
      }
      navigateItem(delta);
    },
    [session, scale, pan, navigateItem, scheduleZoom],
  );

  useEffect(() => {
    if (!isPresent) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.stopPropagation();

      switch (e.key) {
        case "Tab": {
          const buttons = Array.from(
            dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
          );
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          const outsideButtons = target === dialogRef.current || !dialogRef.current?.contains(target);
          if (e.shiftKey && (target === first || outsideButtons)) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && (target === last || outsideButtons)) {
            e.preventDefault();
            first?.focus();
          }
          return;
        }
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
    isPresent,
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
    entered && current && session
      ? session.context === "trash"
        ? trashThumbUrl(current.name)
        : thumbUrl(current.path)
      : null,
  );

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

  return (
        <motion.div
          ref={dialogRef}
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionTransition.normal}
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-label={current.name}
          data-lightbox="true"
          className="fixed inset-0 z-50 flex overflow-hidden outline-none select-none"
        >
          {/* The viewed image lights its own room. */}
          <motion.div
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={motionTransition.normal}
            className="pointer-events-none absolute inset-0 overflow-hidden bg-[#070707]"
          >
            <AnimatePresence initial={false}>
              {ambient && (
                <motion.img
                  key={ambient.source}
                  src={ambient.url}
                  alt=""
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.55 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition.ambient}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </AnimatePresence>
            <div className="absolute inset-0 bg-black/55" />
          </motion.div>
          <div
            style={{ marginRight: inspectorOpen ? 348 : 0 }}
            className="relative flex min-w-0 flex-1 flex-col transition-[margin-right] duration-200 ease-[var(--ease-out-soft)]"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={motionTransition.normal}
              className="pointer-events-none absolute top-0 right-0 left-0 z-20 flex h-14 items-center justify-between gap-4 px-5"
            >
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
            </motion.div>

            <div
              ref={stageRef}
              onDoubleClick={toggleOneToOne}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onLostPointerCapture={handlePointerUp}
              onClick={(e) => {
                if (e.target === stageRef.current && scale === 1) {
                  onClose();
                }
              }}
              className={`relative flex flex-1 touch-none items-center justify-center overflow-hidden ${
                scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
              }`}
            >
              <AnimatePresence custom={{ closing: !isPresent, direction }} propagate>
                <LightboxImage
                  key={current.path}
                  item={current}
                  context={session.context}
                  opening={!entered}
                  direction={direction}
                  scale={scale}
                  pan={pan}
                  dragging={dragging}
                  imageRef={imgRef}
                  onNaturalSize={handleNaturalSize}
                  onEntered={handleEntered}
                />
              </AnimatePresence>

              {session.items.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateItem(-1);
                    }}
                    className="absolute left-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 transition-colors hover:bg-white/[0.16] hover:text-white"
                    aria-label={t("Previous")}
                  >
                    <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateItem(1);
                    }}
                    className="absolute right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 transition-colors hover:bg-white/[0.16] hover:text-white"
                    aria-label={t("Next")}
                  >
                    <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                </>
              )}
            </div>

            <motion.div
              initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(8px)" }}
              animate={{ opacity: 1, transform: "none" }}
              transition={motionTransition.reveal}
              className="pointer-events-none absolute right-0 bottom-5 left-0 z-20 flex justify-center px-4"
            >
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
                      className={`${dockIcon} ${isFav ? "text-fav!" : ""}`}
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
            </motion.div>
          </div>

          <AnimatePresence initial={false}>
            {inspectorOpen && (
              <motion.aside
                initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateX(16px)" }}
                animate={{ opacity: 1, transform: "none" }}
                exit={{ opacity: 0, transform: reducedMotion ? "none" : "translateX(16px)" }}
                transition={motionTransition.normal}
                className="inspector-surface absolute top-16 right-4 bottom-24 z-30 flex w-[332px] flex-col overflow-hidden rounded-2xl"
              >
                <div className="flex h-14 w-[332px] shrink-0 items-center justify-between pr-3 pl-5 shadow-[inset_0_-1px_0_var(--color-line)]">
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
                            metadata?.category
                              ? metadata.category.replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
                              : undefined,
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
                      <div className="flex h-8 overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
                        {metadata.colors.map((rawColor) => {
                          const hex = normalizeHexColor(rawColor);
                          const isCopied = copiedHex === hex;
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
                              title={isCopied ? `${t("Copied")} ${hex}` : hex}
                              aria-label={`Copy ${hex}`}
                              className="flex h-full flex-1 items-center justify-center transition-[flex-grow] duration-200 hover:flex-[1.7]"
                              style={{ backgroundColor: hex }}
                            >
                              {isCopied && (
                                <Check
                                  className="h-3.5 w-3.5 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.9)]"
                                  strokeWidth={2.75}
                                />
                              )}
                            </button>
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
  );
};

export const Lightbox: React.FC<LightboxProps> = (props) => (
  <AnimatePresence>
    {props.session?.items[props.session.index] && (
      <LightboxView {...props} session={props.session} />
    )}
  </AnimatePresence>
);
