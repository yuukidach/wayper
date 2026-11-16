import React, { useEffect, useState } from "react";
import {
  Heart,
  Monitor,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ThumbsDown,
  Timer,
  Undo2,
} from "lucide-react";
import type { ConfigPayload, MonitorInfo, StatusResponse } from "../../shared/types";
import { previewUrl } from "../lib/media";

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
}

const ROUND_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-ink-2 transition-colors hover:bg-white/[0.14] hover:text-ink";

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
}) => {
  const viewport = useViewport();
  const active = monitors.find((monitor) => monitor.name === activeMonitorName) ?? monitors[0];
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
              onClick={() => (isActive ? onLocate() : onSelectMonitor(monitor.name))}
              title={
                isActive
                  ? `${t("Locate current wallpaper")} [G]`
                  : `${monitor.name}, ${resolution} [Shift+${index + 1}]`
              }
              aria-label={monitor.name}
              aria-pressed={isActive}
              style={sizes[index]}
              className="stage-screen"
            >
              {monitor.current_image ? (
                <img
                  key={monitor.current_image}
                  src={previewUrl(monitor.current_image)}
                  alt=""
                  className="fade-in h-full w-full object-cover"
                  decoding="async"
                  draggable={false}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-ink-3">
                  <Monitor className="h-6 w-6" strokeWidth={1.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5 pb-0.5">
        <div key={active.name} className="fade-in">
          <h1 className="m-0 text-[22px] leading-none font-semibold tracking-[-0.03em] text-ink">
            {active.name}
          </h1>
          <p className="m-0 mt-2 text-[13px] tabular-nums text-ink-2">
            {t(active.orientation === "portrait" ? "Portrait" : "Landscape")}
            {active.width && active.height ? (
              <span className="ml-2.5 text-ink-3">{`${active.width} × ${active.height}`}</span>
            ) : null}
            {!hasImage && <span className="ml-3 text-ink-3">{t("Nothing showing yet")}</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onPrev}
              title={`${t("Previous wallpaper")} [H]`}
              aria-label={t("Previous wallpaper")}
              className={ROUND_BUTTON}
            >
              <SkipBack className="h-[17px] w-[17px]" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onNext}
              title={`${t("Next wallpaper")} [L]`}
              className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-accent pr-2.5 pl-4 text-[13.5px] font-semibold text-on-accent transition-colors hover:bg-accent-hi"
            >
              <SkipForward className="h-4 w-4 fill-current" strokeWidth={1.75} />
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
              className={`${ROUND_BUTTON} disabled:pointer-events-none disabled:opacity-40`}
            >
              <Heart
                className={`h-[17px] w-[17px] ${isFavorite ? "fill-current text-ink" : ""}`}
                strokeWidth={1.75}
              />
            </button>
            <button
              type="button"
              onClick={onDislike}
              disabled={!hasImage}
              title={`${t("Dislike")} [D]`}
              aria-label={t("Dislike")}
              className={`${ROUND_BUTTON} disabled:pointer-events-none disabled:opacity-40`}
            >
              <ThumbsDown className="h-[17px] w-[17px]" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onUndo}
              title={`${t("Undo last ban or dislike")} [U]`}
              aria-label={t("Undo last ban or dislike")}
              className={ROUND_BUTTON}
            >
              <Undo2 className="h-[17px] w-[17px]" strokeWidth={1.75} />
            </button>
          </div>

          <button
            type="button"
            onClick={onRotationAction}
            title={`${rotationText}, ${rotationAction}`}
            aria-label={rotationAction}
            className={`flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] tabular-nums transition-colors hover:bg-white/[0.1] hover:text-ink ${
              rotationOff || rotationPaused ? "text-ink-3" : "text-ink-2"
            }`}
          >
            {rotationOff ? (
              <Timer className="h-[17px] w-[17px]" strokeWidth={1.75} />
            ) : rotationPaused ? (
              <Play className="h-[17px] w-[17px]" strokeWidth={1.75} />
            ) : (
              <Pause className="h-[17px] w-[17px]" strokeWidth={1.75} />
            )}
            <span>{rotationText}</span>
          </button>
        </div>
      </div>
    </section>
  );
};
