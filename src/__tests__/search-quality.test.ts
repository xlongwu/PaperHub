import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDbPath, closeDb, getDb, initDatabase, setDbPath } from "@/db/index";
import {
  countIndexedVectors,
  getIndexStateStats,
  getPendingVectorDocuments,
  indexDocumentVector,
  markVectorIndexFailed,
  storeVector,
} from "@/db/search";
import { deleteDocument, insertDocument, updateDocument } from "@/db/documents";
import { generateEmbedding } from "@/embedding";
import { hybridSearch } from "@/search";
import { stopIndexer } from "@/search-indexer";
import {
  getSearchQualityStats,
  markSearchReformulated,
  recordSearchClick,
  recordSearchEvent,
} from "@/db/search-events";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const DB_PATH = testPath("paperhub-search-quality.db");

function doc(overrides: Partial<Document> & Pick<Document, "id" | "title">): Document {
  return {
    id: overrides.id,
    title: overrides.title,
    source: overrides.source ?? "arxiv",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    publishedAt: overrides.publishedAt ?? "2026-06-18T00:00:00Z",
    authors: overrides.authors ?? ["Researcher"],
    abstract: overrides.abstract ?? "",
    fullText: overrides.fullText,
    language: overrides.language ?? "en",
    domainTags: overrides.domainTags ?? [],
    sourceTag: overrides.sourceTag ?? "arXiv",
    typeTag: overrides.typeTag ?? "paper",
    yearTag: overrides.yearTag ?? 2026,
    modelTags: overrides.modelTags ?? [],
    summaryZh: overrides.summaryZh,
    summaryEn: overrides.summaryEn,
    createdAt: overrides.createdAt ?? "2026-06-18T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-06-18T00:00:00Z",
    isSummarized: overrides.isSummarized ?? false,
  };
}

beforeEach(() => {
  process.env["PAPERHUB_SEARCH_ENGINE"] = "v2";
  process.env["EMBEDDING_MOCK"] = "1";
  closeDb();
  safeUnlink(DB_PATH);
  setDbPath(DB_PATH);
  initDatabase();
});

afterEach(() => {
  stopIndexer();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  safeUnlink(DB_PATH);
  delete process.env["PAPERHUB_SEARCH_ENGINE"];
  delete process.env["EMBEDDING_MOCK"];
  delete process.env["PAPERHUB_RERANKER"];
});

describe("search quality regression coverage", () => {
  it("matches a Chinese medical imaging query against an English paper", async () => {
    insertDocument(
      doc({
        id: "medical-diffusion",
        title: "Diffusion Models for Medical Image Synthesis",
        abstract: "A diffusion approach for medical imaging.",
        summaryZh: "医学图像扩散模型用于影像合成。",
      }),
    );

    const result = await hybridSearch({
      query: "医学图像扩散模型",
      mode: "keyword",
    });
    expect(result.results.map((entry) => entry.document.id)).toContain("medical-diffusion");
  });

  it("does not let a vector-only result bypass must-concept coverage", async () => {
    const semanticDoc = doc({
      id: "semantic-only",
      title: "Latent State Compression",
      abstract: "A compact representation method for long-running systems.",
    });
    insertDocument(semanticDoc);
    storeVector(semanticDoc.id, await generateEmbedding("how agents remember earlier conversations"));

    const result = await hybridSearch({
      query: "how agents remember earlier conversations",
      mode: "hybrid",
    });
    expect(result.results.map((entry) => entry.document.id)).not.toContain("semantic-only");
  });

  it("normalizes LLM and GPT4 aliases", async () => {
    insertDocument(
      doc({
        id: "aliases",
        title: "GPT-4 Evaluation for Large Language Models",
        modelTags: ["GPT-4", "Large Language Model"],
      }),
    );

    const llm = await hybridSearch({ query: "LLM evaluation", mode: "keyword" });
    const gpt = await hybridSearch({ query: "GPT4 evaluation", mode: "keyword" });
    expect(llm.results[0]?.document.id).toBe("aliases");
    expect(gpt.results[0]?.document.id).toBe("aliases");
  });

  it("supports distinct ANY and ALL tag filtering", async () => {
    insertDocument(doc({ id: "agents-only", title: "Agent Search", domainTags: ["Agents"] }));
    insertDocument(
      doc({
        id: "agents-rag",
        title: "Agent RAG Search",
        domainTags: ["Agents", "RAG"],
      }),
    );

    const any = await hybridSearch({
      query: "search",
      mode: "keyword",
      tags: ["Agents", "RAG"],
      tagMatchMode: "any",
    });
    const all = await hybridSearch({
      query: "search",
      mode: "keyword",
      tags: ["Agents", "RAG"],
      tagMatchMode: "all",
    });
    expect(any.results).toHaveLength(2);
    expect(all.results.map((entry) => entry.document.id)).toEqual(["agents-rag"]);
  });

  it("rejects an unknown tag instead of silently turning it into a topic", async () => {
    insertDocument(
      doc({
        id: "synthetic-llm",
        title: "Synthetic Data Generation for Large Language Models",
        abstract: "A synthetic dataset pipeline for LLM training.",
        domainTags: ["ML"],
        modelTags: ["LLM"],
      }),
    );
    insertDocument(
      doc({
        id: "unrelated-llm",
        title: "LLM Compiler Optimization",
        abstract: "Compiler tuning with large language models.",
        domainTags: ["ML"],
        modelTags: ["LLM"],
      }),
    );

    await expect(
      hybridSearch({
        query: "帮我搜集一些与大模型数据合成相关的论文和博客",
        mode: "keyword",
        allTags: ["not-a-real-tag"],
      }),
    ).rejects.toMatchObject({
      code: "UNKNOWN_TAG",
      details: { unknownTags: ["not-a-real-tag"] },
    });
  });

  it("does not remove a valid tag when the filtered search has no matches", async () => {
    insertDocument(
      doc({
        id: "agent-memory",
        title: "Agent Memory",
        domainTags: ["Agents"],
      }),
    );
    insertDocument(
      doc({
        id: "ml-synthetic",
        title: "Synthetic Data Generation",
        domainTags: ["ML"],
      }),
    );

    const result = await hybridSearch({
      query: "synthetic data",
      mode: "keyword",
      tags: ["Agents"],
    });

    expect(result.appliedTags).toEqual(["agent"]);
    expect(result.topicTerms).toEqual([]);
    expect(result.results).toHaveLength(0);
  });

  it("enforces all, any, and exclude tags in the final result set", async () => {
    insertDocument(
      doc({
        id: "joint-tags",
        title: "Joint Tag Search",
        domainTags: ["Agents", "RAG"],
        modelTags: ["LLM"],
      }),
    );
    insertDocument(
      doc({
        id: "partial-tags",
        title: "Partial Tag Search",
        domainTags: ["Agents"],
        modelTags: ["GPT-4"],
      }),
    );

    const result = await hybridSearch({
      query: "tag search",
      mode: "keyword",
      allTags: ["Agents", "RAG"],
      anyTags: ["LLM"],
      excludeTags: ["GPT-4"],
    });

    expect(result.results.map((entry) => entry.document.id)).toEqual(["joint-tags"]);
    expect(result.queryPlan?.filters).toMatchObject({
      allTags: ["agent", "rag"],
      anyTags: ["llm"],
      excludeTags: ["gpt"],
    });
    expect(result.results[0]?.explanation?.matchedTags).toEqual(["agent", "rag", "llm"]);
  });

  it("finds LLM and synthetic-data intersections using derived method tags", async () => {
    insertDocument(
      doc({
        id: "llm-synthetic-intersection",
        title: "Synthetic Data Generation for LLM Training",
        abstract: "A data synthesis pipeline for large language model instruction tuning.",
        domainTags: ["LLM"],
      }),
    );
    insertDocument(
      doc({
        id: "llm-without-synthetic",
        title: "Efficient LLM Inference",
        abstract: "Serving large language models with lower latency.",
        domainTags: ["LLM"],
      }),
    );

    const result = await hybridSearch({
      query: "LLM, synthetic-data",
      mode: "keyword",
      allTags: ["LLM", "synthetic-data"],
      anyTags: ["LLM", "synthetic-data"],
    });

    expect(result.queryPlan?.filters.anyTags).toEqual([]);
    expect(result.results.map((entry) => entry.document.id)).toEqual(["llm-synthetic-intersection"]);
  });

  it("defaults legacy multi-tag filters to intersection semantics", async () => {
    insertDocument(doc({ id: "legacy-agent", title: "Legacy Filter", domainTags: ["Agents"] }));
    insertDocument(doc({ id: "legacy-joint", title: "Legacy Filter Joint", domainTags: ["Agents", "RAG"] }));

    const result = await hybridSearch({
      query: "legacy filter",
      mode: "keyword",
      tags: ["Agents", "RAG"],
    });

    expect(result.results.map((entry) => entry.document.id)).toEqual(["legacy-joint"]);
  });

  it("rejects incomplete, invalid, and reversed date ranges", async () => {
    await expect(
      hybridSearch({
        query: "agent memory",
        dateRange: { start: "2026-06-01T00:00:00Z", end: "" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });

    await expect(
      hybridSearch({
        query: "agent memory",
        dateRange: { start: "not-a-date", end: "2026-06-30T00:00:00Z" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });

    await expect(
      hybridSearch({
        query: "agent memory",
        dateRange: {
          start: "2026-06-30T00:00:00Z",
          end: "2026-06-01T00:00:00Z",
        },
      }),
    ).rejects.toMatchObject({ code: "FILTER_CONFLICT" });
  });

  it("invalidates stale vectors on update and removes both indexes on delete", async () => {
    const lifecycleDoc = doc({ id: "lifecycle", title: "LegacyAlpha Search Title" });
    insertDocument(lifecycleDoc);
    await indexDocumentVector(lifecycleDoc);
    expect(countIndexedVectors()).toBe(1);
    expect(
      (
        getDb().prepare("SELECT COUNT(*) AS count FROM document_title_abstract_vectors_v2").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM document_tag_vectors_v2").get() as { count: number })
        .count,
    ).toBe(1);

    updateDocument(lifecycleDoc.id, { title: "ModernBeta Search Title" });
    expect(countIndexedVectors()).toBe(0);
    expect(
      (
        getDb().prepare("SELECT COUNT(*) AS count FROM document_title_abstract_vectors_v2").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM document_tag_vectors_v2").get() as { count: number })
        .count,
    ).toBe(0);
    expect((await hybridSearch({ query: "legacyalpha", mode: "keyword" })).results).toHaveLength(0);
    expect((await hybridSearch({ query: "modernbeta", mode: "keyword" })).results[0]?.document.id).toBe(
      "lifecycle",
    );

    await indexDocumentVector({
      ...lifecycleDoc,
      title: "ModernBeta Search Title",
      updatedAt: new Date().toISOString(),
    });
    deleteDocument(lifecycleDoc.id);
    expect(countIndexedVectors()).toBe(0);
    expect(getIndexStateStats().total).toBe(0);
  });

  it("marks failed embeddings and makes signature changes pending", async () => {
    const pendingDoc = doc({ id: "pending", title: "Pending Vector" });
    insertDocument(pendingDoc);
    await indexDocumentVector(pendingDoc);
    getDb()
      .prepare("UPDATE document_index_state SET vector_signature = 'old:model:1536' WHERE document_id = ?")
      .run(pendingDoc.id);
    expect(getPendingVectorDocuments(10).map((item) => item.id)).toContain(pendingDoc.id);

    markVectorIndexFailed(pendingDoc.id, new Error("temporary failure"));
    const state = getDb()
      .prepare(
        "SELECT embedding_status, embedding_attempts, last_error FROM document_index_state WHERE document_id = ?",
      )
      .get(pendingDoc.id) as {
      embedding_status: string;
      embedding_attempts: number;
      last_error: string;
    };
    expect(state.embedding_status).toBe("failed");
    expect(state.embedding_attempts).toBeGreaterThan(0);
    expect(state.last_error).toContain("temporary failure");
  });

  it("reports keyword fallback when semantic search is unavailable", async () => {
    delete process.env["EMBEDDING_MOCK"];
    delete process.env["EMBEDDING_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    insertDocument(doc({ id: "fallback", title: "Keyword Fallback Search" }));

    const result = await hybridSearch({
      query: "keyword fallback",
      mode: "hybrid",
    });
    expect(result.modeUsed).toBe("keyword_fallback");
    expect(result.results[0]?.document.id).toBe("fallback");
  });

  it("returns stable non-overlapping pages", async () => {
    for (let index = 0; index < 12; index++) {
      insertDocument(
        doc({
          id: `stable-${index}`,
          title: `Stable Paging Search ${index}`,
          publishedAt: `2026-06-${String(18 - index).padStart(2, "0")}T00:00:00Z`,
        }),
      );
    }
    const first = await hybridSearch({
      query: "stable paging",
      mode: "keyword",
      limit: 5,
      offset: 0,
    });
    const second = await hybridSearch({
      query: "stable paging",
      mode: "keyword",
      limit: 5,
      cursor: first.nextCursor,
    });
    const firstIds = new Set(first.results.map((entry) => entry.document.id));
    expect(second.results.every((entry) => !firstIds.has(entry.document.id))).toBe(true);
    expect(first.nextCursor).toBeTruthy();
  });

  it("reports configurable local reranker metadata without changing hard constraints", async () => {
    insertDocument(
      doc({
        id: "reranker-hit",
        title: "Agent Memory Compression",
        domainTags: ["Agents", "Memory"],
      }),
    );

    const enabled = await hybridSearch({
      query: "agent memory",
      mode: "keyword",
      allTags: ["Agents", "Memory"],
    });
    expect(enabled.reranker?.provider).toBe("local");
    expect(enabled.results[0]?.document.id).toBe("reranker-hit");

    process.env["PAPERHUB_RERANKER"] = "off";
    const disabled = await hybridSearch({
      query: "agent memory",
      mode: "keyword",
      allTags: ["Agents", "Memory"],
    });
    expect(disabled.reranker?.provider).toBe("off");
    expect(disabled.results[0]?.document.id).toBe("reranker-hit");
    delete process.env["PAPERHUB_RERANKER"];
  });

  it("derives anonymous failure queries and hard negatives from search feedback", () => {
    insertDocument(doc({ id: "negative-a", title: "Failure Candidate A" }));
    insertDocument(doc({ id: "negative-b", title: "Failure Candidate B" }));

    recordSearchEvent({
      query: "agent memory",
      queryType: "concept_intersection",
      mode: "hybrid",
      modeUsed: "hybrid",
      resultCount: 2,
      latencyMs: 20,
      resultDocumentIds: ["negative-a", "negative-b"],
    });
    const clickedEvent = recordSearchEvent({
      query: "agent memory",
      queryType: "concept_intersection",
      mode: "hybrid",
      modeUsed: "hybrid",
      resultCount: 2,
      latencyMs: 25,
      resultDocumentIds: ["negative-a", "negative-b"],
    });
    recordSearchClick({ eventId: clickedEvent, documentId: "negative-b", rank: 2 });
    markSearchReformulated(clickedEvent);

    const stats = getSearchQualityStats();
    expect(stats.noClickRate).toBe(0.5);
    expect(stats.clickMrr).toBe(0.25);
    expect(stats.byQueryType.concept_intersection).toMatchObject({
      searches: 2,
      noClickRate: 0.5,
      reformulationRate: 0.5,
    });
    expect(stats.failureQueries[0]?.failures).toBe(2);
    expect(stats.hardNegativeDocumentIds).toEqual(expect.arrayContaining(["negative-a", "negative-b"]));
  });
});
