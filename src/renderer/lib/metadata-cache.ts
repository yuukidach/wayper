import { useEffect, useState } from "react";
import type { ImageMetadata } from "../../shared/types";
import { basenameFromPath } from "./media";

const MAX_METADATA_CACHE = 240;
const metadataCache = new Map<string, ImageMetadata | null>();
const inflightMetadata = new Map<string, Promise<ImageMetadata | null>>();

function normalizeMetadataKey(filenameOrPath: string | null | undefined): string | null {
  if (!filenameOrPath) return null;
  const base = basenameFromPath(filenameOrPath).trim();
  return base || null;
}

function rememberMetadata(key: string, value: ImageMetadata | null): ImageMetadata | null {
  metadataCache.delete(key);
  metadataCache.set(key, value);
  while (metadataCache.size > MAX_METADATA_CACHE) {
    const oldest = metadataCache.keys().next().value;
    if (oldest === undefined) break;
    metadataCache.delete(oldest);
  }
  return value;
}

export function getCachedImageMetadata(
  filenameOrPath: string | null | undefined,
): ImageMetadata | null | undefined {
  const key = normalizeMetadataKey(filenameOrPath);
  if (!key || !metadataCache.has(key)) return undefined;
  const value = metadataCache.get(key) ?? null;
  metadataCache.delete(key);
  metadataCache.set(key, value);
  return value;
}

export function fetchImageMetadataCached(
  filenameOrPath: string | null | undefined,
): Promise<ImageMetadata | null> {
  const key = normalizeMetadataKey(filenameOrPath);
  if (!key) return Promise.resolve(null);
  if (metadataCache.has(key)) {
    return Promise.resolve(getCachedImageMetadata(key) ?? null);
  }
  const existing = inflightMetadata.get(key);
  if (existing) return existing;

  const request = window.wayper
    .getImageMetadata(key)
    .then((res) => rememberMetadata(key, res ?? null))
    .catch(() => rememberMetadata(key, null))
    .finally(() => {
      inflightMetadata.delete(key);
    });

  inflightMetadata.set(key, request);
  return request;
}

export function useImageMetadata(
  filenameOrPath: string | null | undefined,
  enabled = true,
): { metadata: ImageMetadata | null; loading: boolean } {
  const key = enabled ? normalizeMetadataKey(filenameOrPath) : null;
  const cached = key ? getCachedImageMetadata(key) : undefined;
  const [state, setState] = useState<{
    key: string | null;
    metadata: ImageMetadata | null;
    loading: boolean;
  }>(() => ({
    key,
    metadata: cached ?? null,
    loading: Boolean(key && cached === undefined),
  }));

  useEffect(() => {
    if (!key) {
      setState({ key: null, metadata: null, loading: false });
      return;
    }
    const hit = getCachedImageMetadata(key);
    if (hit !== undefined) {
      setState({ key, metadata: hit, loading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({
      key,
      metadata: prev.key === key ? prev.metadata : null,
      loading: true,
    }));
    void fetchImageMetadataCached(key).then((res) => {
      if (!cancelled) {
        setState({ key, metadata: res, loading: false });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!key) return { metadata: null, loading: false };
  if (cached !== undefined) return { metadata: cached, loading: false };
  return state.key === key ? { metadata: state.metadata, loading: state.loading } : { metadata: null, loading: true };
}
