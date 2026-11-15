import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  suggestComboPatterns,
  suggestComboRefinements,
  suggestTagsToExclude,
  suggestUploadersToExclude,
} from "../src/core/suggestions";

// Inputs and expected outputs were produced by the original Python implementation.
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "suggestions-parity.json"), "utf8"),
);
const banned = new Set<string>(fixture.banned);
const favorites = new Set<string>(fixture.favorites);

describe("python parity: exclusion suggestions", () => {
  it("ranks single tags identically, with and without existing rules", () => {
    expect(fixture.expected.tags.length).toBeGreaterThan(0);
    expect(
      suggestTagsToExclude(
        fixture.metadata,
        banned,
        fixture.excluded_tags,
        fixture.excluded_combos,
        favorites,
      ),
    ).toEqual(fixture.expected.tags);
    expect(suggestTagsToExclude(fixture.metadata, banned, [], [], favorites)).toEqual(
      fixture.expected.tags_no_rules,
    );
  });

  it("mines the same tag combinations", () => {
    expect(
      suggestComboPatterns(
        fixture.metadata,
        banned,
        fixture.excluded_tags,
        fixture.excluded_combos,
        favorites,
      ),
    ).toEqual(fixture.expected.combos);
  });

  it("refines a selected context with the same companions", () => {
    fixture.contexts.forEach((context: string[], index: number) => {
      expect(
        suggestComboRefinements(
          fixture.metadata,
          banned,
          context,
          fixture.excluded_tags,
          fixture.excluded_combos,
          favorites,
        ),
      ).toEqual(fixture.expected.refinements[index]);
    });
  });

  it("flags the same uploaders", () => {
    expect(
      suggestUploadersToExclude(fixture.metadata, banned, fixture.excluded_uploaders, favorites),
    ).toEqual(fixture.expected.uploaders);
  });
});
