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
const INACTIVE_SCALE = 0.5;
const DETAILS_GAP = 40;
const DETAILS_MIN_WIDTH = 300;
const PAGE_GUTTERS = 48;

function aspectOf(monitor: MonitorInfo): number {
  if (monitor.width && monitor.height) return monitor.width / monitor.height;
  return monitor.orientation === "portrait" ? 9 / 16 : 16 / 9;
}

/** The window size, and whether it is being resized right now. */
function useViewport(): { width: number; height: number; resizing: boolean } {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    resizing: false,
  }));
  useEffect(() => {
    let settle: number | undefined;
    const update = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight, resizing: true });
      window.clearTimeout(settle);
      settle = window.setTimeout(
        () => setViewport((prev) => ({ ...prev, resizing: false })),
        160,
      );
    };
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.clearTimeout(settle);
    };
  }, []);
  return viewport;
}

/**
 * The displays as they are right now, each in its own proportions.  Picking a
 * display switches the library below to its orientation.
 *
 * Geometry is worked out here in whole pixels rather than left to layout, so a
 * switch only changes transforms: the row never changes size and the details
 * beside it slide instead of reflowing.
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
  const stageHeight = Math.min(236, Math.max(148, Math.round(viewport.height * 0.25)));
  const widths = shown.map((monitor) => Math.round(stageHeight * aspectOf(monitor)));
  const rowWidthFor = (selected: number): number =>
    widths.reduce(
      (sum, width, index) => sum + (index === selected ? width : width * INACTIVE_SCALE),
      STAGE_GAP * (shown.length - 1),
    );
  // Room for the widest arrangement, so choosing another display never resizes the row.
  const slotWidth = Math.ceil(Math.max(...widths.map((_, index) => rowWidthFor(index))));
  const stacked = viewport.width < slotWidth + DETAILS_GAP + DETAILS_MIN_WIDTH + PAGE_GUTTERS;
  const detailsShift = stacked ? 0 : Math.round(rowWidthFor(activeIndex) - slotWidth);
  const offsets: number[] = [];
  widths.reduce((offset, width, index) => {
    offsets.push(offset);
    return offset + (index === activeIndex ? width : width * INACTIVE_SCALE) + STAGE_GAP;
  }, 0);

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
      data-resizing={viewport.resizing ? "true" : undefined}
    >
      <div className="stage-row" style={{ width: slotWidth, height: stageHeight }}>
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
              style={{
                width: widths[index],
                height: stageHeight,
                transform: `translate3d(${offsets[index]}px, 0, 0) scale(${isActive ? 1 : INACTIVE_SCALE})`,
              }}
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

      <div
        className="stage-details flex min-w-0 flex-1 flex-col gap-5 pb-0.5"
        style={{ transform: `translate3d(${detailsShift}px, 0, 0)` }}
      >
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
