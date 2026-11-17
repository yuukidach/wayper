import type { ImageItem, ReviewCandidateItem } from "../../shared/types";
import { decodeImage, getDecodedImage, type DecodedImage } from "./decoded-image";
import {
  defaultLightboxBounds,
  fallbackPreviewDimension,
  fitImage,
  previewDimension,
  type ImageSize,
} from "./lightbox-layout";
import { previewUrl, trashPreviewUrl } from "./media";

export type LightboxPreviewContext = "library" | "trash" | "review";
export type LightboxPreviewItem = Pick<
  ImageItem | ReviewCandidateItem,
  "path" | "name" | "orientation"
> & {
  width?: number;
  height?: number;
};

export const LIGHTBOX_OPEN_BUDGET_MS = 140;

export function findSourceTileImage(itemPath: string): HTMLImageElement | null {
  if (typeof document === "undefined" || typeof CSS === "undefined") return null;
  return document.querySelector<HTMLImageElement>(`[data-path="${CSS.escape(itemPath)}"] img`);
}

export function estimateItemAspect(
  item: Pick<LightboxPreviewItem, "path" | "orientation" | "width" | "height">,
): number {
  if (
    typeof item.width === "number" &&
    typeof item.height === "number" &&
    item.width > 0 &&
    item.height > 0
  ) {
    return item.width / item.height;
  }
  const source = findSourceTileImage(item.path);
  if (source && source.naturalWidth > 0 && source.naturalHeight > 0) {
    return source.naturalWidth / source.naturalHeight;
  }
  return item.orientation === "portrait" ? 9 / 16 : 16 / 9;
}

export function lightboxPreviewUrls(
  item: Pick<LightboxPreviewItem, "path" | "name">,
  context: LightboxPreviewContext,
  dimension: number,
): { targetUrl: string; fallbackUrl: string | null } {
  const targetUrl =
    context === "trash"
      ? trashPreviewUrl(item.name, dimension)
      : previewUrl(item.path, dimension);
  const fallbackDimension = fallbackPreviewDimension(dimension);
  const fallbackUrl =
    fallbackDimension === null
      ? null
      : context === "trash"
        ? trashPreviewUrl(item.name, fallbackDimension, true)
        : previewUrl(item.path, fallbackDimension, true);
  return { targetUrl, fallbackUrl };
}

export function estimatePreviewUrlsForViewport(
  item: LightboxPreviewItem,
  context: LightboxPreviewContext,
  bounds?: ImageSize,
): { dimension: number; targetUrl: string; fallbackUrl: string | null } {
  const stageBounds = bounds ?? defaultLightboxBounds(window.innerWidth, window.innerHeight);
  const fitted = fitImage(estimateItemAspect(item), stageBounds);
  const dimension = previewDimension(fitted, window.devicePixelRatio || 1);
  return { dimension, ...lightboxPreviewUrls(item, context, dimension) };
}

export function getReadyLightboxPreview(
  item: LightboxPreviewItem,
  context: LightboxPreviewContext,
  bounds?: ImageSize,
): DecodedImage | null {
  const { targetUrl, fallbackUrl } = estimatePreviewUrlsForViewport(item, context, bounds);
  return getDecodedImage(targetUrl) ?? (fallbackUrl ? getDecodedImage(fallbackUrl) : null);
}

export function prewarmLightboxPreview(
  item: LightboxPreviewItem,
  context: LightboxPreviewContext,
  includeFallback = true,
): {
  targetPromise: Promise<DecodedImage | null>;
  fallbackPromise: Promise<DecodedImage | null> | null;
} {
  const { targetUrl, fallbackUrl } = estimatePreviewUrlsForViewport(item, context);
  const readyTarget = getDecodedImage(targetUrl);
  const targetPromise = readyTarget ? Promise.resolve(readyTarget) : decodeImage(targetUrl);
  const fallbackPromise =
    !readyTarget && includeFallback && fallbackUrl ? decodeImage(fallbackUrl) : null;
  return { targetPromise, fallbackPromise };
}

export function waitForFirstReadyPreview(
  candidates: Array<Promise<DecodedImage | null>>,
  budgetMs: number,
): Promise<DecodedImage | null> {
  if (candidates.length === 0 || budgetMs <= 0) return Promise.resolve(null);
  return new Promise<DecodedImage | null>((resolve) => {
    let done = false;
    let remaining = candidates.length;
    const finish = (value: DecodedImage | null) => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      resolve(value);
    };
    const timer = globalThis.setTimeout(() => finish(null), budgetMs);
    for (const candidate of candidates) {
      void candidate.then((result) => {
        if (result) {
          finish(result);
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          finish(null);
        }
      });
    }
  });
}

export function prepareLightboxPreview(
  item: LightboxPreviewItem,
  context: LightboxPreviewContext,
  budgetMs = LIGHTBOX_OPEN_BUDGET_MS,
): Promise<DecodedImage | null> {
  const ready = getReadyLightboxPreview(item, context);
  if (ready) return Promise.resolve(ready);
  const { targetPromise, fallbackPromise } = prewarmLightboxPreview(item, context, true);
  const candidates = fallbackPromise ? [targetPromise, fallbackPromise] : [targetPromise];
  return waitForFirstReadyPreview(candidates, budgetMs);
}
