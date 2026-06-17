/**
 * Database CRUD tests.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { initDatabase, closeDb, setDbPath, clearDbPath } from "@/db/index";
import {
  insertDocument,
  getDocumentById,
  getDocumentByUrl,
  getDocumentsBySource,
  getDocumentsByTimeRange,
  getAllDocuments,
  countDocuments,
  updateDocument,
  documentExists,
  deleteDocument,
} from "@/db/documents";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-test.db");

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: "test-id-1",
    title: "Test Paper",
    source: "arxiv",
    url: "https://arxiv.org/abs/1234.5678",
    publishedAt: "2026-06-15T00:00:00Z",
    authors: ["Alice", "Bob"],
    abstract: "This is a test abstract.",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("insertDocument", () => {
  it("inserts a new document and returns its id", () => {
    const doc = makeDoc();
    const id = insertDocument(doc);
    expect(id).toBe(doc.id);
    expect(documentExists(doc.url)).toBe(true);
  });

  it("updates on conflict (same url)", () => {
    const doc = makeDoc();
    insertDocument(doc);

    const updated = makeDoc({ title: "Updated Title" });
    insertDocument(updated);

    const fetched = getDocumentById(doc.id);
    expect(fetched?.title).toBe("Updated Title");
  });
});

describe("getDocumentById", () => {
  it("returns null for missing document", () => {
    expect(getDocumentById("missing")).toBeNull();
  });

  it("returns the document after insert", () => {
    const doc = makeDoc();
    insertDocument(doc);
    const fetched = getDocumentById(doc.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe(doc.title);
    expect(fetched?.authors).toEqual(["Alice", "Bob"]);
  });
});

describe("getDocumentByUrl", () => {
  it("finds document by URL", () => {
    const doc = makeDoc();
    insertDocument(doc);
    const fetched = getDocumentByUrl(doc.url);
    expect(fetched?.id).toBe(doc.id);
  });
});

describe("getDocumentsBySource", () => {
  it("filters by source", () => {
    insertDocument(makeDoc({ id: "a1", url: "https://a/1", source: "arxiv" }));
    insertDocument(makeDoc({ id: "b1", url: "https://b/1", source: "gpt_blog" }));

    const arxivDocs = getDocumentsBySource("arxiv");
    expect(arxivDocs.length).toBe(1);
    expect(arxivDocs[0]!.id).toBe("a1");
  });
});

describe("getDocumentsByTimeRange", () => {
  it("filters by published date range", () => {
    insertDocument(makeDoc({ id: "d1", url: "https://d/1", publishedAt: "2026-06-10T00:00:00Z" }));
    insertDocument(makeDoc({ id: "d2", url: "https://d/2", publishedAt: "2026-06-20T00:00:00Z" }));

    const docs = getDocumentsByTimeRange("2026-06-01", "2026-06-15");
    expect(docs.length).toBe(1);
    expect(docs[0]!.id).toBe("d1");
  });
});

describe("getAllDocuments", () => {
  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      insertDocument(makeDoc({ id: `p${i}`, url: `https://p/${i}` }));
    }

    const page = getAllDocuments({ limit: 2, offset: 0 });
    expect(page.length).toBe(2);
  });
});

describe("countDocuments", () => {
  it("counts total documents", () => {
    insertDocument(makeDoc({ id: "c1", url: "https://c/1" }));
    insertDocument(makeDoc({ id: "c2", url: "https://c/2" }));
    expect(countDocuments()).toBe(2);
  });

  it("counts by source", () => {
    insertDocument(makeDoc({ id: "s1", url: "https://s/1", source: "arxiv" }));
    insertDocument(makeDoc({ id: "s2", url: "https://s/2", source: "gpt_blog" }));
    expect(countDocuments("arxiv")).toBe(1);
  });
});

describe("updateDocument", () => {
  it("updates specific fields", () => {
    const doc = makeDoc();
    insertDocument(doc);

    updateDocument(doc.id, { summaryZh: "中文摘要", isSummarized: true });

    const fetched = getDocumentById(doc.id);
    expect(fetched?.summaryZh).toBe("中文摘要");
    expect(fetched?.isSummarized).toBe(true);
  });
});

describe("documentExists", () => {
  it("returns false for unknown URL", () => {
    expect(documentExists("https://unknown")).toBe(false);
  });

  it("returns true for existing URL", () => {
    const doc = makeDoc();
    insertDocument(doc);
    expect(documentExists(doc.url)).toBe(true);
  });
});

describe("deleteDocument", () => {
  it("removes the document", () => {
    const doc = makeDoc();
    insertDocument(doc);
    deleteDocument(doc.id);
    expect(getDocumentById(doc.id)).toBeNull();
  });
});
