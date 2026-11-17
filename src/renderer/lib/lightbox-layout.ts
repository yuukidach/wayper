import { PREVIEW_DIMENSIONS } from "../../shared/media";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageBounds extends ImageSize {
  left: number;
  top: number;
}

export const LIGHTBOX_STAGE_INSETS = {
  left: 64,
  right: 64,
  top: 56,
  bottom: 88,
} as const;

export function defaultLightboxBounds(viewportWidth: number, viewportHeight: number): ImageBounds {
  return {
    left: LIGHTBOX_STAGE_INSETS.left,
    top: LIGHTBOX_STAGE_INSETS.top,
    width: Math.max(1, viewportWidth - LIGHTBOX_STAGE_INSETS.left - LIGHTBOX_STAGE_INSETS.right),
    height: Math.max(1, viewportHeight - LIGHTBOX_STAGE_INSETS.top - LIGHTBOX_STAGE_INSETS.bottom),
  };
}

export function fitImage(aspect: number, bounds: ImageSize): ImageSize {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const width = Math.max(1, Math.min(bounds.width, bounds.height * safeAspect));
  return { width, height: width / safeAspect };
}

export function imageOriginTransform(source: ImageBounds, target: ImageBounds): string {
  const offsetX = source.left + source.width / 2 - target.left - target.width / 2;
  const offsetY = source.top + source.height / 2 - target.top - target.height / 2;
  const scale = Math.min(source.width / target.width, source.height / target.height);
  return `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
}

export function previewDimension(size: ImageSize, pixelRatio: number): number {
  const longest = Math.max(size.width, size.height) * pixelRatio;
  return PREVIEW_DIMENSIONS.find((dimension) => dimension >= longest) ?? PREVIEW_DIMENSIONS[2];
}

export function fallbackPreviewDimension(targetDimension: number): number | null {
  const index = PREVIEW_DIMENSIONS.indexOf(targetDimension as (typeof PREVIEW_DIMENSIONS)[number]);
  return index > 0 ? PREVIEW_DIMENSIONS[index - 1] : null;
}
