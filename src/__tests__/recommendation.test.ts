import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertDocument } from "@/db/documents";
import { upsertUserMemoryTerms } from "@/db/recommendations";
import { clearDbPath, closeDb, initDatabase, setDbPath } from "@/db/index";
import { addFavorite, recordHistory, setUserPreference } from "@/db/user";
import { buildHotRecommendations } from "@/recommendation/hot";
import { buildPersonalizedRecommendations } from "@/recommendation";
import type { MemoryTerm } from "@/types";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-recommendation-test.db");
const NOW = new Date("2026-06-16T12:00:00Z");

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    title: "Recommendation Test",
    source: "arxiv",
    url: `https://example.com/${Math.random().toString(36).slice(2, 10)}`,
    publishedAt: "2026-06-15T00:00:00Z",
    authors: ["Alice"],
    abstract: "This document covers agents and planning.",
    language: "en",
    domainTags: ["Agents"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: ["GPT-4"],
    createdAt: "2026-06-16T00:00:00Z",
    updatedAt: "2026-06-16T00:00:00Z",
    isSummarized: true,
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

describe("buildHotRecommendations", () => {
  it("prefers newer documents", () => {
    insertDocument(
      makeDoc({
        id: "hot-new",
        url: "https://example.com/hot-new",
        title: "Fresh Agents",
        publishedAt: "2026-06-16T08:00:00Z",
      }),
    );
    insertDocument(
      makeDoc({
        id: "hot-old",
        url: "https://example.com/hot-old",
        title: "Older Agents",
        publishedAt: "2026-06-10T08:00:00Z",
      }),
    );

    const results = buildHotRecommendations({ now: NOW, limit: 2 });
    expect(results[0]!.document.id).toBe("hot-new");
  });

  it("reranks to avoid a single source dominating the list", () => {
    for (let i = 0; i < 4; i++) {
      insertDocument(
        makeDoc({
          id: `hot-arxiv-${i}`,
          url: `https://example.com/hot-arxiv-${i}`,
          source: "arxiv",
          sourceTag: "arXiv",
          publishedAt: `2026-06-16T0${i}:00:00Z`,
        }),
      );
    }

    insertDocument(
      makeDoc({
        id: "hot-gpt",
        url: "https://example.com/hot-gpt",
        source: "gpt_blog",
        sourceTag: "GPT Blog",
        publishedAt: "2026-06-16T03:30:00Z",
      }),
    );
    insertDocument(
      makeDoc({
        id: "hot-claude",
        url: "https://example.com/hot-claude",
        source: "claude_blog",
        sourceTag: "Claude Blog",
        publishedAt: "2026-06-16T03:45:00Z",
      }),
    );

    const results = buildHotRecommendations({ now: NOW, limit: 4 });
    const arxivCount = results.filter((entry) => entry.document.source === "arxiv").length;

    expect(arxivCount).toBeLessThanOrEqual(2);
  });
});

describe("buildPersonalizedRecommendations", () => {
  it("excludes read and favorited documents by default", async () => {
    setUserPreference("interest_tags", JSON.stringify(["Agents"]));

    insertDocument(
      makeDoc({
        id: "personal-include",
        url: "https://example.com/personal-include",
        title: "Agent Planning Systems",
        domainTags: ["Agents", "Planning"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "personal-read",
        url: "https://example.com/personal-read",
        title: "Read Agent Paper",
        domainTags: ["Agents"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "personal-favorite",
        url: "https://example.com/personal-favorite",
        title: "Favorited Agent Paper",
        domainTags: ["Agents"],
      }),
    );
    insertDocument(
      makeDoc({
        id: "personal-miss",
        url: "https://example.com/personal-miss",
        title: "Unrelated Vision Paper",
        domainTags: ["Vision-Language"],
        modelTags: ["Claude 3"],
      }),
    );

    recordHistory("personal-read");
    addFavorite("personal-favorite");

    const results = await buildPersonalizedRecommendations({ now: NOW, limit: 5 });
    const ids = results.map((entry) => entry.document.id);

    expect(ids).toContain("personal-include");
    expect(ids).not.toContain("personal-read");
    expect(ids).not.toContain("personal-favorite");
    expect(results[0]!.reason.kind).toBe("personalized");
    expect(results[0]!.reason.matchedTags?.length).toBeGreaterThan(0);
    expect(results[0]!.reason.factors.length).toBeGreaterThan(0);
  });

  it("falls back to the 90-day window after 30-day candidates are filtered out", async () => {
    setUserPreference("interest_tags", JSON.stringify(["Agents"]));

    for (let i = 0; i < 5; i++) {
      const id = `personal-recent-read-${i}`;
      insertDocument(
        makeDoc({
          id,
          url: `https://example.com/${id}`,
          title: `Recently Read Agent ${i}`,
          domainTags: ["Agents"],
          publishedAt: `2026-06-${String(15 - i).padStart(2, "0")}T08:00:00Z`,
        }),
      );
      recordHistory(id);
    }

    insertDocument(
      makeDoc({
        id: "personal-older-hit",
        url: "https://example.com/personal-older-hit",
        title: "Older Agent Planning Systems",
        domainTags: ["Agents", "Planning"],
        publishedAt: "2026-05-05T08:00:00Z",
      }),
    );

    const results = await buildPersonalizedRecommendations({ now: NOW, limit: 3 });
    const ids = results.map((entry) => entry.document.id);

    expect(ids).toContain("personal-older-hit");
  });

  it("uses topic memory terms to rank matching documents", async () => {
    const memoryTerm: MemoryTerm = {
      term: "CLI",
      category: "topic",
      weight: 1,
      source: "digest",
      lastSeenAt: NOW.toISOString(),
    };
    upsertUserMemoryTerms([memoryTerm]);

    insertDocument(
      makeDoc({
        id: "personal-topic-hit",
        url: "https://example.com/personal-topic-hit",
        title: "CLI Agents in Production",
        abstract: "A CLI workflow for orchestrating agents.",
        domainTags: ["Tools & Engineering"],
        modelTags: [],
      }),
    );
    insertDocument(
      makeDoc({
        id: "personal-topic-miss",
        url: "https://example.com/personal-topic-miss",
        title: "Vision Research Update",
        abstract: "Recent vision-language paper roundup.",
        domainTags: ["Vision-Language"],
        modelTags: [],
      }),
    );

    const results = await buildPersonalizedRecommendations({ now: NOW, limit: 2 });

    expect(results[0]!.document.id).toBe("personal-topic-hit");
    expect(results[0]!.reason.matchedTags).toContain("CLI");
  });

  it("collects the full 30-day window instead of truncating at 1000 documents", async () => {
    setUserPreference("interest_tags", JSON.stringify(["Agents"]));

    for (let i = 0; i < 1000; i++) {
      const id = `personal-bulk-${i}`;
      insertDocument(
        makeDoc({
          id,
          url: `https://example.com/${id}`,
          title: `Bulk Recent ${i}`,
          domainTags: ["Vision-Language"],
          modelTags: [],
          publishedAt: `2026-06-${String((i % 15) + 1).padStart(2, "0")}T08:00:00Z`,
        }),
      );
      recordHistory(id);
    }

    insertDocument(
      makeDoc({
        id: "personal-window-hit",
        url: "https://example.com/personal-window-hit",
        title: "Late-window Agent Recommendation",
        domainTags: ["Agents"],
        modelTags: [],
        publishedAt: "2026-05-20T08:00:00Z",
      }),
    );

    const results = await buildPersonalizedRecommendations({ now: NOW, limit: 1 });

    expect(results[0]!.document.id).toBe("personal-window-hit");
  }, 15_000);
});
