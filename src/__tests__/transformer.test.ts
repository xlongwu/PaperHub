/**
 * Transformer tests.
 */

import { describe, it, expect } from "vitest";
import { rawToDocument } from "@/collectors/transformer";
import type { RawDocument } from "@/types";

function makeRaw(overrides: Partial<RawDocument> = {}): RawDocument {
  return {
    title: "Test Title",
    source: "arxiv",
    url: "https://arxiv.org/abs/1234.5678",
    publishedAt: "2026-06-15T00:00:00Z",
    authors: ["Alice"],
    abstract: "An abstract.",
    language: "en",
    ...overrides,
  };
}

describe("rawToDocument", () => {
  it("generates a stable id from source + url", () => {
    const doc1 = rawToDocument(makeRaw());
    const doc2 = rawToDocument(makeRaw());
    expect(doc1.id).toBe(doc2.id);
  });

  it("sets typeTag based on source", () => {
    const arxiv = rawToDocument(makeRaw({ source: "arxiv" }));
    expect(arxiv.typeTag).toBe("paper");

    const blog = rawToDocument(makeRaw({ source: "gpt_blog" }));
    expect(blog.typeTag).toBe("blog");
  });

  it("extracts year from publishedAt", () => {
    const doc = rawToDocument(makeRaw({ publishedAt: "2025-03-10T00:00:00Z" }));
    expect(doc.yearTag).toBe(2025);
  });

  it("defaults domainTags and modelTags to empty arrays", () => {
    const doc = rawToDocument(makeRaw());
    expect(doc.domainTags).toEqual([]);
    expect(doc.modelTags).toEqual([]);
  });

  it("sets isSummarized to false", () => {
    const doc = rawToDocument(makeRaw());
    expect(doc.isSummarized).toBe(false);
  });
});
