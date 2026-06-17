/**
 * Tag system tests.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { initDatabase, closeDb, setDbPath, clearDbPath } from "@/db/index";
import { insertDocument } from "@/db/documents";
import { getTagCloud, getDocumentsByTag, countDocumentsByTag, refreshTagStats, updateTagStatsForDocument } from "@/db/tags";
import type { Document } from "@/types";
import fs from "node:fs";

const TEST_DB_PATH = "/tmp/paperhub-tags-test.db";

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: `tag-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test",
    source: "arxiv",
    url: `https://test/${Math.random().toString(36).slice(2, 8)}`,
    publishedAt: "2026-06-15T00:00:00Z",
    authors: [],
    abstract: "Abstract",
    language: "en",
    domainTags: [],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-16T00:00:00Z",
    updatedAt: "2026-06-16T00:00:00Z",
    isSummarized: false,
    ...overrides,
  };
}

beforeEach(() => {
  closeDb();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

describe("refreshTagStats", () => {
  it("counts domain tags correctly", () => {
    insertDocument(makeDoc({ domainTags: ["Agents", "RAG"] }));
    insertDocument(makeDoc({ domainTags: ["Agents", "LLM"] }));
    insertDocument(makeDoc({ domainTags: ["ML"] }));

    refreshTagStats();

    const cloud = getTagCloud();
    const agents = cloud.find((t) => t.tag === "Agents");
    expect(agents?.count).toBe(2);

    const rag = cloud.find((t) => t.tag === "RAG");
    expect(rag?.count).toBe(1);
  });

  it("counts model tags", () => {
    insertDocument(makeDoc({ modelTags: ["GPT-4"] }));
    insertDocument(makeDoc({ modelTags: ["GPT-4", "Claude 3"] }));

    refreshTagStats();

    const cloud = getTagCloud({ category: "model" });
    const gpt4 = cloud.find((t) => t.tag === "GPT-4");
    expect(gpt4?.count).toBe(2);
  });

  it("filters by category", () => {
    insertDocument(makeDoc({ domainTags: ["AI"], source: "arxiv" }));
    refreshTagStats();

    const domain = getTagCloud({ category: "domain" });
    expect(domain.some((t) => t.tag === "AI")).toBe(true);

    const source = getTagCloud({ category: "source" });
    expect(source.some((t) => t.tag === "arXiv")).toBe(true);
  });
});

describe("getDocumentsByTag", () => {
  it("finds by domain tag", () => {
    insertDocument(makeDoc({ id: "d1", domainTags: ["Agents"] }));
    insertDocument(makeDoc({ id: "d2", domainTags: ["RAG"] }));

    const docs = getDocumentsByTag("Agents");
    expect(docs.length).toBe(1);
    expect(docs[0]!.id).toBe("d1");
  });

  it("finds by model tag", () => {
    insertDocument(makeDoc({ id: "d3", modelTags: ["GPT-4"] }));
    insertDocument(makeDoc({ id: "d3b", modelTags: ["GPT-40"] }));

    const docs = getDocumentsByTag("GPT-4");
    expect(docs.length).toBe(1);
    expect(docs[0]!.id).toBe("d3");
  });

  it("finds by source tag", () => {
    insertDocument(makeDoc({ id: "d4", source: "gpt_blog" }));

    const docs = getDocumentsByTag("gpt_blog");
    expect(docs.some((d) => d.id === "d4")).toBe(true);
  });

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      insertDocument(makeDoc({ id: `p${i}`, domainTags: ["Agents"] }));
    }

    const page = getDocumentsByTag("Agents", { limit: 2, offset: 0 });
    expect(page.length).toBe(2);
  });
});

describe("countDocumentsByTag", () => {
  it("returns correct count", () => {
    insertDocument(makeDoc({ domainTags: ["Agents"] }));
    insertDocument(makeDoc({ domainTags: ["Agents", "RAG"] }));

    expect(countDocumentsByTag("Agents")).toBe(2);
  });
});

describe("updateTagStatsForDocument", () => {
  it("increments tag counts", () => {
    const doc = makeDoc({ domainTags: ["TestTag"] });
    insertDocument(doc);
    updateTagStatsForDocument(doc);

    const cloud = getTagCloud();
    const tag = cloud.find((t) => t.tag === "TestTag");
    expect(tag?.count).toBe(1);
  });

  it("keeps same tag text separate across categories", () => {
    const doc = makeDoc({
      domainTags: ["paper"],
      modelTags: ["paper"],
      sourceTag: "paper",
      typeTag: "paper",
    });

    insertDocument(doc);
    updateTagStatsForDocument(doc);

    const cloud = getTagCloud();
    const paperEntries = cloud.filter((entry) => entry.tag === "paper");

    expect(paperEntries.map((entry) => entry.category).sort()).toEqual([
      "domain",
      "model",
      "source",
      "type",
    ]);
  });
});
