/**
 * Evaluation corpus management and query loading.
 *
 * Provides utilities for:
 * - Seeding the Phase 6 fixture corpus into a test database
 * - Loading evaluation queries from JSON
 * - Computing per-query results against the search engine
 */

import fs from "node:fs";
import path from "node:path";
import { initDatabase, setDbPath, getDb } from "@/db/index";
import { insertDocument } from "@/db/documents";
import { indexDocumentVector } from "@/db/search";
import { generateEmbedding } from "@/embedding";
import { hybridSearch } from "@/search";
import { createPhase6FixtureDocuments } from "@/test-support/phase6-fixtures";
import type { EvaluationQuery, QueryResult } from "./metrics";
import { computeQueryMetrics } from "./metrics";
import type { Document } from "@/types";
import { collectDocumentCanonicalTags } from "@/canonical-tags";
import { getConceptMatchEvidence } from "@/search-query";

// ---------------------------------------------------------------------------
// Corpus management
// ---------------------------------------------------------------------------

const EVAL_DB_DIR = path.resolve(process.cwd(), ".tmp", "evaluation");

export function getEvalDbPath(): string {
  return path.join(EVAL_DB_DIR, "search-eval.db");
}

/**
 * Ensure the evaluation corpus is seeded into the evaluation database.
 * Re-seeds if the corpus has changed or the DB doesn't exist.
 */
export function ensureCorpus(corpusType: "phase6" | "full" = "phase6"): {
  size: number;
  documentIds: string[];
} {
  const dbPath = getEvalDbPath();
  fs.mkdirSync(EVAL_DB_DIR, { recursive: true });
  process.env["EMBEDDING_MOCK"] = "1";

  // Clean start: remove old DB to avoid schema conflicts
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ok if not exists */
  }

  // Always re-seed for reproducible evaluations
  setDbPath(dbPath);
  initDatabase();

  const docs = corpusType === "phase6" ? createPhase6FixtureDocuments() : loadFullCorpus();

  // Clear and re-insert
  const db = getDb();
  db.exec("DELETE FROM documents");
  // Also clear vectors to avoid UNIQUE constraint on re-insert
  try {
    db.exec("DELETE FROM document_vectors");
  } catch {
    /* table may not exist */
  }

  for (const doc of docs) {
    insertDocument(doc);
  }

  const documentIds = docs.map((d) => d.id);

  return { size: docs.length, documentIds };
}

/**
 * Generate mock embeddings for all documents in the corpus.
 * Uses EMBEDDING_MOCK=1 for deterministic test vectors.
 */
export async function indexCorpusVectors(concurrency = 4): Promise<number> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM documents").all() as Record<string, unknown>[];

  let indexed = 0;
  const queue = [...rows];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) return;

      const doc: Document = {
        id: String(row.id),
        title: String(row.title),
        source: String(row.source) as Document["source"],
        url: String(row.url),
        publishedAt: String(row.published_at),
        authors: safeJsonParse<string[]>(row.authors, []),
        abstract: String(row.abstract ?? ""),
        fullTextPath: row.full_text_path ? String(row.full_text_path) : undefined,
        language: String(row.language) as "zh" | "en",
        domainTags: safeJsonParse<string[]>(row.domain_tags, []),
        sourceTag: String(row.source_tag),
        typeTag: String(row.type_tag) as Document["typeTag"],
        yearTag: Number(row.year_tag),
        modelTags: safeJsonParse<string[]>(row.model_tags, []),
        summaryZh: row.summary_zh ? String(row.summary_zh) : undefined,
        summaryEn: row.summary_en ? String(row.summary_en) : undefined,
        summaryZhLevel: row.summary_zh_level
          ? (String(row.summary_zh_level) as Document["summaryZhLevel"])
          : undefined,
        summaryEnLevel: row.summary_en_level
          ? (String(row.summary_en_level) as Document["summaryEnLevel"])
          : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        isSummarized: Boolean(row.is_summarized),
      };

      await indexDocumentVector(doc);
      indexed++;
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return indexed;
}

// ---------------------------------------------------------------------------
// Query loading
// ---------------------------------------------------------------------------

/**
 * Load evaluation queries from a JSON file.
 */
export function loadSearchQueries(
  corpusPath?: string,
  corpusType: "phase6" | "full" = "phase6",
): EvaluationQuery[] {
  if (corpusType === "full") {
    return buildBenchmarkQueries(loadBenchmarkTopics());
  }
  const defaultPath = path.resolve(process.cwd(), "tests", "fixtures", "search-queries.json");
  const filePath = corpusPath ?? defaultPath;

  if (!fs.existsSync(filePath)) {
    console.warn(`[eval] Query file not found: ${filePath}. Using empty set.`);
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    queries: Array<{
      queryId: string;
      query: string;
      language?: string;
      mode?: string;
      relevantDocIds: string[];
      relevanceGrades?: Record<string, number>;
      category?: string;
      notes?: string;
      allTags?: string[];
      anyTags?: string[];
      excludeTags?: string[];
      sources?: string[];
      dateRange?: { start: string; end: string };
      mustConcepts?: string[];
      shouldConcepts?: string[];
      excludeConcepts?: string[];
    }>;
  };

  return raw.queries.map((q) => ({
    queryId: q.queryId,
    query: q.query,
    language: (q.language as "zh" | "en") ?? "en",
    relevantDocIds: q.relevantDocIds,
    relevanceGrades: q.relevanceGrades,
    category: q.category,
    mode: (q.mode as "keyword" | "semantic" | "hybrid") ?? "hybrid",
    allTags: q.allTags,
    anyTags: q.anyTags,
    excludeTags: q.excludeTags,
    sources: q.sources,
    dateRange: q.dateRange,
    mustConcepts: q.mustConcepts,
    shouldConcepts: q.shouldConcepts,
    excludeConcepts: q.excludeConcepts,
  }));
}

// ---------------------------------------------------------------------------
// Search execution
// ---------------------------------------------------------------------------

/**
 * Run all evaluation queries against the search engine and collect results.
 */
export async function runEvaluationQueries(
  queries: EvaluationQuery[],
  engineVersion: "v1" | "v2" = "v1",
): Promise<QueryResult[]> {
  // Set engine version for the evaluation run
  process.env["PAPERHUB_SEARCH_ENGINE"] = engineVersion;

  const results: QueryResult[] = [];

  for (const q of queries) {
    const startTime = Date.now();

    try {
      const response = await hybridSearch({
        query: q.query,
        mode: q.mode,
        limit: 20,
        allTags: q.allTags,
        anyTags: q.anyTags,
        excludeTags: q.excludeTags,
        sources: q.sources,
        dateRange: q.dateRange,
        mustConcepts: q.mustConcepts,
        shouldConcepts: q.shouldConcepts,
        excludeConcepts: q.excludeConcepts,
      });

      const latencyMs = Date.now() - startTime;
      const resultDocIds = response.results.map((r) => r.document.id);
      const zeroResult = response.results.length === 0;
      const queryPlan = response.queryPlan;
      const constraintViolations = queryPlan
        ? response.results.filter((result) => !satisfiesQueryPlan(result.document, queryPlan)).length
        : 0;
      const allTagMatches =
        queryPlan && queryPlan.filters.allTags.length > 0
          ? response.results.filter((result) => {
              const tags = new Set(
                collectDocumentCanonicalTags(result.document).map((entry) => entry.canonicalTag),
              );
              return queryPlan.filters.allTags.every((tag) => tags.has(tag));
            }).length
          : undefined;
      const mustConceptCoverage =
        queryPlan && queryPlan.concepts.must.length > 0 && response.results.length > 0
          ? response.results.reduce(
              (sum, result) =>
                sum + getConceptMatchEvidence(result.document, queryPlan.concepts.must).coverage,
              0,
            ) / response.results.length
          : queryPlan?.concepts.must.length
            ? 0
            : undefined;

      results.push({
        queryId: q.queryId,
        query: q.query,
        mode: q.mode,
        category: q.category,
        results: response.results.map((r, i) => ({
          documentId: r.document.id,
          score: r.score,
          rank: i + 1,
        })),
        relevantDocIds: q.relevantDocIds,
        relevanceGrades: q.relevanceGrades,
        latencyMs,
        metrics: computeQueryMetrics(q, resultDocIds, 10),
        zeroResult,
        constraintViolations,
        allTagMatches,
        mustConceptCoverage,
        relaxedResultCount: response.results.filter((result) => result.explanation?.tier === "relaxed")
          .length,
        conjunctive:
          (queryPlan?.concepts.must.length ?? 0) > 1 || (queryPlan?.filters.allTags.length ?? 0) > 1,
      });
    } catch {
      const latencyMs = Date.now() - startTime;
      results.push({
        queryId: q.queryId,
        query: q.query,
        mode: q.mode,
        results: [],
        relevantDocIds: q.relevantDocIds,
        relevanceGrades: q.relevanceGrades,
        latencyMs,
        metrics: { recallAt10: 0, ndcgAt10: 0, mrrAt10: 0, precisionAt5: 0 },
        zeroResult: true,
        constraintViolations: 0,
        relaxedResultCount: 0,
        conjunctive: (q.mustConcepts?.length ?? 0) > 1 || (q.allTags?.length ?? 0) > 1,
      });
    }
  }

  return results;
}

function satisfiesQueryPlan(
  document: Document,
  queryPlan: NonNullable<Awaited<ReturnType<typeof hybridSearch>>["queryPlan"]>,
): boolean {
  const tags = new Set(collectDocumentCanonicalTags(document).map((entry) => entry.canonicalTag));
  if (!queryPlan.filters.allTags.every((tag) => tags.has(tag))) return false;
  if (queryPlan.filters.anyTags.length > 0 && !queryPlan.filters.anyTags.some((tag) => tags.has(tag))) {
    return false;
  }
  if (queryPlan.filters.excludeTags.some((tag) => tags.has(tag))) return false;
  if (queryPlan.filters.sources.length > 0 && !queryPlan.filters.sources.includes(document.source)) {
    return false;
  }
  if (
    queryPlan.filters.dateRange &&
    (document.publishedAt < queryPlan.filters.dateRange.start ||
      document.publishedAt > queryPlan.filters.dateRange.end)
  ) {
    return false;
  }
  const mustEvidence = getConceptMatchEvidence(document, queryPlan.concepts.must);
  const required =
    queryPlan.concepts.must.length <= 2
      ? queryPlan.concepts.must.length
      : Math.ceil(queryPlan.concepts.must.length * 0.75);
  if (mustEvidence.matchedConcepts.length < required) return false;
  return getConceptMatchEvidence(document, queryPlan.concepts.exclude).matchedConcepts.length === 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return parsed as T;
  } catch {
    return fallback;
  }
}

function loadFullCorpus(): Document[] {
  return buildBenchmarkDocuments(loadBenchmarkTopics());
}

interface BenchmarkTopic {
  id: string;
  query: string;
  title: string;
  category: string;
  aliases?: string[];
  zh?: string;
  tags?: string[];
}

function loadBenchmarkTopics(): BenchmarkTopic[] {
  const corpusPath = path.resolve(process.cwd(), "tests", "fixtures", "search-corpus.json");
  const parsed = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as {
    topics: BenchmarkTopic[];
  };
  return parsed.topics;
}

function buildBenchmarkDocuments(topics: BenchmarkTopic[]): Document[] {
  const sources: Document["source"][] = ["arxiv", "gpt_blog", "claude_blog"];
  return topics.flatMap((topic, topicIndex) =>
    Array.from({ length: 5 }, (_, variantIndex) => {
      const source = sources[(topicIndex + variantIndex) % sources.length]!;
      const id = `benchmark-${topic.id}-${variantIndex + 1}`;
      const aliases = topic.aliases?.join(", ") ?? topic.query;
      return {
        id,
        title: `${topic.title}: ${["Survey", "Methods", "Evaluation", "Systems", "Applications"][variantIndex]}`,
        source,
        url: `https://example.com/${id}`,
        publishedAt: `2026-${String((topicIndex % 6) + 1).padStart(2, "0")}-${String(variantIndex + 10).padStart(2, "0")}T00:00:00Z`,
        authors: [`Benchmark Author ${topicIndex + 1}`],
        abstract: `${topic.query}. This document focuses on ${aliases} with reproducible methods and evaluation.`,
        language: "en" as const,
        domainTags: topic.tags ?? [topic.title],
        sourceTag: source === "arxiv" ? "arXiv" : source === "gpt_blog" ? "GPT Blog" : "Claude Blog",
        typeTag: source === "arxiv" ? ("paper" as const) : ("blog" as const),
        yearTag: 2026,
        modelTags: [],
        summaryZh: topic.zh ? `${topic.zh}的研究、方法与评估。` : undefined,
        summaryEn: `${topic.title} research, methods, and evaluation.`,
        createdAt: "2026-06-18T00:00:00Z",
        updatedAt: "2026-06-18T00:00:00Z",
        isSummarized: true,
      };
    }),
  );
}

function buildBenchmarkQueries(topics: BenchmarkTopic[]): EvaluationQuery[] {
  return topics.flatMap((topic) => {
    const relevantDocIds = Array.from({ length: 5 }, (_, index) => `benchmark-${topic.id}-${index + 1}`);
    const variants = [
      topic.query,
      topic.aliases?.[0] ?? topic.query,
      `${topic.query} methods`,
      `${topic.query} evaluation`,
      topic.zh ?? `${topic.query} applications`,
    ];
    return variants.map((query, index) => ({
      queryId: `${topic.id}-${index + 1}`,
      query,
      language: topic.zh && query === topic.zh ? ("zh" as const) : ("en" as const),
      relevantDocIds,
      relevanceGrades: Object.fromEntries(
        relevantDocIds.map((id, gradeIndex) => [id, Math.max(1, 3 - Math.floor(gradeIndex / 2))]),
      ),
      mode:
        index === 1 || index === 2
          ? ("keyword" as const)
          : index === 4 && !topic.zh
            ? ("semantic" as const)
            : ("hybrid" as const),
      category: topic.category,
    }));
  });
}

/**
 * Generate deterministic mock embeddings for evaluation purposes.
 * Uses the same SHA-256 based mock as EMBEDDING_MOCK=1.
 */
export async function generateMockEmbedding(text: string): Promise<number[]> {
  return generateEmbedding(text);
}
