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

    expect(analysis.concepts.map((concept) => concept.canonical)).toEqual(["synthetic data", "llm"]);
    expect(analysis.broadFtsQuery).toContain('"large language model"*');
    // No more minimumLexicalMatches — concept coverage is now a ranking signal
    expect(analysis.concepts.length).toBe(2);
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

    expect(relevantScore.matchedConcepts).toBe(2);
    expect(partialScore.matchedConcepts).toBe(0);
    expect(relevantScore.score).toBeGreaterThan(partialScore.score);
  });

  it("extracts LLM and synthetic-data concepts from a Chinese request", () => {
    const analysis = analyzeSearchQuery("帮我搜集一些与大模型数据合成相关的论文和博客");

    expect(new Set(analysis.concepts.map((concept) => concept.canonical))).toEqual(
      new Set(["llm", "synthetic data"]),
    );
    expect(analysis.strictFtsQuery).toContain('"synthetic data"*');
  });
});
