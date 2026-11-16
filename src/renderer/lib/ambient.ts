import { useEffect, useState } from "react";

const AMBIENT_WIDTH = 160;
const AMBIENT_HEIGHT = 100;
const ambientCache = new Map<string, string>();

/**
 * Renders the wallpaper as a tiny, already blurred bitmap.  Stretching that
 * bitmap over the window is free, unlike a live full-window CSS blur.
 */
export function renderAmbient(image: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AMBIENT_WIDTH;
    canvas.height = AMBIENT_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const bleed = 28;
    context.filter = "blur(11px) saturate(1.6)";
    context.drawImage(
      image,
      -bleed,
      -bleed,
      AMBIENT_WIDTH + bleed * 2,
      AMBIENT_HEIGHT + bleed * 2,
    );
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

export interface AmbientLight {
  source: string;
  url: string;
}

/**
 * Ambient light for one thumbnail URL.  The previous light stays up until the
 * next one is ready, so changing wallpapers cross-fades instead of blinking.
 */
export function useAmbient(source: string | null): AmbientLight | null {
  const [light, setLight] = useState<AmbientLight | null>(() => {
    const cached = source ? ambientCache.get(source) : undefined;
    return source && cached ? { source, url: cached } : null;
  });

  useEffect(() => {
    if (!source) {
      setLight(null);
      return;
    }
    const cached = ambientCache.get(source);
    if (cached) {
      setLight({ source, url: cached });
      return;
    }
    let cancelled = false;
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.decoding = "async";
    probe.onload = () => {
      const url = renderAmbient(probe);
      if (url) {
        if (ambientCache.size >= 64) {
          const oldest = ambientCache.keys().next().value;
          if (oldest !== undefined) ambientCache.delete(oldest);
        }
        ambientCache.set(source, url);
      }
      if (!cancelled) setLight(url ? { source, url } : null);
    };
    probe.onerror = () => {
      if (!cancelled) setLight(null);
    };
    probe.src = source;
    return () => {
      cancelled = true;
    };
  }, [source]);

  return light;
}
