export type GalleryDensity = "compact" | "standard" | "gallery";
export type GalleryFraming = "fill" | "matte";

export interface GalleryPreferences {
  density: GalleryDensity;
  framing: GalleryFraming;
}

const STORAGE_KEY = "wayper.galleryPrefs.v1";

export const DEFAULT_GALLERY_PREFS: GalleryPreferences = {
  density: "standard",
  framing: "fill",
};

export function loadGalleryPreferences(): GalleryPreferences {
  if (typeof window === "undefined") return DEFAULT_GALLERY_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GALLERY_PREFS;
    const parsed = JSON.parse(raw) as Partial<GalleryPreferences>;
    const density: GalleryDensity =
      parsed.density === "compact" || parsed.density === "standard" || parsed.density === "gallery"
        ? parsed.density
        : "standard";
    const framing: GalleryFraming = parsed.framing === "matte" ? "matte" : "fill";
    return { density, framing };
  } catch {
    return DEFAULT_GALLERY_PREFS;
  }
}

export function saveGalleryPreferences(prefs: GalleryPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}
