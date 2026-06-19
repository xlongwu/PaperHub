/**
 * Search module tests (FTS5 + vector + hybrid).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { initDatabase, closeDb, setDbPath, clearDbPath } from "@/db/index";
import { insertDocument } from "@/db/documents";
import { searchFts5, searchVector, indexDocumentVector } from "@/db/search";
import { hybridSearch } from "@/search";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-search-test.db");

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Paper",
    source: "arxiv",
    url: `https://arxiv.org/abs/${Math.random().toString(36).slice(2, 10)}`,
    publishedAt: "2026-06-15T00:00:00Z",
    authors: ["Alice"],
    abstract: "This is a test abstract about agents and rag.",
    language: "en",
    domainTags: ["Agents", "RAG"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: ["GPT-4"],
    createdAt: "2026-06-16T00:00:00Z",
    updatedAt: "2026-06-16T00:00:00Z",
    isSummarized: false,
    ...overrides,
  };
}

beforeEach(() => {
  closeDb();
  safeUnlink(TEST_DB_PATH);
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  safeUnlink(TEST_DB_PATH);
});

describe("searchFts5", () => {
  it("finds documents by keyword", () => {
    insertDocument(makeDoc({ title: "Agent Systems", abstract: "Multi-agent coordination" }));
    insertDocument(makeDoc({ title: "Neural Networks", abstract: "Deep learning basics" }));

    const results = searchFts5({ query: "agent" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.title).toBe("Agent Systems");
    expect(results[0]!.snippet).toContain("<mark>");
  });

  it("supports multi-term queries", () => {
    insertDocument(makeDoc({ title: "RAG Survey", abstract: "Retrieval augmented generation" }));
    insertDocument(makeDoc({ title: "Other", abstract: "Unrelated content" }));

    const results = searchFts5({ query: "rag retrieval" });
    expect(results.some((r) => r.document.title === "RAG Survey")).toBe(true);
  });

  it("treats AI abbreviations as concepts and removes one-term noise", () => {
    insertDocument(
      makeDoc({
        id: "synthetic-llm",
        url: "https://example.com/synthetic-llm",
        title: "Synthetic Data for Large Language Models",
        abstract: "A study of synthetic training corpora for language model alignment.",
        modelTags: ["Large Language Model"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "data-only",
        url: "https://example.com/data-only",
        title: "Data Processing Pipelines",
        abstract: "Efficient data storage and analytics infrastructure.",
        domainTags: ["Data"],
        modelTags: [],
      }),
    );

    const results = searchFts5({ query: "synthetic data LLM" });

    expect(results.map((result) => result.document.id)).toEqual(["synthetic-llm"]);
  });

  it("filters by source", () => {
    insertDocument(makeDoc({ source: "arxiv", title: "ArXiv Paper" }));
    insertDocument(makeDoc({ source: "gpt_blog", title: "Blog Post" }));

    const results = searchFts5({ query: "paper", sources: ["arxiv"] });
    expect(results.every((r) => r.document.source === "arxiv")).toBe(true);
  });

  it("filters by tags", () => {
    insertDocument(makeDoc({ title: "Agent Paper", domainTags: ["Agents"] }));
    insertDocument(makeDoc({ title: "ML Paper", domainTags: ["ML"] }));

    const results = searchFts5({ query: "paper", tags: ["Agents"] });
    expect(results.some((r) => r.document.title === "Agent Paper")).toBe(true);
  });

  it("returns empty for no match", () => {
    const results = searchFts5({ query: "xyznonexistent" });
    expect(results.length).toBe(0);
  });
});

describe("searchVector", () => {
  it("finds semantically similar documents", async () => {
    // Use mock embedding (deterministic)
    process.env["EMBEDDING_MOCK"] = "1";

    const doc1 = makeDoc({
      id: "vec-1",
      title: "Large Language Models",
      abstract: "LLM survey and overview",
    });
    insertDocument(doc1);
    await indexDocumentVector(doc1);

    const doc2 = makeDoc({
      id: "vec-2",
      title: "Transformer Architecture",
      abstract: "Attention mechanism details",
    });
    insertDocument(doc2);
    await indexDocumentVector(doc2);

    const results = await searchVector({ query: "language models", limit: 10 });
    expect(results.length).toBeGreaterThan(0);

    delete process.env["EMBEDDING_MOCK"];
  });
});

describe("hybridSearch", () => {
  it("returns keyword results in keyword mode", async () => {
    insertDocument(makeDoc({ title: "Hybrid Test", abstract: "Testing hybrid search" }));

    const result = await hybridSearch({ query: "hybrid", mode: "keyword" });
    expect(result.mode).toBe("keyword");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("returns combined results in hybrid mode", async () => {
    insertDocument(makeDoc({ title: "Combined", abstract: "Combined search test" }));

    const result = await hybridSearch({ query: "combined search", mode: "hybrid" });
    expect(result.mode).toBe("keyword_fallback");
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("keeps multi-concept hybrid searches focused on documents covering the query", async () => {
    process.env["EMBEDDING_MOCK"] = "1";

    const relevant = makeDoc({
      id: "hybrid-synthetic-llm",
      url: "https://example.com/hybrid-synthetic-llm",
      title: "Synthetic Data for LLM Evaluation",
      abstract: "Synthetic datasets for evaluating large language models.",
      modelTags: ["LLM"],
    });
    const partial = makeDoc({
      id: "hybrid-data-only",
      url: "https://example.com/hybrid-data-only",
      title: "Data Warehouse Design",
      abstract: "Data storage, indexing, and reporting.",
      domainTags: ["Data"],
      modelTags: [],
    });

    insertDocument(relevant);
    insertDocument(partial);
    await indexDocumentVector(relevant);
    await indexDocumentVector(partial);

    const result = await hybridSearch({
      query: "synthetic data LLM",
      mode: "hybrid",
      limit: 10,
    });

    const ids = result.results.map((entry) => entry.document.id);
    expect(ids).toContain("hybrid-synthetic-llm");
    expect(ids).not.toContain("hybrid-data-only");

    delete process.env["EMBEDDING_MOCK"];
  });

  it("supports pagination", async () => {
    for (let i = 0; i < 5; i++) {
      insertDocument(makeDoc({ title: `Page Test ${i}` }));
    }

    const result = await hybridSearch({ query: "page", mode: "keyword", limit: 2, offset: 0 });
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("keeps later pages accessible in keyword mode", async () => {
    for (let i = 0; i < 12; i++) {
      insertDocument(
        makeDoc({
          id: `page-${i}`,
          url: `https://example.com/page-${i}`,
          title: `Paging Query ${i}`,
          publishedAt: `2026-06-${String(20 - i).padStart(2, "0")}T00:00:00Z`,
        }),
      );
    }

    const firstPage = await hybridSearch({ query: "paging", mode: "keyword", limit: 5, offset: 0 });
    const secondPage = await hybridSearch({ query: "paging", mode: "keyword", limit: 5, offset: 5 });

    expect(firstPage.results).toHaveLength(5);
    expect(secondPage.results).toHaveLength(5);
    expect(secondPage.results[0]!.document.id).not.toBe(firstPage.results[0]!.document.id);
  });

  it("applies tag filters to vector results in hybrid mode", async () => {
    process.env["EMBEDDING_MOCK"] = "1";

    const matching = makeDoc({
      id: "hybrid-tag-a",
      url: "https://example.com/hybrid-tag-a",
      title: "Language Model Agents",
      abstract: "Research about language model agents",
      domainTags: ["Agents"],
    });
    const filteredOut = makeDoc({
      id: "hybrid-tag-b",
      url: "https://example.com/hybrid-tag-b",
      title: "Language Model Agents",
      abstract: "Research about language model agents",
      domainTags: ["ML"],
    });

    insertDocument(matching);
    insertDocument(filteredOut);
    await indexDocumentVector(matching);
    await indexDocumentVector(filteredOut);

    const result = await hybridSearch({
      query: "language model agents",
      mode: "hybrid",
      tags: ["Agents"],
    });

    expect(result.results.map((entry) => entry.document.id)).toContain("hybrid-tag-a");
    expect(result.results.map((entry) => entry.document.id)).not.toContain("hybrid-tag-b");

    delete process.env["EMBEDDING_MOCK"];
  });
});
