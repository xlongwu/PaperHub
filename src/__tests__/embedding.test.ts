import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  buildDocumentEmbeddingText,
  generateEmbeddings,
  getEmbeddingRuntime,
  resetEmbeddingRuntime,
} from "@/embedding";
import { getCachedEmbedding, getEmbeddingCacheFilePath, setCachedEmbedding } from "@/embedding/cache";
import type { Document } from "@/types";
import { resetDir, testPath } from "./test-utils";

const CACHE_DIR = testPath("embedding-cache");

beforeEach(() => {
  process.env["PAPERHUB_CACHE_DIR"] = CACHE_DIR;
  process.env["EMBEDDING_MOCK"] = "1";
  process.env["EMBEDDING_EXPECTED_DIMENSIONS"] = "64";
  resetEmbeddingRuntime();
  resetDir(CACHE_DIR);
});

afterEach(() => {
  delete process.env["PAPERHUB_CACHE_DIR"];
  delete process.env["EMBEDDING_MOCK"];
  delete process.env["EMBEDDING_EXPECTED_DIMENSIONS"];
  resetEmbeddingRuntime();
  resetDir(CACHE_DIR);
});

describe("embedding runtime and cache", () => {
  it("generates deterministic batch embeddings with dynamic dimensions", async () => {
    const runtime = getEmbeddingRuntime();
    const first = await generateEmbeddings(["agent systems", "retrieval systems"]);
    const second = await generateEmbeddings(["agent systems", "retrieval systems"]);

    expect(runtime.dimensions).toBe(64);
    expect(first).toEqual(second);
    expect(first.every((embedding) => embedding.length === 64)).toBe(true);
  });

  it("isolates cache entries by signature and dimensions", () => {
    const runtime = getEmbeddingRuntime();
    const embedding = Array.from({ length: runtime.dimensions }, (_, index) => index / 100);
    setCachedEmbedding("same text", runtime, embedding);
    expect(getCachedEmbedding("same text", runtime)).toEqual(embedding);

    const changed = { ...runtime, signature: `${runtime.signature}:changed` };
    expect(getCachedEmbedding("same text", changed)).toBeNull();

    const file = getEmbeddingCacheFilePath("same text", runtime.signature);
    expect(file).not.toBeNull();
    fs.writeFileSync(file!, "{broken", "utf8");
    expect(getCachedEmbedding("same text", runtime)).toBeNull();
  });
});

describe("buildDocumentEmbeddingText", () => {
  it("preserves title, abstract, summaries, and tags before full text", () => {
    const text = buildDocumentEmbeddingText(makeDocument(), 220);
    expect(text).toContain("Title: Important title");
    expect(text).toContain("Abstract: Important abstract");
    expect(text).toContain("Summary Zh: 中文总结");
    expect(text).toContain("Domain Tags: Agents, RAG");
    expect(text.length).toBeLessThanOrEqual(220);
    expect(text.indexOf("Title:")).toBeLessThan(
      text.indexOf("Full Text:") === -1 ? Infinity : text.indexOf("Full Text:"),
    );
  });
});

function makeDocument(): Document {
  return {
    id: "embedding-doc",
    title: "Important title",
    source: "arxiv",
    url: "https://example.com/embedding-doc",
    publishedAt: "2026-06-19T00:00:00Z",
    authors: ["Alice"],
    abstract: "Important abstract",
    fullText: "x".repeat(1_000),
    language: "en",
    domainTags: ["Agents", "RAG"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: ["GPT-4"],
    summaryZh: "中文总结",
    summaryEn: "English summary",
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
    isSummarized: true,
  };
}
