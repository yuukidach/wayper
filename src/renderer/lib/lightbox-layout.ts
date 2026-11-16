import { PREVIEW_DIMENSIONS } from "../../shared/media";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageBounds extends ImageSize {
  left: number;
  top: number;
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
