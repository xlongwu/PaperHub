import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hotRecommendationsResponse,
  indexAllVectors,
  listDocumentsResponse,
  parseRecommendationRequestOptions,
  parseUserMemoryRebuildBody,
  personalizedRecommendationsResponse,
  rebuildUserMemoryResponse,
  searchResponse,
  userMemoryResponse,
} from "@/api/server";
import { countIndexedVectors, indexDocumentVector } from "@/db/search";
import { insertDocument } from "@/db/documents";
import { clearDbPath, closeDb, initDatabase, setDbPath } from "@/db/index";
import { recordHistory, setUserPreference } from "@/db/user";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-api-test.db");

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: `api-${Math.random().toString(36).slice(2, 8)}`,
    title: "API Test Paper",
    source: "arxiv",
    url: `https://example.com/${Math.random().toString(36).slice(2, 10)}`,
    publishedAt: "2026-06-15T00:00:00Z",
    authors: ["Alice"],
    abstract: "This paper studies language model agents.",
    language: "en",
    domainTags: ["Agents"],
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
  process.env["EMBEDDING_MOCK"] = "1";
  closeDb();
  safeUnlink(TEST_DB_PATH);

  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterEach(() => {
  closeDb();
  delete process.env["EMBEDDING_MOCK"];

  safeUnlink(TEST_DB_PATH);
});

afterAll(() => {
  clearDbPath();
});

describe("listDocumentsResponse", () => {
  it("applies date filtering before pagination and returns filtered totals", () => {
    insertDocument(makeDoc({ id: "doc-in-range-1", url: "https://example.com/range-1", publishedAt: "2026-06-15T00:00:00Z" }));
    insertDocument(makeDoc({ id: "doc-in-range-2", url: "https://example.com/range-2", publishedAt: "2026-06-12T00:00:00Z" }));
    insertDocument(makeDoc({ id: "doc-out-range", url: "https://example.com/out-range", publishedAt: "2026-06-05T00:00:00Z" }));

    const payload = listDocumentsResponse({
      from: "2026-06-10T00:00:00Z",
      to: "2026-06-20T23:59:59Z",
      limit: 1,
      offset: 0,
    });

    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]!.id).toBe("doc-in-range-1");
    expect(payload.meta.total).toBe(2);
  });
});

describe("searchResponse", () => {
  it("does not leak vector-only results past tag filters in hybrid mode", async () => {
    const matching = makeDoc({
      id: "search-tag-a",
      url: "https://example.com/search-tag-a",
      title: "Language Model Agents",
      abstract: "Research about language model agents",
      domainTags: ["Agents"],
    });
    const filteredOut = makeDoc({
      id: "search-tag-b",
      url: "https://example.com/search-tag-b",
      title: "Language Model Agents",
      abstract: "Research about language model agents",
      domainTags: ["ML"],
    });

    insertDocument(matching);
    insertDocument(filteredOut);
    await indexDocumentVector(matching);
    await indexDocumentVector(filteredOut);

    const payload = await searchResponse({
      query: "language model agents",
      mode: "hybrid",
      tags: ["Agents"],
    });
    const ids = payload.results.map((entry) => entry.document.id);

    expect(ids).toContain("search-tag-a");
    expect(ids).not.toContain("search-tag-b");
  });
});

describe("indexAllVectors", () => {
  it("indexes more than 1000 documents by batching through the corpus", async () => {
    for (let i = 0; i < 1001; i++) {
      insertDocument(
        makeDoc({
          id: `bulk-${i}`,
          url: `https://example.com/bulk-${i}`,
          title: "Shared Vector Payload",
          abstract: "Shared Vector Payload",
          domainTags: ["Agents"],
          modelTags: [],
        }),
      );
    }

    const payload = await indexAllVectors();

    expect(payload.total).toBe(1001);
    expect(payload.indexed).toBe(1001);
    expect(countIndexedVectors()).toBe(1001);
  }, 15_000);
});

describe("recommendation responses", () => {
  it("returns hot recommendations through the API layer", () => {
    insertDocument(
      makeDoc({
        id: "hot-api-1",
        url: "https://example.com/hot-api-1",
        publishedAt: "2026-06-16T09:00:00Z",
      }),
    );
    insertDocument(
      makeDoc({
        id: "hot-api-2",
        url: "https://example.com/hot-api-2",
        source: "gpt_blog",
        sourceTag: "GPT Blog",
        publishedAt: "2026-06-16T08:00:00Z",
      }),
    );

    const payload = hotRecommendationsResponse({ limit: 5 });

    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.meta.total).toBe(payload.data.length);
    expect(payload.data[0]!.reason.kind).toBe("hot");
  });

  it("rebuilds and returns user memory through the API layer", () => {
    const rebuilt = rebuildUserMemoryResponse({ maxDays: 30, maxTerms: 10 });
    const payload = userMemoryResponse({ limit: 10 });

    expect(rebuilt.rebuilt).toBeGreaterThan(0);
    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.data.every((term) => term.source === "digest")).toBe(true);
  });

  it("returns personalized recommendations while excluding read items by default", async () => {
    setUserPreference("interest_tags", JSON.stringify(["Agents"]));

    insertDocument(
      makeDoc({
        id: "personal-api-hit",
        url: "https://example.com/personal-api-hit",
        title: "Agents in Production",
        domainTags: ["Agents"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "personal-api-read",
        url: "https://example.com/personal-api-read",
        title: "Agents Already Read",
        domainTags: ["Agents"],
      }),
    );

    recordHistory("personal-api-read");

    const payload = await personalizedRecommendationsResponse({ limit: 10 });
    const ids = payload.data.map((entry) => entry.document.id);

    expect(ids).toContain("personal-api-hit");
    expect(ids).not.toContain("personal-api-read");
    expect(payload.data[0]!.reason.kind).toBe("personalized");
  });
});

describe("recommendation routes", () => {
  it("parses personalized recommendation query options before calling the API layer", async () => {
    setUserPreference("interest_tags", JSON.stringify(["Agents"]));

    insertDocument(
      makeDoc({
        id: "route-personalized-hit",
        url: "https://example.com/route-personalized-hit",
        title: "Agents Through HTTP",
        domainTags: ["Agents"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "route-personalized-read",
        url: "https://example.com/route-personalized-read",
        title: "Read Agents Through HTTP",
        domainTags: ["Agents"],
      }),
    );
    recordHistory("route-personalized-read");

    const options = parseRecommendationRequestOptions({
      limit: "5",
      includeRead: "false",
    });
    const payload = await personalizedRecommendationsResponse(options);
    const ids = payload.data.map((entry) => entry.document.id);

    expect(options.limit).toBe(5);
    expect(options.includeRead).toBe(false);
    expect(ids).toContain("route-personalized-hit");
    expect(ids).not.toContain("route-personalized-read");
  });

  it("parses memory rebuild request bodies before calling the API layer", () => {
    const options = parseUserMemoryRebuildBody({
      maxDays: "30",
      maxTerms: "5",
      useLlmFallback: "true",
    });
    const payload = rebuildUserMemoryResponse(options);

    expect(options.maxDays).toBe(30);
    expect(options.maxTerms).toBe(5);
    expect(options.useLlmFallback).toBe(true);
    expect(payload.rebuilt).toBeGreaterThan(0);
    expect(payload.terms.every((term) => term.source === "digest")).toBe(true);
  });
});
