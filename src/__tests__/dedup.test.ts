/**
 * Dedup utility tests.
 */

import { describe, it, expect } from "vitest";
import { levenshteinDistance, isSimilarTitle } from "@/utils/dedup";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns length for empty comparison", () => {
    expect(levenshteinDistance("hello", "")).toBe(5);
    expect(levenshteinDistance("", "hello")).toBe(5);
  });

  it("computes correct distance", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("saturday", "sunday")).toBe(3);
  });
});

describe("isSimilarTitle", () => {
  it("returns true for identical titles", () => {
    expect(isSimilarTitle("Hello World", "Hello World")).toBe(true);
  });

  it("returns true for very similar titles", () => {
    expect(isSimilarTitle("GPT-4 Technical Report", "GPT 4 Technical Report")).toBe(true);
  });

  it("returns false for different titles", () => {
    expect(isSimilarTitle("Attention Is All You Need", "BERT: Pre-training")).toBe(false);
  });

  it("ignores case and punctuation", () => {
    expect(isSimilarTitle("Hello, World!", "hello world")).toBe(true);
  });
});
