import React from "react";
import { LocateFixed, Pause, Play, SkipBack, SkipForward, Timer, Undo2 } from "lucide-react";
import type { ConfigPayload, MonitorInfo, StatusResponse } from "../../shared/types";
import { thumbUrl } from "../lib/media";

interface NowDockProps {
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
}

const DOCK_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink";

const TILE_HEIGHT = 40;

export const NowDock: React.FC<NowDockProps> = ({
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
}) => {
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

  return (
    <div className="glass flex items-center gap-1 rounded-[20px] p-1.5">
      {monitors.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 pr-1 pl-0.5">
            {monitors.slice(0, 9).map((mon, idx) => {
              const isActive = mon.name === activeMonitorName;
              const ratio =
                mon.width && mon.height
                  ? mon.width / mon.height
                  : mon.orientation === "portrait"
                    ? 9 / 16
                    : 16 / 9;
              const width = Math.round(Math.min(84, TILE_HEIGHT * ratio));
              const resLabel =
                mon.width && mon.height ? `${mon.width}×${mon.height}` : t(mon.orientation);
              return (
                <button
                  key={mon.name}
                  type="button"
                  onClick={() => onSelectMonitor(mon.name)}
                  title={`${mon.name} · ${resLabel} [Shift+${idx + 1}]`}
                  aria-label={mon.name}
                  aria-pressed={isActive}
                  style={{ width, height: TILE_HEIGHT }}
                  className={`shrink-0 overflow-hidden rounded-[10px] bg-white/[0.06] transition-all duration-200 ${
                    isActive
                      ? "shadow-[0_0_0_1.5px_rgb(255_255_255/0.95)]"
                      : "opacity-50 hover:opacity-100"
                  }`}
                >
                  {mon.current_image && (
                    <img
                      key={mon.current_image}
                      src={thumbUrl(mon.current_image)}
                      alt=""
                      className="fade-in h-full w-full object-cover"
                      loading="eager"
                      decoding="async"
                      draggable={false}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <span className="mx-1 h-5 w-px bg-white/[0.1]" />
        </>
      )}

      <button
        type="button"
        onClick={onPrev}
        title={`${t("Previous wallpaper")} [H]`}
        aria-label={t("Previous wallpaper")}
        className={DOCK_BUTTON}
      >
        <SkipBack className="h-[17px] w-[17px]" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onNext}
        title={`${t("Next wallpaper")} [L]`}
        aria-label={t("Next wallpaper")}
        className="flex h-10 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition-colors hover:bg-accent-hi"
      >
        <SkipForward className="h-[17px] w-[17px] fill-current" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onLocate}
        title={`${t("Locate current wallpaper")} [G]`}
        aria-label={t("Locate current wallpaper")}
        className={DOCK_BUTTON}
      >
        <LocateFixed className="h-[17px] w-[17px]" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onUndo}
        title={`${t("Undo last ban or dislike")} [U]`}
        aria-label={t("Undo last ban or dislike")}
        className={DOCK_BUTTON}
      >
        <Undo2 className="h-[17px] w-[17px]" strokeWidth={1.75} />
      </button>

      <span className="mx-1 h-5 w-px bg-white/[0.1]" />

      <button
        type="button"
        onClick={onRotationAction}
        title={`${rotationText} · ${rotationAction}`}
        aria-label={rotationAction}
        className={`flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] tabular-nums transition-colors hover:bg-white/[0.08] hover:text-ink ${
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
        {!rotationOff && config?.interval_min ? <span>{config.interval_min}m</span> : null}
      </button>
    </div>
  );
};
