import { describe, expect, it } from "vitest";
import { analyzeSearchQuery, scoreDocumentAgainstQuery } from "@/search-query";
import type { Document } from "@/types";

function makeDocument(overrides: Partial<Document>): Document {
  return {
    id: "search-query-doc",
    title: "Test document",
    source: "arxiv",
    url: "https://example.com/search-query-doc",
    publishedAt: "2026-06-18T00:00:00Z",
    authors: [],
    abstract: "",
    language: "en",
    domainTags: [],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-18T00:00:00Z",
    updatedAt: "2026-06-18T00:00:00Z",
    isSummarized: false,
    ...overrides,
  };
}

describe("search query analysis", () => {
  it("expands LLM and ignores connector words", () => {
    const analysis = analyzeSearchQuery("synthetic data for LLMs");

    expect(analysis.concepts.map((concept) => concept.canonical)).toEqual(["synthetic", "data", "llm"]);
    expect(analysis.ftsQuery).toContain('"large language model"*');
    expect(analysis.minimumLexicalMatches).toBe(3);
  });

  it("scores full concept coverage above a frequent-word-only match", () => {
    const analysis = analyzeSearchQuery("synthetic data LLM");
    const relevant = makeDocument({
      title: "Synthetic Data for Large Language Models",
      abstract: "Synthetic corpora for language model evaluation.",
      modelTags: ["Large Language Model"],
    });
    const partial = makeDocument({
      title: "Data Processing Pipelines",
      abstract: "Data storage and analytics infrastructure.",
      domainTags: ["Data"],
    });

    const relevantScore = scoreDocumentAgainstQuery(relevant, analysis);
    const partialScore = scoreDocumentAgainstQuery(partial, analysis);

    expect(relevantScore.matchedConcepts).toBe(3);
    expect(partialScore.matchedConcepts).toBe(1);
    expect(relevantScore.score).toBeGreaterThan(partialScore.score);
  });
});
