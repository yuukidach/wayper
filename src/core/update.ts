import { httpFetch } from "./http";
import type { UpdateCheckResponse } from "../shared/types";
import { WAYPER_VERSION } from "../shared/version";
import type { WayperConfig } from "./config";

export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/yuukidach/wayper/releases/latest";
export const RELEASES_URL = "https://github.com/yuukidach/wayper/releases/latest";
export const DEFAULT_UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const VERSION_PART_RE = /\d+|[a-zA-Z]+/g;

type VersionToken = readonly [0, string] | readonly [1, number];

interface ParsedVersionKey {
  baseParts: VersionToken[];
  prereleaseWeight: 0 | 1;
  prereleaseParts: VersionToken[];
}

let cachedResult: UpdateCheckResponse | null = null;
let cachedAtMs = 0;

export function resetUpdateCache(): void {
  cachedResult = null;
  cachedAtMs = 0;
}

export function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function tokenizeSegment(segment: string): VersionToken[] {
  const parts: VersionToken[] = [];
  const matches = segment.match(VERSION_PART_RE);
  if (!matches) return parts;
  for (const part of matches) {
    if (/^\d+$/.test(part)) {
      parts.push([1, Number.parseInt(part, 10)]);
    } else {
      parts.push([0, part.toLowerCase()]);
    }
  }
  return parts;
}

function buildVersionKey(version: string): ParsedVersionKey {
  const normalized = normalizeVersion(version);
  const core = normalized.split("+", 1)[0] ?? "";
  const dashIdx = core.indexOf("-");
  const base = dashIdx >= 0 ? core.slice(0, dashIdx) : core;
  const prerelease = dashIdx >= 0 ? core.slice(dashIdx + 1) : "";

  const baseParts: VersionToken[] = [];
  for (const chunk of base.split(".")) {
    baseParts.push(...tokenizeSegment(chunk));
  }
  while (baseParts.length < 3) {
    baseParts.push([1, 0]);
  }

  const prereleaseWeight: 0 | 1 = prerelease ? 0 : 1;
  const prereleaseParts = prerelease ? tokenizeSegment(prerelease) : [];
  return { baseParts, prereleaseWeight, prereleaseParts };
}

function compareTokenLists(a: readonly VersionToken[], b: readonly VersionToken[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ta = a[i];
    const tb = b[i];
    if (ta[0] !== tb[0]) {
      return ta[0] - tb[0];
    }
    if (ta[0] === 1 && tb[0] === 1) {
      if (ta[1] !== tb[1]) return ta[1] - tb[1];
    } else if (ta[0] === 0 && tb[0] === 0) {
      if (ta[1] < tb[1]) return -1;
      if (ta[1] > tb[1]) return 1;
    }
  }
  return a.length - b.length;
}

export function compareVersions(a: string, b: string): number {
  const ka = buildVersionKey(a);
  const kb = buildVersionKey(b);
  const baseCmp = compareTokenLists(ka.baseParts, kb.baseParts);
  if (baseCmp !== 0) return baseCmp;
  if (ka.prereleaseWeight !== kb.prereleaseWeight) {
    return ka.prereleaseWeight - kb.prereleaseWeight;
  }
  return compareTokenLists(ka.prereleaseParts, kb.prereleaseParts);
}

export function isNewerVersion(candidate: string, current: string = WAYPER_VERSION): boolean {
  return compareVersions(candidate, current) > 0;
}

export interface CheckForUpdatesOptions {
  force?: boolean;
  cacheTtlMs?: number;
  nowMs?: number;
  fetchFn?: typeof fetch;
}

export async function checkForUpdates(
  config?: Pick<WayperConfig, "proxy"> | null,
  options?: CheckForUpdatesOptions,
): Promise<UpdateCheckResponse> {
  const force = options?.force ?? false;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_UPDATE_CACHE_TTL_MS;
  const nowMs = options?.nowMs ?? performance.now();

  if (!force && cachedResult !== null && cachedResult.error === null && nowMs - cachedAtMs < cacheTtlMs) {
    return { ...cachedResult };
  }

  const checkedAt = new Date().toISOString();
  const proxy = config?.proxy ?? null;
  const fetchImpl: typeof fetch =
    options?.fetchFn ??
    ((input, init) =>
      httpFetch(String(input), {
        method: init?.method,
        headers: init?.headers as Record<string, string> | undefined,
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
        timeoutMs: 8_000,
        proxy,
      }));

  let result: UpdateCheckResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `wayper/${WAYPER_VERSION}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const latest = String(data.tag_name ?? "").trim();
    const releaseUrl = typeof data.html_url === "string" && data.html_url ? data.html_url : RELEASES_URL;
    const releaseName = typeof data.name === "string" ? data.name : null;
    const publishedAt = typeof data.published_at === "string" ? data.published_at : null;

    result = {
      current_version: WAYPER_VERSION,
      latest_version: latest || null,
      update_available: Boolean(latest && isNewerVersion(latest, WAYPER_VERSION)),
      release_url: releaseUrl,
      release_name: releaseName,
      published_at: publishedAt,
      checked_at: checkedAt,
      error: null,
    };
  } catch (error) {
    result = {
      current_version: WAYPER_VERSION,
      latest_version: null,
      update_available: false,
      release_url: RELEASES_URL,
      release_name: null,
      published_at: null,
      checked_at: checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.error === null) {
    cachedResult = result;
    cachedAtMs = nowMs;
  }
  return { ...result };
}
