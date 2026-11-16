export const NON_PREFERENCE_TAGS = new Set(["portrait", "landscape"]);

export const NON_PREFERENCE_FEATURE_TAGS = new Set([
  "portrait",
  "landscape",
  "portrait display",
  "landscape display",
  "vertical",
  "horizontal",
]);

export const SUBJECT_TAG_WORDS = new Set(["women", "men", "girls", "boys"]);

export const TAG_WORD_ALIASES: Record<string, string> = {
  woman: "women",
  man: "men",
  girl: "girls",
  boy: "boys",
};

export function casefold(value: string): string {
  return value.toLocaleLowerCase("en-US").toLowerCase();
}

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return casefold(String(value).trim()).replace(/\s+/g, " ");
}

export function normalizeTag(value: unknown): string {
  if (value === null || value === undefined) return "";
  const folded = casefold(String(value).trim());
  if (!folded) return "";
  return folded
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => TAG_WORD_ALIASES[word] ?? word)
    .join(" ");
}

export function tagItems(tags: Iterable<unknown> | Set<unknown> | null | undefined): Array<[string, string]> {
  if (!tags) return [];
  const rawList = tags instanceof Set ? [...tags].sort((a, b) => String(a).localeCompare(String(b))) : [...tags];
  const seen = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const raw of rawList) {
    if (raw === null || raw === undefined) continue;
    const rawName = typeof raw === "object" && raw !== null && "name" in raw ? (raw as { name: unknown }).name : raw;
    const key = normalizeTag(rawName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const trimmed = String(rawName).trim();
    const plainFolded = casefold(trimmed).split(/\s+/).filter(Boolean).join(" ");
    const display = plainFolded !== key ? key : trimmed;
    result.push([key, display]);
  }
  return result;
}

export function isNonPreferenceTag(value: unknown): boolean {
  return NON_PREFERENCE_TAGS.has(normalizeTag(value));
}

export function isSubjectTag(value: unknown): boolean {
  const normalized = normalizeTag(value);
  if (!normalized) return false;
  return normalized.split(" ").some((word) => SUBJECT_TAG_WORDS.has(word));
}

export function wallhavenId(filenameOrPath: string): string {
  const base = filenameOrPath.replace(/\\/g, "/").split("/").pop() ?? filenameOrPath;
  const dotIndex = base.lastIndexOf(".");
  const stem = dotIndex >= 0 ? base.slice(0, dotIndex) : base;
  const dashIndex = stem.indexOf("-");
  return dashIndex >= 0 ? stem.slice(dashIndex + 1) : stem;
}

export function wallhavenUrl(filenameOrPath: string): string {
  return `https://wallhaven.cc/w/${wallhavenId(filenameOrPath)}`;
}
