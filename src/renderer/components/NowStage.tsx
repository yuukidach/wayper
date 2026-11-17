import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  ExternalLink,
  Heart,
  LocateFixed,
  Maximize2,
  Monitor,
  SkipBack,
  SkipForward,
  ThumbsDown,
  Timer,
  Undo2,
} from "lucide-react";
import type { ConfigPayload, MonitorInfo, StatusResponse } from "../../shared/types";
import { tagItems } from "../../shared/tags";
import {
  basenameFromPath,
  extractUploaderName,
  normalizeHexColor,
  previewUrl,
} from "../lib/media";
import { useImageMetadata } from "../lib/metadata-cache";
import { CrossfadeImage } from "./CrossfadeImage";

interface NowStageProps {
  t: (key: string) => string;
  monitors: MonitorInfo[];
  activeMonitorName: string | null;
  onSelectMonitor: (monitorName: string) => void;
  status: StatusResponse | null;
  config: ConfigPayload | null;
  onRotationAction: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLocate: () => void;
  onUndo: () => void;
  onFavorite: (favorite: boolean) => void;
  onDislike: () => void;
  onInspectCurrent?: (imagePath: string) => void;
  onSelectTag?: (tag: string) => void;
  onSelectUploader?: (uploader: string) => void;
  onOpenWallhaven?: (filenameOrPath: string) => void;
  onCopyColor?: (hex: string) => void;
}

const ROUND_BUTTON =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-ink-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.055)] transition-colors hover:bg-white/[0.13] hover:text-ink";

const STAGE_GAP = 16;
const DETAILS_GAP = 40;
const DETAILS_MIN_WIDTH = 300;
const PAGE_GUTTERS = 48;
const WIDE_HEIGHT = 9 / 16;
/** How much taller the stage gets when one of the displays stands upright. */
const UPRIGHT_STAGE_GROWTH = 0.22;
/** Below this share of its natural size the row stops sharing a line with the details. */
const MIN_BESIDE_SHARE = 0.7;

function aspectOf(monitor: MonitorInfo): number {
  if (monitor.width && monitor.height) return monitor.width / monitor.height;
  return monitor.orientation === "portrait" ? 9 / 16 : 16 / 9;
}

/**
 * A display's footprint with its long side as 1.  Panels are drawn as if they
 * were the same size, the way they sit on a desk, so a rotated display takes
 * as much room as a wide one.
 */
function footprintOf(monitor: MonitorInfo): { width: number; height: number } {
  const aspect = aspectOf(monitor);
  return aspect >= 1 ? { width: 1, height: 1 / aspect } : { width: aspect, height: 1 };
}

function formatArtworkLabel(filename: string): { label: string; isWallhaven: boolean } {
  const match = /^wallhaven-([a-z0-9]+)\.[a-z0-9]+$/i.exec(filename);
  if (match) {
    return { label: `#${match[1].toLowerCase()}`, isWallhaven: true };
  }
  return { label: filename.replace(/\.[a-z0-9]+$/i, ""), isWallhaven: false };
}

function useViewport(): { width: number; height: number } {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

/**
 * The displays as they are right now.  Picking one switches the library below
 * to its orientation.
 *
 * Every display keeps its size and place whichever one is selected: the choice
 * is shown with a ring and brightness, so a switch moves nothing.
 */
export const NowStage: React.FC<NowStageProps> = ({
  t,
  monitors,
  activeMonitorName,
  onSelectMonitor,
  status,
  config,
  onRotationAction,
  onPrev,
  onNext,
  onLocate,
  onUndo,
  onFavorite,
  onDislike,
  onInspectCurrent,
  onSelectTag,
  onSelectUploader,
  onOpenWallhaven,
  onCopyColor,
}) => {
  const viewport = useViewport();
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const active = monitors.find((monitor) => monitor.name === activeMonitorName) ?? monitors[0];
  const currentImage = active?.current_image ?? null;
  const currentFilename = useMemo(
    () => (currentImage ? basenameFromPath(currentImage) : null),
    [currentImage],
  );
  const { metadata } = useImageMetadata(currentFilename, Boolean(currentFilename));

  const uploaderName = useMemo(() => extractUploaderName(metadata), [metadata]);
  const paletteColors = useMemo(
    () => (metadata?.colors ?? []).slice(0, 5).map(normalizeHexColor),
    [metadata],
  );
  const curatedTags = useMemo(
    () => tagItems(metadata?.tag_details ?? metadata?.tags ?? []).slice(0, 4),
    [metadata],
  );
  const artworkResolution = useMemo(() => {
    if (metadata?.dimension_x && metadata?.dimension_y) {
      return `${metadata.dimension_x} × ${metadata.dimension_y}`;
    }
    if (metadata?.resolution) {
      return metadata.resolution.replace(/x/i, " × ");
    }
    return null;
  }, [metadata]);

  if (!active) return null;

  const shown = monitors.slice(0, 9);
  const activeIndex = shown.findIndex((monitor) => monitor.name === active.name);
  const footprints = shown.map(footprintOf);
  const tallest = Math.max(...footprints.map((footprint) => footprint.height));
  const span = footprints.reduce((sum, footprint) => sum + footprint.width, 0);
  const gaps = STAGE_GAP * (shown.length - 1);

  // Wide displays alone keep a low stage.  An upright one raises it, so the
  // wide displays next to it do not shrink to thumbnails.
  const lowStage = Math.min(236, Math.max(148, Math.round(viewport.height * 0.25)));
  const upright = Math.min(1, Math.max(0, (tallest - WIDE_HEIGHT) / (1 - WIDE_HEIGHT)));
  const naturalUnit = (lowStage * (1 + UPRIGHT_STAGE_GROWTH * upright)) / tallest;
  const available = viewport.width - PAGE_GUTTERS;
  const besideUnit = (available - DETAILS_GAP - DETAILS_MIN_WIDTH - gaps) / span;
  const stacked = besideUnit < naturalUnit * MIN_BESIDE_SHARE;
  const unit = Math.max(
    48,
    Math.min(naturalUnit, stacked ? (available - gaps) / span : besideUnit),
  );
  const sizes = footprints.map((footprint) => ({
    width: Math.round(footprint.width * unit),
    height: Math.round(footprint.height * unit),
  }));
  const stageHeight = Math.max(...sizes.map((size) => size.height));

  const rotationPaused = Boolean(status?.rotation_paused);
  const rotationOff =
    (config?.interval_min ?? 5) <= 0 || (!status?.auto_rotation && !rotationPaused);
  const rotationText = rotationOff
    ? t("Auto-rotation off")
    : rotationPaused
      ? t("Auto-rotation paused")
      : t("Auto-rotation active");
  const rotationAction = rotationOff
    ? t("Configure Auto Rotation")
    : rotationPaused
      ? t("Resume Auto Rotation")
      : t("Pause Auto Rotation");
  const isFavorite = Boolean(active.current_image?.startsWith("favorites/"));
  const hasImage = Boolean(active.current_image);
  const artworkInfo = currentFilename ? formatArtworkLabel(currentFilename) : null;
  const intervalLabel =
    !rotationOff && !rotationPaused && (config?.interval_min ?? 0) > 0
      ? `${config?.interval_min}m`
      : null;

  return (
    <section
      className={`now-stage flex pt-4 pb-9 ${
        stacked ? "flex-col items-start gap-6" : "items-end gap-10"
      }`}
    >
      <div
        className="stage-row"
        style={{ height: stageHeight, gap: STAGE_GAP }}
        data-solo={shown.length === 1 ? "true" : undefined}
      >
        {shown.map((monitor, index) => {
          const isActive = index === activeIndex;
          const resolution =
            monitor.width && monitor.height
              ? `${monitor.width} × ${monitor.height}`
              : t(monitor.orientation);
          return (
            <button
              key={monitor.name}
              type="button"
              onClick={() => {
                if (!isActive) {
                  onSelectMonitor(monitor.name);
                } else if (monitor.current_image && onInspectCurrent) {
                  onInspectCurrent(monitor.current_image);
                } else {
                  onLocate();
                }
              }}
              title={
                isActive
                  ? monitor.current_image && onInspectCurrent
                    ? `${t("Inspect current wallpaper")} · ${monitor.name}`
                    : `${t("Locate current wallpaper")} [G]`
                  : `${monitor.name}, ${resolution} [Shift+${index + 1}]`
              }
              aria-label={monitor.name}
              aria-pressed={isActive}
              style={sizes[index]}
              className="stage-screen"
            >
              {monitor.current_image ? (
                <CrossfadeImage src={previewUrl(monitor.current_image)} />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-ink-3">
                  <Monitor className="h-6 w-6" strokeWidth={1.5} />
                </span>
              )}

              {shown.length > 1 && (
                <span className="pointer-events-none absolute bottom-2 left-2 z-10 inline-flex h-5 items-center gap-1 rounded-full bg-black/62 px-2 text-[10.5px] font-medium tabular-nums text-white/85 backdrop-blur-md">
                  <span className="text-white/50">{index + 1}</span>
                  <span>{monitor.name}</span>
                </span>
              )}

              {isActive && monitor.current_image && onInspectCurrent && (
                <span
                  aria-hidden="true"
                  className="stage-loupe pointer-events-none absolute right-2 bottom-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/62 text-white/90 backdrop-blur-md"
                >
                  <Maximize2 className="h-3 w-3" strokeWidth={2} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 pb-0.5">
        <div key={`${active.name}-${currentFilename ?? "empty"}`} className="fade-in space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="m-0 text-[21px] leading-none font-semibold tracking-[-0.028em] text-ink">
              {active.name}
            </h1>
            <span className="text-[12.5px] tabular-nums text-ink-3">
              {t(active.orientation === "portrait" ? "Portrait" : "Landscape")}
              {active.width && active.height ? ` · ${active.width} × ${active.height}` : ""}
            </span>
          </div>

          <div className="flex min-h-[22px] flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-2">
            {!hasImage ? (
              <span className="text-ink-3">{t("Nothing showing yet")}</span>
            ) : (
              <>
                {artworkInfo && currentFilename && (
                  artworkInfo.isWallhaven && onOpenWallhaven ? (
                    <button
                      type="button"
                      onClick={() => onOpenWallhaven(currentFilename)}
                      title={t("Open on Wallhaven")}
                      className="inline-flex items-center gap-1 font-medium tabular-nums text-ink transition-colors hover:text-white"
                    >
                      <span>{artworkInfo.label}</span>
                      <ExternalLink className="h-3 w-3 text-ink-3" strokeWidth={1.75} />
                    </button>
                  ) : (
                    <span className="max-w-[220px] truncate font-medium text-ink">
                      {artworkInfo.label}
                    </span>
                  )
                )}

                {artworkResolution && (
                  <span className="tabular-nums text-ink-3">{artworkResolution}</span>
                )}

                {metadata?.category && (
                  <span className="capitalize text-ink-3">{metadata.category}</span>
                )}

                {uploaderName && (
                  onSelectUploader ? (
                    <button
                      type="button"
                      onClick={() => onSelectUploader(uploaderName)}
                      className="max-w-[180px] truncate text-ink-2 underline decoration-white/20 underline-offset-2 transition-colors hover:text-ink hover:decoration-white/60"
                    >
                      @{uploaderName}
                    </button>
                  ) : (
                    <span className="max-w-[180px] truncate text-ink-2">@{uploaderName}</span>
                  )
                )}
              </>
            )}
          </div>

          {hasImage && (paletteColors.length > 0 || curatedTags.length > 0) && (
            <div className="flex h-6 items-center gap-2 overflow-hidden pt-0.5">
              {paletteColors.length > 0 && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {paletteColors.map((hex) => {
                    const isCopied = copiedHex === hex;
                    return (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => {
                          onCopyColor?.(hex);
                          setCopiedHex(hex);
                          window.setTimeout(() => {
                            setCopiedHex((prev) => (prev === hex ? null : prev));
                          }, 1400);
                        }}
                        title={isCopied ? `${t("Copied")} ${hex}` : hex}
                        aria-label={`Copy ${hex}`}
                        style={{ backgroundColor: hex }}
                        className="flex h-3.5 w-3.5 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.26),0_1px_4px_rgb(0_0_0/0.45)] transition-transform duration-150 hover:scale-125"
                      >
                        {isCopied && (
                          <Check
                            className="h-2.5 w-2.5 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.9)]"
                            strokeWidth={3}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {paletteColors.length > 0 && curatedTags.length > 0 && (
                <span className="h-3 w-px shrink-0 bg-white/12" />
              )}

              {curatedTags.length > 0 && (
                <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                  {curatedTags.map(([normKey, displayLabel]) => (
                    <button
                      key={normKey}
                      type="button"
                      onClick={() => onSelectTag?.(normKey)}
                      className="inline-flex h-5 shrink-0 items-center rounded-full bg-white/[0.06] px-2.5 text-[11.5px] text-ink-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors hover:bg-white/[0.13] hover:text-ink"
                    >
                      {displayLabel}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <div className="flex items-center gap-1 rounded-full bg-white/[0.045] p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.055)]">
            <button
              type="button"
              onClick={onPrev}
              title={`${t("Previous wallpaper")} [H]`}
              aria-label={t("Previous wallpaper")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-white/[0.11] hover:text-ink"
            >
              <SkipBack className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onNext}
              title={`${t("Next wallpaper")} [L]`}
              className="flex h-8 shrink-0 items-center gap-2 rounded-full bg-accent pr-2.5 pl-3.5 text-[13px] font-semibold text-on-accent shadow-[0_2px_10px_rgb(0_0_0/0.35)] transition-colors hover:bg-accent-hi"
            >
              <SkipForward className="h-3.5 w-3.5 fill-current" strokeWidth={1.75} />
              {t("Next")}
              <kbd className="keycap keycap-on-accent">L</kbd>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onFavorite(!isFavorite)}
              disabled={!hasImage}
              title={`${isFavorite ? t("Unfavorite") : t("Favorite")} [F]`}
              aria-label={isFavorite ? t("Unfavorite") : t("Favorite")}
              aria-pressed={isFavorite}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                isFavorite
                  ? "bg-fav/15 text-fav shadow-[inset_0_0_0_1px_rgb(251_113_133/0.3)] hover:bg-fav/22"
                  : "bg-white/[0.06] text-ink-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.055)] hover:bg-white/[0.13] hover:text-ink"
              }`}
            >
              <Heart
                className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`}
                strokeWidth={1.75}
              />
            </button>
            <button
              type="button"
              onClick={onDislike}
              disabled={!hasImage}
              title={`${t("Dislike")} [D]`}
              aria-label={t("Dislike")}
              className={`${ROUND_BUTTON} hover:bg-drop/15! hover:text-drop! disabled:pointer-events-none disabled:opacity-40`}
            >
              <ThumbsDown className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onLocate}
              disabled={!hasImage}
              title={`${t("Locate current wallpaper")} [G]`}
              aria-label={t("Locate current wallpaper")}
              className={`${ROUND_BUTTON} disabled:pointer-events-none disabled:opacity-40`}
            >
              <LocateFixed className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onUndo}
              title={`${t("Undo last ban or dislike")} [U]`}
              aria-label={t("Undo last ban or dislike")}
              className={ROUND_BUTTON}
            >
              <Undo2 className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          <button
            type="button"
            onClick={onRotationAction}
            title={`${rotationText}, ${rotationAction}`}
            aria-label={rotationAction}
            className={`flex h-9 shrink-0 items-center gap-2 rounded-full bg-white/[0.045] px-3.5 text-[12.5px] tabular-nums shadow-[inset_0_0_0_1px_rgb(255_255_255/0.055)] transition-colors hover:bg-white/[0.1] hover:text-ink ${
              rotationOff || rotationPaused ? "text-ink-3" : "text-ink-2"
            }`}
          >
            {rotationOff ? (
              <Timer className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : rotationPaused ? (
              <span className="h-2 w-2 rounded-full bg-warn" />
            ) : (
              <span className="live-dot h-2 w-2 rounded-full bg-keep" />
            )}
            <span>{rotationText}</span>
            {intervalLabel && <span className="text-ink-3">· {intervalLabel}</span>}
          </button>
        </div>
      </div>
    </section>
  );
};
