/**
 * ArXiv tag mapping tests.
 */

import { describe, it, expect } from "vitest";
import { mapArxivCategories, ARXIV_DOMAIN_MAP } from "@/tagger/arxiv-mapping";

describe("mapArxivCategories", () => {
  it("maps cs.AI to AI and Foundation Models", () => {
    const tags = mapArxivCategories(["cs.AI"]);
    expect(tags).toContain("AI");
    expect(tags).toContain("Foundation Models");
  });

  it("maps cs.CL to NLP and LLM", () => {
    const tags = mapArxivCategories(["cs.CL"]);
    expect(tags).toContain("NLP");
    expect(tags).toContain("LLM");
  });

  it("maps multiple categories", () => {
    const tags = mapArxivCategories(["cs.AI", "cs.CV", "cs.IR"]);
    expect(tags).toContain("AI");
    expect(tags).toContain("Multimodal");
    expect(tags).toContain("RAG");
  });

  it("returns empty for unknown categories", () => {
    const tags = mapArxivCategories(["cs.XX", "unknown"])
    expect(tags.length).toBe(0);
  });

  it("deduplicates tags", () => {
    const tags = mapArxivCategories(["cs.LG", "stat.ML"]);
    // Both map to "ML" and "Training & Fine-Tuning"
    expect(tags.filter((t) => t === "ML").length).toBe(1);
  });
});
