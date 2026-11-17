import { useEffect, useState } from "react";

export interface DecodedImage {
  source: string;
  width: number;
  height: number;
}

interface CachedEntry {
  decoded: DecodedImage;
  element: HTMLImageElement;
  pixels: number;
}

const MAX_CACHE_ENTRIES = 20;
const MAX_CACHE_PIXELS = 128_000_000;

const decodedCache = new Map<string, CachedEntry>();
const inflightDecodes = new Map<string, Promise<DecodedImage | null>>();
let cachedPixels = 0;

function touchCachedEntry(source: string, entry: CachedEntry): DecodedImage {
  decodedCache.delete(source);
  decodedCache.set(source, entry);
  return entry.decoded;
}

function evictOverflow(): void {
  while (
    decodedCache.size > MAX_CACHE_ENTRIES ||
    (decodedCache.size > 1 && cachedPixels > MAX_CACHE_PIXELS)
  ) {
    const oldestKey = decodedCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = decodedCache.get(oldestKey);
    decodedCache.delete(oldestKey);
    if (oldest) {
      cachedPixels = Math.max(0, cachedPixels - oldest.pixels);
    }
  }
}

export function getDecodedImage(source: string | null): DecodedImage | null {
  if (!source) return null;
  const hit = decodedCache.get(source);
  return hit ? touchCachedEntry(source, hit) : null;
}

export function decodeImage(source: string): Promise<DecodedImage | null> {
  const cached = getDecodedImage(source);
  if (cached) return Promise.resolve(cached);
  const existing = inflightDecodes.get(source);
  if (existing) return existing;

  const task = new Promise<DecodedImage | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.src = source;
    image
      .decode()
      .then(() => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          resolve(null);
          return;
        }
        const decoded: DecodedImage = {
          source,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
        const pixels = decoded.width * decoded.height;
        const previous = decodedCache.get(source);
        if (previous) {
          cachedPixels = Math.max(0, cachedPixels - previous.pixels);
          decodedCache.delete(source);
        }
        decodedCache.set(source, { decoded, element: image, pixels });
        cachedPixels += pixels;
        evictOverflow();
        resolve(decoded);
      })
      .catch(() => {
        resolve(null);
      });
  }).finally(() => {
    inflightDecodes.delete(source);
  });

  inflightDecodes.set(source, task);
  return task;
}

export function clearDecodedImageCache(): void {
  decodedCache.clear();
  inflightDecodes.clear();
  cachedPixels = 0;
}

export function useDecodedImage(source: string | null): DecodedImage | null {
  const cached = getDecodedImage(source);
  const [decoded, setDecoded] = useState<DecodedImage | null>(() => cached);

  useEffect(() => {
    if (!source) return;
    const immediate = getDecodedImage(source);
    if (immediate) {
      setDecoded(immediate);
      return;
    }
    let cancelled = false;
    void decodeImage(source).then((result) => {
      if (!cancelled && result) {
        setDecoded(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return cached ?? (decoded?.source === source ? decoded : null);
}
