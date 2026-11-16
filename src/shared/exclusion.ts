import { casefold, normalizeTag } from "./tags";

export interface ExclusionRulesState {
  excludeTags: string[];
  excludeCombos: string[][];
  excludeUploaders: string[];
}

export function parseComboInput(raw: string): { tags: string[]; error: string | null } {
  const parts = raw
    .split(/[+,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of parts) {
    const key = normalizeTag(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(key);
  }
  if (tags.length < 2) {
    return { tags, error: "Enter at least 2 distinct tags separated by + or ," };
  }
  return { tags, error: null };
}

export function comboIdentityKey(combo: Iterable<string>): string {
  const unique = [...new Set([...combo].map((t) => normalizeTag(t)).filter(Boolean))].sort();
  return unique.join("\u001f");
}

export function dedupeStringsCaseInsensitive(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) continue;
    const key = casefold(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function dedupeTagsNormalized(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = String(raw ?? "").trim();
    const key = normalizeTag(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function dedupeCombos(
  combos: Iterable<Iterable<string>>,
  options: { dropSupersets?: boolean } = {},
): string[][] {
  const uniqueMap = new Map<string, string[]>();
  for (const combo of combos) {
    const cleaned = dedupeTagsNormalized([...combo].map((t) => normalizeTag(t)));
    if (cleaned.length < 2) continue;
    const key = comboIdentityKey(cleaned);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, cleaned);
    }
  }
  const list = [...uniqueMap.values()];
  if (!options.dropSupersets) return list;

  const sets = list.map((c) => new Set(c.map((t) => normalizeTag(t))));
  return list.filter((_, i) => {
    const current = sets[i];
    for (let j = 0; j < sets.length; j += 1) {
      if (i === j) continue;
      const other = sets[j];
      if (other.size < current.size && [...other].every((item) => current.has(item))) {
        return false;
      }
    }
    return true;
  });
}

export function isRuleApplied(
  rules: ExclusionRulesState,
  type: "tag" | "combo" | "uploader",
  tags: string[],
): boolean {
  if (!tags.length) return false;
  if (type === "uploader") {
    const target = casefold(tags[0]);
    return rules.excludeUploaders.some((u) => casefold(u) === target);
  }
  if (type === "tag") {
    const target = normalizeTag(tags[0]);
    return rules.excludeTags.some((t) => normalizeTag(t) === target);
  }
  const key = comboIdentityKey(tags);
  return rules.excludeCombos.some((c) => comboIdentityKey(c) === key);
}
