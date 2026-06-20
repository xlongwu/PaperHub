import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, clearDbPath, getDb, initDatabase, setDbPath } from "@/db/index";
import { insertDocument } from "@/db/documents";
import { countIndexedVectors, indexDocumentVector } from "@/db/search";
import {
  activateEmbeddingRuntime,
  ensureEmbeddingIndexRuntime,
  getEmbeddingIndexMetadata,
} from "@/db/embedding-index";
import { getEmbeddingRuntime, resetEmbeddingRuntime } from "@/embedding";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-embedding-index.db");

beforeEach(() => {
  process.env["EMBEDDING_MOCK"] = "1";
  process.env["EMBEDDING_EXPECTED_DIMENSIONS"] = "64";
  resetEmbeddingRuntime();
  closeDb();
  safeUnlink(TEST_DB_PATH);
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterEach(() => {
  delete process.env["EMBEDDING_MOCK"];
  delete process.env["EMBEDDING_EXPECTED_DIMENSIONS"];
  delete process.env["EMBEDDING_PROVIDER"];
  delete process.env["OLLAMA_BASE_URL"];
  delete process.env["OLLAMA_EMBEDDING_MODEL"];
  delete process.env["EMBEDDING_TIMEOUT_MS"];
  resetEmbeddingRuntime();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  safeUnlink(TEST_DB_PATH);
});

describe("dynamic embedding index", () => {
  it("creates the sqlite-vec table with the runtime dimension", async () => {
    const document = makeDocument("dynamic-dimension");
    insertDocument(document);
    await indexDocumentVector(document);

    expect(vectorTableSql()).toContain("float[64]");
    expect(countIndexedVectors()).toBe(1);
    expect(getEmbeddingIndexMetadata()).toMatchObject({
      dimensions: 64,
      status: "ready",
    });
  });

  it("does not rebuild an unchanged runtime", async () => {
    const document = makeDocument("unchanged-runtime");
    insertDocument(document);
    await indexDocumentVector(document);

    const activation = ensureEmbeddingIndexRuntime(getEmbeddingRuntime());
    expect(activation.rebuilt).toBe(false);
    expect(countIndexedVectors()).toBe(1);
  });

  it("rebuilds when dimensions change", async () => {
    const document = makeDocument("dimension-change");
    insertDocument(document);
    await indexDocumentVector(document);

    process.env["EMBEDDING_EXPECTED_DIMENSIONS"] = "96";
    resetEmbeddingRuntime();
    const activation = ensureEmbeddingIndexRuntime(getEmbeddingRuntime());

    expect(activation.rebuilt).toBe(true);
    expect(vectorTableSql()).toContain("float[96]");
    expect(countIndexedVectors()).toBe(0);
    expect(indexState(document.id)).toMatchObject({
      embedding_status: "pending",
      vector_signature: null,
    });
  });

  it("rebuilds for a different signature even when dimensions match", async () => {
    const document = makeDocument("signature-change");
    insertDocument(document);
    await indexDocumentVector(document);

    const runtime = getEmbeddingRuntime();
    const activation = ensureEmbeddingIndexRuntime({
      ...runtime,
      model: "another-model",
      signature: `${runtime.signature}:another-model`,
    });

    expect(activation.rebuilt).toBe(true);
    expect(vectorTableSql()).toContain("float[64]");
    expect(countIndexedVectors()).toBe(0);
  });

  it("keeps the existing vectors when an Ollama probe fails", async () => {
    const document = makeDocument("probe-failure");
    insertDocument(document);
    await indexDocumentVector(document);
    const previous = getEmbeddingIndexMetadata();

    delete process.env["EMBEDDING_MOCK"];
    process.env["EMBEDDING_PROVIDER"] = "ollama";
    process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:1";
    process.env["OLLAMA_EMBEDDING_MODEL"] = "missing-model";
    process.env["EMBEDDING_TIMEOUT_MS"] = "100";
    resetEmbeddingRuntime();

    await expect(activateEmbeddingRuntime()).rejects.toMatchObject({
      code: "OLLAMA_UNREACHABLE",
    });
    expect(countIndexedVectors()).toBe(1);
    expect(getEmbeddingIndexMetadata()).toMatchObject({
      signature: previous?.signature,
      status: "ready",
    });
  });
});

function vectorTableSql(): string {
  return String(
    (
      getDb()
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_vectors_v2'")
        .get() as { sql: string }
    ).sql,
  );
}

function indexState(documentId: string): Record<string, unknown> {
  return getDb()
    .prepare(
      "SELECT embedding_status, vector_signature, vector_indexed_at FROM document_index_state WHERE document_id = ?",
    )
    .get(documentId) as Record<string, unknown>;
}

function makeDocument(id: string): Document {
  return {
    id,
    title: `Embedding index ${id}`,
    source: "arxiv",
    url: `https://example.com/${id}`,
    publishedAt: "2026-06-19T00:00:00Z",
    authors: ["Alice"],
    abstract: "Local embedding index migration test",
    language: "en",
    domainTags: ["Embedding"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
    isSummarized: false,
  };
}
