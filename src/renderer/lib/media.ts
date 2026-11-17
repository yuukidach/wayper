import type { ImageMetadata } from "../../shared/types";

export function thumbUrl(filePath: string): string {
  return `wayper://media/thumb?path=${encodeURIComponent(filePath)}`;
}

export function previewUrl(filePath: string, size = 1920, cachedOnly = false): string {
  const base = `wayper://media/preview?path=${encodeURIComponent(filePath)}&size=${size}`;
  return cachedOnly ? `${base}&cached=1` : base;
}

export function fullImgUrl(filePath: string): string {
  return `wayper://media/img?path=${encodeURIComponent(filePath)}`;
}

export function trashUrl(filename: string): string {
  return `wayper://media/trash?name=${encodeURIComponent(filename)}`;
}

export function trashThumbUrl(filename: string): string {
  return `wayper://media/trash-thumb?name=${encodeURIComponent(filename)}`;
}

export function trashPreviewUrl(filename: string, size = 1920, cachedOnly = false): string {
  const base = `wayper://media/trash-preview?name=${encodeURIComponent(filename)}&size=${size}`;
  return cachedOnly ? `${base}&cached=1` : base;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatTimestamp(ts: number, locale: "en" | "zh"): string {
  if (!ts) return "—";
  const ms = ts > 1e11 ? ts : ts * 1000;
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

export function extractUploaderName(metadata: ImageMetadata | null): string | null {
  if (!metadata) return null;
  if (typeof metadata.uploader === "string" && metadata.uploader.trim()) {
    return metadata.uploader.trim();
  }
  if (
    metadata.uploader &&
    typeof metadata.uploader === "object" &&
    typeof metadata.uploader.username === "string" &&
    metadata.uploader.username.trim()
  ) {
    return metadata.uploader.username.trim();
  }
  if (
    metadata.uploader_details &&
    typeof metadata.uploader_details.username === "string" &&
    metadata.uploader_details.username.trim()
  ) {
    return metadata.uploader_details.username.trim();
  }
  return null;
}

export function normalizeHexColor(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "#808080";
  return trimmed.startsWith("#") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

export function basenameFromPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}
