export const PREVIEW_DIMENSIONS = [1920, 2560, 3840] as const;

export function previewCacheDirectory(dimension: number): string {
  return dimension === PREVIEW_DIMENSIONS[0] ? ".previews" : `.previews/${dimension}`;
}
