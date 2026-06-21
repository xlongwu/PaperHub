import { describe, expect, it } from "vitest";
import { chunkPaperContent, packEvidenceNotes } from "@/summarizer/chunking";
import { buildSummaryPrompt } from "@/summarizer/prompt";
import type { Document } from "@/types";

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: "summary-prompt",
    title: "Synthetic Data for LLMs",
    source: "arxiv",
    url: "https://example.com/paper",
    publishedAt: "2026-06-19T00:00:00Z",
    authors: ["Alice", "Bob"],
    abstract: "ABSTRACT_ONLY_MARKER",
    fullText: "FULL_TEXT_MARKER",
    language: "en",
    domainTags: ["LLM", "Training & Fine-Tuning"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
    isSummarized: false,
    ...overrides,
  };
}

describe("summary prompt template", () => {
  it("uses full text and detailed user preferences", () => {
    const prompt = buildSummaryPrompt(makeDoc(), {
      lang: "zh",
      summaryLevel: "detailed",
      focusTopics: ["LLM", "Synthetic Data"],
    });

    expect(prompt).toContain("中文");
    expect(prompt).toContain("detailed");
    expect(prompt).toContain("LLM, Synthetic Data");
    // Full text marker should appear in the {{full_text}} section
    expect(prompt).toContain("FULL_TEXT_MARKER");
    // Abstract marker always appears since abstract is a separate template field
    expect(prompt).toContain("ABSTRACT_ONLY_MARKER");
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/i);
  });

  it("marks abstract-only inputs explicitly", () => {
    const prompt = buildSummaryPrompt(
      makeDoc({ fullText: undefined }),
      { lang: "en", summaryLevel: "short" },
    );

    expect(prompt).toContain("English");
    expect(prompt).toContain("short");
    expect(prompt).toContain("ABSTRACT_ONLY_MARKER");
    expect(prompt).toContain("Full text is not available");
  });
});

describe("long-paper chunking", () => {
  it("splits by sections without dropping source markers", () => {
    const content = [
      "# Introduction",
      `INTRO_START ${"A".repeat(160)}`,
      "# Methods",
      `METHOD_START ${"B".repeat(160)}`,
      "# Results",
      `RESULT_START ${"C".repeat(160)} FINAL_MARKER`,
    ].join("\n\n");

    const chunks = chunkPaperContent(content, 180);
    const combined = chunks.map((chunk) => chunk.content).join("\n");

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.content.length <= 180)).toBe(true);
    expect(combined).toContain("INTRO_START");
    expect(combined).toContain("METHOD_START");
    expect(combined).toContain("RESULT_START");
    expect(combined).toContain("FINAL_MARKER");
    expect(chunks.some((chunk) => chunk.sectionLabel.includes("Methods"))).toBe(
      true,
    );
  });

  it("packs evidence notes under the requested size", () => {
    const groups = packEvidenceNotes(
      ["A".repeat(120), "B".repeat(120), "C".repeat(120)],
      180,
    );
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.length <= 180)).toBe(true);
  });
});
