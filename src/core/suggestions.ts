import {
  casefold,
  isNonPreferenceTag,
  isSubjectTag,
  NON_PREFERENCE_TAGS,
  normalizeTag,
  SUBJECT_TAG_WORDS,
  TAG_WORD_ALIASES,
  tagItems,
} from "../shared/tags";
import type {
  ComboSuggestionItem,
  ImageMetadata,
  TagSuggestionItem,
  UploaderSuggestionItem,
} from "../shared/types";
import {
  codePointCompare,
  FAVORITE_WEIGHT,
  ImageCatalog,
  KEPT_WEIGHT,
  netBenefit,
  pyRound,
} from "./catalog";

export const FAV_WEIGHT = FAVORITE_WEIGHT;
export {
  KEPT_WEIGHT,
  NON_PREFERENCE_TAGS,
  SUBJECT_TAG_WORDS,
  TAG_WORD_ALIASES,
  isNonPreferenceTag,
  isSubjectTag,
  normalizeTag,
};

export const MIN_SUGGESTION_PRECISION = 0.9;
export const MAX_SUGGESTION_KEPT = 5;
export const MAX_SUGGESTION_KEPT_RATIO = 0.05;
export const BROAD_TAG_MIN_KEPT = 20;

export function isBroadPositiveTag(banned: number, kept: number, favorites: number): boolean {
  if (favorites > 0 || kept >= BROAD_TAG_MIN_KEPT) {
    return true;
  }
  const total = banned + kept;
  return kept > MAX_SUGGESTION_KEPT && total > 0 && kept / total >= 0.1;
}

export function passesPositiveFeedbackGuard(
  banned: number,
  kept: number,
  favorites: number,
  options?: { minPrecision?: number },
): boolean {
  const minPrecision = options?.minPrecision ?? MIN_SUGGESTION_PRECISION;
  if (banned <= 0 || favorites > 0) {
    return false;
  }
  const total = banned + kept + FAV_WEIGHT * favorites;
  if (banned / total < minPrecision) {
    return false;
  }
  if (kept > MAX_SUGGESTION_KEPT && kept / banned > MAX_SUGGESTION_KEPT_RATIO) {
    return false;
  }
  if (isBroadPositiveTag(banned, kept, favorites)) {
    return false;
  }
  return true;
}

function extractTagSet(tags: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const [key] of tagItems(tags)) {
    out.add(key);
  }
  return out;
}

function normalizeExclusionRules(
  excludedTags: readonly string[],
  excludedCombos?: readonly (readonly string[])[] | null,
): { tags: Set<string>; combos: Set<string>[] } {
  const tags = new Set<string>();
  for (const raw of excludedTags) {
    const key = normalizeTag(raw);
    if (key) tags.add(key);
  }
  const combos: Set<string>[] = [];
  for (const values of excludedCombos ?? []) {
    const set = extractTagSet(values);
    if (set.size > 0) {
      combos.push(set);
    }
  }
  return { tags, combos };
}

function isSubsetOf<T>(sub: ReadonlySet<T>, sup: ReadonlySet<T>): boolean {
  if (sub.size > sup.size) return false;
  for (const item of sub) {
    if (!sup.has(item)) return false;
  }
  return true;
}

function matchesExclusion(
  imageTags: ReadonlySet<string>,
  excludedTags: ReadonlySet<string>,
  excludedCombos: readonly ReadonlySet<string>[],
): boolean {
  for (const ex of excludedTags) {
    if (imageTags.has(ex)) return true;
  }
  for (const combo of excludedCombos) {
    if (isSubsetOf(combo, imageTags)) return true;
  }
  return false;
}

function coveredBannedFiles(
  catalog: ImageCatalog,
  excludedTags: ReadonlySet<string>,
  excludedCombos: readonly ReadonlySet<string>[],
): Set<string> {
  const covered = new Set<string>();
  for (const record of catalog) {
    if (record.banned && matchesExclusion(record.tags, excludedTags, excludedCombos)) {
      covered.add(record.filename);
    }
  }
  return covered;
}

function intersectSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const item of smaller) {
    if (larger.has(item)) count += 1;
  }
  return count;
}

export function suggestTagsToExclude(
  metadata: Record<string, ImageMetadata>,
  blacklisted: Iterable<string>,
  excludedTags: readonly string[],
  excludedCombos?: readonly (readonly string[])[] | null,
  favorites?: Iterable<string> | null,
  options?: { maxResults?: number },
): TagSuggestionItem[] {
  const blacklistedSet = blacklisted instanceof Set ? blacklisted : new Set(blacklisted);
  if (blacklistedSet.size === 0) {
    return [];
  }
  const maxResults = options?.maxResults ?? 10;
  const favSet = favorites ? (favorites instanceof Set ? favorites : new Set(favorites)) : new Set<string>();
  const catalog = new ImageCatalog(metadata, blacklistedSet, favSet);
  const { tags: excludedLower, combos: comboSetsLower } = normalizeExclusionRules(
    excludedTags,
    excludedCombos,
  );

  interface PurityGroup {
    dislikeTags: Map<string, number>;
    poolTags: Map<string, number>;
    dislikeTotal: number;
    poolTotal: number;
  }

  const purityGroups = new Map<string, PurityGroup>();
  const tagDislikeImages = new Map<string, Set<string>>();
  const tagDisplay = new Map<string, string>();
  const globalKept = new Map<string, number>();
  const globalFav = new Map<string, number>();

  for (const record of catalog) {
    let group = purityGroups.get(record.purity);
    if (!group) {
      group = {
        dislikeTags: new Map(),
        poolTags: new Map(),
        dislikeTotal: 0,
        poolTotal: 0,
      };
      purityGroups.set(record.purity, group);
    }

    if (record.banned) {
      group.dislikeTotal += 1;
      for (const tag of record.orderedTags) {
        if (!tagDisplay.has(tag)) {
          tagDisplay.set(tag, catalog.displayTag(tag));
        }
        group.dislikeTags.set(tag, (group.dislikeTags.get(tag) ?? 0) + 1);
        let imgSet = tagDislikeImages.get(tag);
        if (!imgSet) {
          imgSet = new Set();
          tagDislikeImages.set(tag, imgSet);
        }
        imgSet.add(record.filename);
      }
    } else {
      group.poolTotal += 1;
      for (const tag of record.orderedTags) {
        if (!tagDisplay.has(tag)) {
          tagDisplay.set(tag, catalog.displayTag(tag));
        }
        group.poolTags.set(tag, (group.poolTags.get(tag) ?? 0) + 1);
        globalKept.set(tag, (globalKept.get(tag) ?? 0) + 1);
        if (record.favorite) {
          globalFav.set(tag, (globalFav.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  const excludedUnion = coveredBannedFiles(catalog, excludedLower, comboSetsLower);

  const globalBan = new Map<string, number>();
  for (const group of purityGroups.values()) {
    if (group.dislikeTotal < 3 || group.poolTotal < 30) {
      continue;
    }
    const totalImages = group.dislikeTotal + group.poolTotal;
    for (const [tag, banCount] of group.dislikeTags) {
      if (banCount < 3 || excludedLower.has(tag) || isNonPreferenceTag(tag)) {
        continue;
      }
      const poolCount = group.poolTags.get(tag) ?? 0;
      const totalWithTag = banCount + poolCount;
      if (totalWithTag / totalImages > 0.25) {
        continue;
      }
      globalBan.set(tag, (globalBan.get(tag) ?? 0) + banCount);
    }
  }

  const results: TagSuggestionItem[] = [];
  for (const [tag, banCount] of globalBan) {
    if (banCount < 3) continue;
    const keptCount = globalKept.get(tag) ?? 0;
    const favCount = globalFav.get(tag) ?? 0;
    const benefit = netBenefit(banCount, keptCount, favCount);
    if (benefit <= 0 || !passesPositiveFeedbackGuard(banCount, keptCount, favCount)) {
      continue;
    }
    const display = tagDisplay.get(tag) ?? tag;
    const imgs = tagDislikeImages.get(normalizeTag(display));
    if (imgs && imgs.size > 0 && excludedUnion.size > 0) {
      if (intersectSize(imgs, excludedUnion) / imgs.size > 0.5) {
        continue;
      }
    }
    results.push({
      tag: display,
      count: banCount,
      banned: banCount,
      kept: keptCount,
      favorites: favCount,
      net_benefit: pyRound(benefit, 1),
    });
  }

  results.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (b.net_benefit ?? 0) - (a.net_benefit ?? 0);
  });
  return results.slice(0, maxResults);
}

export function suggestComboRefinements(
  metadata: Record<string, ImageMetadata>,
  blacklisted: Iterable<string>,
  contextTags: readonly string[],
  excludedTags: readonly string[],
  excludedCombos: readonly (readonly string[])[],
  favorites?: Iterable<string> | null,
  options?: { maxResults?: number },
): TagSuggestionItem[] {
  const blacklistedSet = blacklisted instanceof Set ? blacklisted : new Set(blacklisted);
  if (blacklistedSet.size === 0 || contextTags.length === 0) {
    return [];
  }
  const maxResults = options?.maxResults ?? 8;
  const favSet = favorites ? (favorites instanceof Set ? favorites : new Set(favorites)) : new Set<string>();
  const catalog = new ImageCatalog(metadata, blacklistedSet, favSet);

  const contextLower = new Set<string>();
  for (const t of contextTags) {
    const norm = normalizeTag(t);
    if (norm) contextLower.add(norm);
  }
  if (contextLower.size === 0) {
    return [];
  }

  const { tags: excludedLower, combos: comboSetsLower } = normalizeExclusionRules(
    excludedTags,
    excludedCombos,
  );
  const existingCombos: Set<string>[] = [];
  for (const combo of excludedCombos) {
    const cSet = new Set<string>();
    for (const t of combo) {
      const norm = normalizeTag(t);
      if (norm) cSet.add(norm);
    }
    if (cSet.size > 0) existingCombos.push(cSet);
  }
  const excludedUnion = coveredBannedFiles(catalog, excludedLower, comboSetsLower);

  const dislikeRecords: Array<{ filename: string; tags: readonly string[] }> = [];
  const poolSubset: Array<{ filename: string; tags: readonly string[]; favorite: boolean }> = [];

  for (const record of catalog) {
    if (!isSubsetOf(contextLower, record.tags)) {
      continue;
    }
    if (record.banned) {
      dislikeRecords.push({ filename: record.filename, tags: record.orderedTags });
    } else {
      poolSubset.push({
        filename: record.filename,
        tags: record.orderedTags,
        favorite: favSet.has(record.filename),
      });
    }
  }

  if (dislikeRecords.length < 2) {
    return [];
  }

  const dislikeCounts = new Map<string, number>();
  const tagDislikeImages = new Map<string, Set<string>>();
  const poolCounts = new Map<string, number>();
  const poolFavorites = new Map<string, number>();
  const tagDisplay = new Map<string, string>();

  for (const { filename, tags } of dislikeRecords) {
    for (const tag of tags) {
      if (!tagDisplay.has(tag)) tagDisplay.set(tag, catalog.displayTag(tag));
      if (!contextLower.has(tag)) {
        dislikeCounts.set(tag, (dislikeCounts.get(tag) ?? 0) + 1);
        let imgSet = tagDislikeImages.get(tag);
        if (!imgSet) {
          imgSet = new Set();
          tagDislikeImages.set(tag, imgSet);
        }
        imgSet.add(filename);
      }
    }
  }

  for (const { tags, favorite } of poolSubset) {
    for (const tag of tags) {
      if (!tagDisplay.has(tag)) tagDisplay.set(tag, catalog.displayTag(tag));
      if (!contextLower.has(tag)) {
        poolCounts.set(tag, (poolCounts.get(tag) ?? 0) + 1);
        if (favorite) {
          poolFavorites.set(tag, (poolFavorites.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  const dTotal = dislikeRecords.length;
  const pTotal = Math.max(poolSubset.length, 1);
  const results: TagSuggestionItem[] = [];

  for (const [tag, count] of dislikeCounts) {
    if (count < 2 || excludedLower.has(tag) || isNonPreferenceTag(tag)) {
      continue;
    }
    const candidateCombo = new Set<string>([...contextLower, tag]);
    if (existingCombos.some((ec) => isSubsetOf(ec, candidateCombo))) {
      continue;
    }
    const imgs = tagDislikeImages.get(tag);
    if (imgs && imgs.size > 0 && excludedUnion.size > 0) {
      if (intersectSize(imgs, excludedUnion) / imgs.size > 0.5) {
        continue;
      }
    }
    const poolCount = poolCounts.get(tag) ?? 0;
    const favCount = poolFavorites.get(tag) ?? 0;
    if (!passesPositiveFeedbackGuard(count, poolCount, favCount)) {
      continue;
    }
    const dislikeRate = count / dTotal;
    const poolRate = poolCount / pTotal;
    const ratio = dislikeRate / Math.max(poolRate, 0.001);
    if (ratio > 1.5) {
      results.push({
        tag: tagDisplay.get(tag) ?? tag,
        count,
        banned: count,
        kept: poolCount,
        favorites: favCount,
        ratio: pyRound(ratio, 1),
      });
    }
  }

  results.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (b.ratio ?? 0) - (a.ratio ?? 0);
  });
  return results.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Fast Uint32Array Bitset helpers for contrast pattern mining
// ---------------------------------------------------------------------------

function popcount32(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function bitsetCount(mask: Uint32Array | undefined): number {
  if (!mask) return 0;
  let total = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const word = mask[i];
    if (word !== 0) total += popcount32(word);
  }
  return total;
}

function bitsetAnd(a: Uint32Array | undefined, b: Uint32Array | undefined, wordLen: number): Uint32Array {
  const out = new Uint32Array(wordLen);
  if (!a || !b) return out;
  for (let i = 0; i < wordLen; i += 1) {
    out[i] = a[i] & b[i];
  }
  return out;
}

function bitsetAndCount(a: Uint32Array | undefined, b: Uint32Array | undefined): number {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) {
    const word = a[i] & b[i];
    if (word !== 0) total += popcount32(word);
  }
  return total;
}

function setKey(tags: readonly string[]): string {
  return [...new Set(tags)].sort(codePointCompare).join("\u001f");
}

export function suggestComboPatterns(
  metadata: Record<string, ImageMetadata>,
  blacklisted: Iterable<string>,
  excludedTags: readonly string[],
  excludedCombos?: readonly (readonly string[])[] | null,
  favorites?: Iterable<string> | null,
  options?: { maxResults?: number },
): ComboSuggestionItem[] {
  const blacklistedSet = blacklisted instanceof Set ? blacklisted : new Set(blacklisted);
  if (blacklistedSet.size === 0) {
    return [];
  }

  const MIN_SUPPORT = 3;
  const MIN_PRECISION = MIN_SUGGESTION_PRECISION;
  const maxResults = options?.maxResults ?? 8;

  const favSet = favorites ? (favorites instanceof Set ? favorites : new Set(favorites)) : new Set<string>();
  const catalog = new ImageCatalog(metadata, blacklistedSet, favSet);
  if (catalog.size === 0) {
    return [];
  }

  const { tags: excludedLower, combos: comboSetsLower } = normalizeExclusionRules(
    excludedTags,
    excludedCombos,
  );

  const existingCombosKeys = new Set<string>();
  const existingPairCombos: Set<string>[] = [];
  for (const combo of excludedCombos ?? []) {
    const norm = [...new Set(combo.map((t) => normalizeTag(t)).filter(Boolean))];
    if (norm.length > 0) {
      existingCombosKeys.add(setKey(norm));
      if (norm.length <= 2) {
        existingPairCombos.push(new Set(norm));
      }
    }
  }

  const wordLen = Math.ceil(catalog.size / 32);
  const bannedTagMasks = new Map<string, Uint32Array>();
  const keptTagMasks = new Map<string, Uint32Array>();
  const favTagMasks = new Map<string, Uint32Array>();
  const tagDisplay = new Map<string, string>();
  const excludedUnionMask = new Uint32Array(wordLen);
  let hasExcludedUnion = false;

  const ensureMask = (map: Map<string, Uint32Array>, key: string): Uint32Array => {
    let mask = map.get(key);
    if (!mask) {
      mask = new Uint32Array(wordLen);
      map.set(key, mask);
    }
    return mask;
  };

  let imageIdx = 0;
  for (const record of catalog) {
    const wordIdx = imageIdx >>> 5;
    const bit = 1 << (imageIdx & 31);
    imageIdx += 1;

    for (const tag of record.orderedTags) {
      if (!tagDisplay.has(tag)) {
        tagDisplay.set(tag, catalog.displayTag(tag));
      }
    }
    if (record.banned) {
      if (matchesExclusion(record.tags, excludedLower, comboSetsLower)) {
        excludedUnionMask[wordIdx] |= bit;
        hasExcludedUnion = true;
      }
      for (const tag of record.orderedTags) {
        ensureMask(bannedTagMasks, tag)[wordIdx] |= bit;
      }
    } else {
      for (const tag of record.orderedTags) {
        ensureMask(keptTagMasks, tag)[wordIdx] |= bit;
        if (record.favorite) {
          ensureMask(favTagMasks, tag)[wordIdx] |= bit;
        }
      }
    }
  }

  const bannedTagCounts = new Map<string, number>();
  for (const [tag, mask] of bannedTagMasks) {
    bannedTagCounts.set(tag, bitsetCount(mask));
  }

  const allKnownTags = new Set<string>([...bannedTagMasks.keys(), ...keptTagMasks.keys()]);
  const broadPositiveTags = new Set<string>();
  for (const tag of allKnownTags) {
    const bCount = bannedTagCounts.get(tag) ?? 0;
    const kCount = bitsetCount(keptTagMasks.get(tag));
    const fCount = bitsetCount(favTagMasks.get(tag));
    if (isBroadPositiveTag(bCount, kCount, fCount)) {
      broadPositiveTags.add(tag);
    }
  }

  const candidateTags = [...bannedTagCounts.entries()]
    .filter(
      ([tag, count]) =>
        count >= MIN_SUPPORT && !excludedLower.has(tag) && !isNonPreferenceTag(tag),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 150)
    .map(([tag]) => tag);

  interface PairRecord {
    combo: ComboSuggestionItem;
    banMask: Uint32Array;
    keptMask: Uint32Array;
    favMask: Uint32Array;
  }

  const pairRecords: PairRecord[] = [];

  for (let i = 0; i < candidateTags.length; i += 1) {
    const tagA = candidateTags[i];
    const imgsA = bannedTagMasks.get(tagA);
    if (!imgsA) continue;

    for (let j = i + 1; j < candidateTags.length; j += 1) {
      const tagB = candidateTags[j];
      const imgsB = bannedTagMasks.get(tagB);
      if (!imgsB) continue;

      const banCount = bitsetAndCount(imgsA, imgsB);
      if (banCount < MIN_SUPPORT) continue;

      const comboSet = new Set([tagA, tagB]);
      const comboKey = setKey([tagA, tagB]);
      if (
        existingCombosKeys.has(comboKey) ||
        existingPairCombos.some((ec) => isSubsetOf(ec, comboSet))
      ) {
        continue;
      }

      const keptA = keptTagMasks.get(tagA);
      const keptB = keptTagMasks.get(tagB);
      const favA = favTagMasks.get(tagA);
      const favB = favTagMasks.get(tagB);

      const keptCount = bitsetAndCount(keptA, keptB);
      const favCount = bitsetAndCount(favA, favB);

      if (
        (broadPositiveTags.has(tagA) && isSubjectTag(tagA)) ||
        (broadPositiveTags.has(tagB) && isSubjectTag(tagB))
      ) {
        continue;
      }
      if ((broadPositiveTags.has(tagA) || broadPositiveTags.has(tagB)) && (keptCount > 0 || favCount > 0)) {
        continue;
      }

      const precision = banCount / (banCount + keptCount + FAV_WEIGHT * favCount);
      if (
        precision < MIN_PRECISION ||
        !passesPositiveFeedbackGuard(banCount, keptCount, favCount, { minPrecision: MIN_PRECISION })
      ) {
        continue;
      }

      const banBoth = bitsetAnd(imgsA, imgsB, wordLen);
      if (hasExcludedUnion && bitsetAndCount(banBoth, excludedUnionMask) / banCount > 0.5) {
        continue;
      }

      const displayTags = [tagDisplay.get(tagA) ?? tagA, tagDisplay.get(tagB) ?? tagB].sort(
        (x, y) => codePointCompare(normalizeTag(x), normalizeTag(y)),
      );
      pairRecords.push({
        combo: {
          tags: displayTags,
          count: banCount,
          banned: banCount,
          kept: keptCount,
          favorites: favCount,
          precision: pyRound(precision, 2),
        },
        banMask: banBoth,
        keptMask: bitsetAnd(keptA, keptB, wordLen),
        favMask: bitsetAnd(favA, favB, wordLen),
      });
    }
  }

  const tripleResults: ComboSuggestionItem[] = [];
  for (const { combo: pair, banMask: pairBanned, keptMask: pairKept, favMask: pairFav } of pairRecords) {
    const tagA = normalizeTag(pair.tags[0]);
    const tagB = normalizeTag(pair.tags[1]);

    for (const tagC of candidateTags) {
      if (tagC === tagA || tagC === tagB) continue;
      const imgsC = bannedTagMasks.get(tagC);
      if (!imgsC) continue;

      const triBanCount = bitsetAndCount(pairBanned, imgsC);
      if (triBanCount < MIN_SUPPORT) continue;

      const comboSet = new Set([tagA, tagB, tagC]);
      const comboKey = setKey([tagA, tagB, tagC]);
      if (
        existingCombosKeys.has(comboKey) ||
        existingPairCombos.some((ec) => isSubsetOf(ec, comboSet))
      ) {
        continue;
      }

      const triKeptCount = bitsetAndCount(pairKept, keptTagMasks.get(tagC));
      const triFavCount = bitsetAndCount(pairFav, favTagMasks.get(tagC));

      if (
        [tagA, tagB, tagC].some((tag) => broadPositiveTags.has(tag) && isSubjectTag(tag))
      ) {
        continue;
      }
      if (
        (broadPositiveTags.has(tagA) ||
          broadPositiveTags.has(tagB) ||
          broadPositiveTags.has(tagC)) &&
        (triKeptCount > 0 || triFavCount > 0)
      ) {
        continue;
      }

      const triPrecision = triBanCount / (triBanCount + triKeptCount + FAV_WEIGHT * triFavCount);
      if (
        triPrecision <= pair.precision ||
        !passesPositiveFeedbackGuard(triBanCount, triKeptCount, triFavCount, {
          minPrecision: MIN_PRECISION,
        })
      ) {
        continue;
      }

      const triBanned = bitsetAnd(pairBanned, imgsC, wordLen);
      if (hasExcludedUnion && bitsetAndCount(triBanned, excludedUnionMask) / triBanCount > 0.5) {
        continue;
      }

      const displayTags = [
        tagDisplay.get(tagA) ?? tagA,
        tagDisplay.get(tagB) ?? tagB,
        tagDisplay.get(tagC) ?? tagC,
      ].sort((x, y) => codePointCompare(normalizeTag(x), normalizeTag(y)));

      tripleResults.push({
        tags: displayTags,
        count: triBanCount,
        banned: triBanCount,
        kept: triKeptCount,
        favorites: triFavCount,
        precision: pyRound(triPrecision, 2),
      });
    }
  }

  const pairResults = pairRecords.map((r) => r.combo);
  const pairSetKeys = new Set(pairResults.map((c) => setKey(c.tags)));

  const hasPairSubset = (combo: ComboSuggestionItem): boolean => {
    const [t0, t1, t2] = combo.tags;
    return (
      pairSetKeys.has(setKey([t0, t1])) ||
      pairSetKeys.has(setKey([t0, t2])) ||
      pairSetKeys.has(setKey([t1, t2]))
    );
  };

  const allCombos = [...pairResults, ...tripleResults].filter(
    (c) => c.tags.length === 2 || !hasPairSubset(c),
  );

  allCombos.sort((a, b) => {
    const aBroad = a.tags.some((t) => broadPositiveTags.has(normalizeTag(t))) ? 1 : 0;
    const bBroad = b.tags.some((t) => broadPositiveTags.has(normalizeTag(t))) ? 1 : 0;
    if (aBroad !== bBroad) return aBroad - bBroad;
    if (b.count !== a.count) return b.count - a.count;
    return b.precision - a.precision;
  });

  return allCombos.slice(0, maxResults);
}

export function suggestUploadersToExclude(
  metadata: Record<string, ImageMetadata>,
  blacklisted: Iterable<string>,
  excludedUploaders: readonly string[],
  favorites?: Iterable<string> | null,
  options?: { maxResults?: number },
): UploaderSuggestionItem[] {
  const blacklistedSet = blacklisted instanceof Set ? blacklisted : new Set(blacklisted);
  if (blacklistedSet.size === 0) {
    return [];
  }
  const maxResults = options?.maxResults ?? 10;
  const favSet = favorites ? (favorites instanceof Set ? favorites : new Set(favorites)) : new Set<string>();
  const catalog = new ImageCatalog(metadata, blacklistedSet, favSet);

  const excludedLower = new Set<string>();
  for (const raw of excludedUploaders) {
    const cleaned = casefold(String(raw ?? "").trim());
    if (cleaned) excludedLower.add(cleaned);
  }

  const seenUploaders = new Set<string>();
  const uploaders: string[] = [];
  for (const record of catalog) {
    if (record.uploader && !seenUploaders.has(record.uploader)) {
      seenUploaders.add(record.uploader);
      uploaders.push(record.uploader);
    }
  }

  const results: UploaderSuggestionItem[] = [];
  for (const uploader of uploaders) {
    if (excludedLower.has(uploader)) continue;
    const stats = catalog.uploaderStats(uploader);
    if (stats.banned < 3) continue;
    const benefit = netBenefit(stats.banned, stats.kept, stats.favorites);
    if (benefit <= 0 || !passesPositiveFeedbackGuard(stats.banned, stats.kept, stats.favorites)) {
      continue;
    }
    const item = {
      uploader: catalog.displayUploader(uploader),
      ban_count: stats.banned,
      kept_count: stats.kept,
      fav_count: stats.favorites,
      net_benefit: pyRound(benefit, 1),
    } as UploaderSuggestionItem;
    Object.defineProperty(item, "precision", {
      value: pyRound(stats.precision, 3),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    results.push(item);
  }

  results.sort((a, b) => {
    if (b.ban_count !== a.ban_count) return b.ban_count - a.ban_count;
    return b.net_benefit - a.net_benefit;
  });
  return results.slice(0, maxResults);
}
