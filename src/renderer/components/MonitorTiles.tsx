import React from "react";
import type { MonitorInfo } from "../../shared/types";
import { thumbUrl } from "../lib/media";
import { CrossfadeImage } from "./CrossfadeImage";

interface MonitorTilesProps {
  t: (key: string) => string;
  monitors: MonitorInfo[];
  activeMonitorName: string | null;
  onSelectMonitor: (monitorName: string) => void;
  /** Tile height in px; the width follows each display's aspect ratio. */
  height?: number;
  className?: string;
}

/**
 * The connected displays as miniatures of what each one is showing.  Picking
 * one makes it the display every wallpaper action and queue refers to.
 */
export const MonitorTiles: React.FC<MonitorTilesProps> = ({
  t,
  monitors,
  activeMonitorName,
  onSelectMonitor,
  height = 40,
  className = "",
}) => (
  <div className={`flex items-center gap-1.5 ${className}`}>
    {monitors.slice(0, 9).map((mon, idx) => {
      const isActive = mon.name === activeMonitorName;
      const ratio =
        mon.width && mon.height
          ? mon.width / mon.height
          : mon.orientation === "portrait"
            ? 9 / 16
            : 16 / 9;
      const width = Math.round(Math.min(height * 2.1, height * ratio));
      const resLabel = mon.width && mon.height ? `${mon.width}×${mon.height}` : t(mon.orientation);
      return (
        <button
          key={mon.name}
          type="button"
          onClick={() => onSelectMonitor(mon.name)}
          title={`${mon.name} · ${resLabel} [Shift+${idx + 1}]`}
          aria-label={mon.name}
          aria-pressed={isActive}
          style={{ width, height, borderRadius: Math.round(height / 4) }}
          className={`shrink-0 overflow-hidden bg-white/[0.06] transition-[opacity,box-shadow] duration-200 ${
            isActive
              ? "shadow-[0_0_0_1.5px_rgb(255_255_255/0.95)]"
              : "opacity-50 hover:opacity-100"
          }`}
        >
          {mon.current_image && (
            <CrossfadeImage src={thumbUrl(mon.current_image)} />
          )}
        </button>
      );
    })}
  </div>
);
