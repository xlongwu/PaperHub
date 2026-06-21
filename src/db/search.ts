/**
 * Full-text search (FTS5) and vector search (sqlite-vec) module.
 */

import { getDb } from "./index";
import { getDocumentById } from "./documents";
import {
  buildDocumentEmbeddingTextForRuntime,
  buildTagEmbeddingText,
  buildTitleAbstractEmbeddingText,
  generateEmbedding,
  generateEmbeddings,
  getEmbeddingRuntime,
  resolveEmbeddingRuntime,
} from "@/embedding";
import { analyzeSearchQuery, scoreDocumentAgainstQuery } from "@/search-query";
import type { Document } from "@/types";
import type { SearchMatchExplanation } from "@/search-contract";
import { collectDocumentCanonicalTags, getCanonicalTagId } from "@/canonical-tags";
import { resolveKnownSearchTag } from "./search-tags";
import {
  assertEmbeddingIndexReady,
  ensureEmbeddingIndexRuntime,
  finalizeEmbeddingIndex,
  getEmbeddingIndexMetadata,
  getEmbeddingIndexProgress,
} from "./embedding-index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fts5SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  dateRange?: { start: string; end: string };
}

export interface VectorSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  threshold?: number;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  dateRange?: { start: string; end: string };
}

export interface SearchResult {
  document: Document;
  score: number; // 0–1, higher is better
  matchType: "fts" | "vector" | "hybrid";
  snippet?: string;
  semanticScore?: number;
  matchedField?: string;
  explanation?: SearchMatchExplanation;
}

const SEARCH_RESULT_LIMIT_CAP = 1000;
const VECTOR_K_CAP = 800;

export class EmbeddingIndexUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EmbeddingIndexUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// FTS5 keyword search
// ---------------------------------------------------------------------------

export function searchFts5(options: Fts5SearchOptions): SearchResult[] {
  const db = getDb();
  const limit = Math.min(options.limit ?? 20, SEARCH_RESULT_LIMIT_CAP);
  const offset = Math.max(options.offset ?? 0, 0);
  const analysis = analyzeSearchQuery(options.query);
  if (analysis.concepts.length === 0) return [];

  // Base SQL
  let sql = `
    SELECT d.*,
      bm25(document_fts_v2, 10.0, 4.0, 2.5, 2.5, 1.5, 5.0, 0.5, 1.0) AS fts_rank,
      snippet(document_fts_v2, -1, '<mark>', '</mark>', '…', 24) AS fts_snippet
    FROM document_fts_v2 fts
    JOIN documents d ON d.rowid = fts.rowid
    WHERE document_fts_v2 MATCH ?
  `;
  const params: (string | number)[] = [analysis.strictFtsQuery];

  ({ sql } = appendSqlFilters(sql, params, options));

  const candidateLimit = Math.min(SEARCH_RESULT_LIMIT_CAP, Math.max(100, (offset + limit) * 5));
  sql += ` ORDER BY fts_rank LIMIT ?`;
  params.push(candidateLimit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  const ranked = rows
    .map((row, rankIndex) => {
      const document = rowToDocument(row);
      const relevance = scoreDocumentAgainstQuery(document, analysis);
      const rankScore = normalizeRank(rankIndex);

      return {
        document,
        score: Math.min(1, relevance.score * 0.9 + rankScore * 0.1),
        matchType: "fts" as const,
        snippet: String(row.fts_snippet ?? "") || buildSnippet(document, options.query),
        matchedConcepts: relevance.matchedConcepts,
      };
    })
    // No hard concept-hit filtering — concept coverage is a ranking signal, never a gate.
    // Documents with low concept coverage still rank low via the score formula above.
    .sort((a, b) => b.score - a.score);

  return ranked
    .slice(offset, offset + limit)
    .map(({ matchedConcepts: _matchedConcepts, ...result }) => result);
}

function normalizeRank(rankIndex: number): number {
  // Convert the BM25 candidate position into a small, stable tie-break score.
  const position = Math.max(0, rankIndex);
  return 1 / (1 + position * 0.08);
}

function buildSnippet(document: Document, query: string): string | undefined {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) return undefined;

  const candidates = [document.title, document.abstract];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const matchIndex = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0);

    if (matchIndex === undefined || matchIndex < 0) {
      continue;
    }

    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(candidate.length, matchIndex + 120);
    const rawSnippet = candidate.slice(start, end).trim();

    return terms.reduce((snippet, term) => {
      const matcher = new RegExp(`(${escapeRegExp(term)})`, "gi");
      return snippet.replace(matcher, "<mark>$1</mark>");
    }, rawSnippet);
  }

  return document.abstract.slice(0, 160) || document.title;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCjkSnippet(document: Document, term?: string): string | undefined {
  const fields = [document.summaryZh, document.title, document.abstract, document.summaryEn].filter(
    (value): value is string => Boolean(value),
  );
  if (!term) return fields[0]?.slice(0, 160);

  for (const field of fields) {
    const index = field.indexOf(term);
    if (index < 0) continue;
    const start = Math.max(0, index - 40);
    const end = Math.min(field.length, index + term.length + 80);
    return field.slice(start, end).replace(new RegExp(escapeRegExp(term), "g"), `<mark>${term}</mark>`);
  }
  return fields[0]?.slice(0, 160);
}

// ---------------------------------------------------------------------------
// Vector (semantic) search via sqlite-vec
// ---------------------------------------------------------------------------

export async function searchVector(options: VectorSearchOptions): Promise<SearchResult[]> {
  const db = getDb();
  const limit = Math.min(options.limit ?? 20, SEARCH_RESULT_LIMIT_CAP);
  const offset = Math.max(options.offset ?? 0, 0);
  const threshold = options.threshold ?? 0.5;

  const totalIndexed = countIndexedVectors();
  if (totalIndexed === 0) {
    throw new EmbeddingIndexUnavailableError("embedding_index_empty");
  }

  const runtime = await resolveEmbeddingRuntime();
  assertVectorSearchReady(runtime);

  // Generate query embedding
  const embedding = await generateEmbedding(options.query);
  const serializedEmbedding = serializeEmbedding(embedding, runtime.dimensions);

  // sqlite-vec KNN search — expects compact JSON array string
  const sql = `
    SELECT document_id, distance
    FROM document_vectors_v2
    WHERE embedding MATCH ?
      AND k = ?
    ORDER BY distance
  `;

  // Cap K to avoid loading the entire index into memory. For small indexes,
  // use totalIndexed so we don't artificially limit results.
  const kValue = Math.min(totalIndexed, VECTOR_K_CAP);

  const rows = db.prepare(sql).all(serializedEmbedding, kValue) as {
    document_id: string;
    distance: number;
  }[];

  const results: SearchResult[] = [];
  for (const row of rows) {
    const doc = getDocumentById(row.document_id);
    if (!doc) continue;

    // sqlite-vec distance is cosine distance (0 = identical, 2 = opposite)
    const similarity = 1 - row.distance / 2;
    if (!matchesSearchFilters(doc, options)) {
      continue;
    }

    results.push({
      document: doc,
      score: similarity,
      matchType: "vector",
      semanticScore: similarity,
    });
  }

  const filtered = results.filter((result) => result.score >= threshold);
  if (filtered.length > 0 || options.threshold !== undefined) {
    return filtered.slice(offset, offset + limit);
  }

  return results.slice(offset, offset + limit);
}

// ---------------------------------------------------------------------------
// Multi-path recall — Stage 3
// ---------------------------------------------------------------------------

/** Options common to all recall paths. */
export interface RecallOptions {
  limit: number;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  dateRange?: { start: string; end: string };
}

// ── Path 1: Exact title recall ────────────────────────────────────────────

/**
 * Exact title recall: AND of quoted concept phrases, BM25 ranked.
 * Targets high-precision exact matches.  Max 50 candidates.
 */
export function searchFts5Exact(exactTitleQuery: string, options: RecallOptions): SearchResult[] {
  return runFtsRecall(`title : (${exactTitleQuery})`, options, 50);
}

// ── Path 2: FTS strict recall ─────────────────────────────────────────────

/**
 * Strict FTS recall: AND of concept alternatives, BM25 ranked.
 * Balanced precision/recall. Max 100 candidates.
 */
export function searchFts5Strict(strictFtsQuery: string, options: RecallOptions): SearchResult[] {
  return runFtsRecall(strictFtsQuery, options, 100);
}

// ── Path 3: FTS broad recall ──────────────────────────────────────────────

/**
 * Broad FTS recall: OR of all aliases, high recall low precision.
 * Max 300 candidates.  No concept filtering — ranking handles quality.
 */
export function searchFts5Broad(broadFtsQuery: string, options: RecallOptions): SearchResult[] {
  return runFtsRecall(broadFtsQuery, options, 300);
}

// ── Path 4: CJK n-gram recall ─────────────────────────────────────────────

/**
 * Chinese/CJK recall via n-grams against title, summary_zh, and abstract.
 * Max 150 candidates.
 */
export function searchCjkNgram(cjkNgrams: string[], options: RecallOptions): SearchResult[] {
  if (!cjkNgrams || cjkNgrams.length === 0) return [];
  const db = getDb();
  const grams = [...new Set(cjkNgrams.filter((gram) => gram.length >= 2))].slice(0, 30);
  if (grams.length === 0) return [];

  const params: Array<string | number> = [];
  const gramClauses = grams.map(
    () => `
    (
      d.title LIKE ? OR d.abstract LIKE ? OR d.summary_zh LIKE ?
      OR d.summary_en LIKE ? OR d.domain_tags LIKE ? OR d.model_tags LIKE ?
    )
  `,
  );
  for (const gram of grams) {
    const pattern = `%${gram}%`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  let sql = `
    SELECT d.*
    FROM documents d
    WHERE (${gramClauses.join(" OR ")})
  `;
  ({ sql } = appendSqlFilters(sql, params, options));
  sql += " ORDER BY d.published_at DESC, d.id LIMIT ?";
  params.push(Math.min(options.limit, 150));

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows
    .map((row) => {
      const document = rowToDocument(row);
      const searchable = [
        document.title,
        document.abstract,
        document.summaryZh ?? "",
        document.summaryEn ?? "",
        ...document.domainTags,
        ...document.modelTags,
      ].join(" ");
      const matched = grams.filter((gram) => searchable.includes(gram));
      return {
        document,
        score: matched.length / grams.length,
        matchType: "fts" as const,
        snippet: buildCjkSnippet(document, matched[0]),
      };
    })
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));
}

function runFtsRecall(
  query: string,
  options: RecallOptions,
  cap: number,
  weights = [10.0, 4.0, 2.5, 2.5, 1.5, 5.0, 0.5, 1.0],
): SearchResult[] {
  if (!query) return [];
  const db = getDb();
  const limit = Math.min(options.limit, cap);
  const params: Array<string | number> = [query];
  let sql = `
    SELECT d.*,
      bm25(document_fts_v2, ${weights.join(", ")}) AS fts_rank,
      snippet(document_fts_v2, -1, '<mark>', '</mark>', '…', 24) AS fts_snippet
    FROM document_fts_v2 fts
    JOIN documents d ON d.rowid = fts.rowid
    WHERE document_fts_v2 MATCH ?
  `;
  ({ sql } = appendSqlFilters(sql, params, options));
  sql += " ORDER BY fts_rank, d.id LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row, index) => ({
    document: rowToDocument(row),
    score: normalizeRank(index),
    matchType: "fts" as const,
    snippet: String(row.fts_snippet ?? "") || undefined,
  }));
}

// ── Path 5: Vector semantic recall (adaptive oversampling) ─────────────────

/**
 * Vector recall with adaptive oversampling.
 * Starts at 200, increases to 400 → 800 if filtered results don't reach
 * 3 × the requested limit. This prevents the "filter-after-KNN" problem
 * where tag/source/date filters throw away most of the top-K results.
 */
export async function searchVectorAdaptive(
  query: string,
  options: RecallOptions & { threshold?: number },
): Promise<SearchResult[]> {
  const db = getDb();
  const minCandidates = options.limit * 3;
  const threshold = options.threshold ?? 0.58;

  const totalIndexed = countIndexedVectors();
  if (totalIndexed === 0) {
    throw new EmbeddingIndexUnavailableError("embedding_index_empty");
  }

  const runtime = await resolveEmbeddingRuntime();
  assertVectorSearchReady(runtime);
  const embedding = await generateEmbedding(query);
  const serializedEmbedding = serializeEmbedding(embedding, runtime.dimensions);

  const kSteps = [200, 400, 800];
  let bestResults: SearchResult[] = [];
  for (const k of kSteps) {
    const profiles = multiVectorEnabled()
      ? ([
          { table: "document_vectors_v2", weight: 0.5 },
          { table: "document_title_abstract_vectors_v2", weight: 0.35 },
          { table: "document_tag_vectors_v2", weight: 0.15 },
        ] as const)
      : ([{ table: "document_vectors_v2", weight: 1 }] as const);
    const fusedScores = new Map<
      string,
      { weightedScore: number; totalWeight: number; profileHits: number }
    >();
    let largestKValue = 0;

    for (const profile of profiles) {
      const indexed = countVectorRows(profile.table);
      if (indexed === 0) continue;
      const kValue = Math.min(indexed, k);
      largestKValue = Math.max(largestKValue, kValue);
      const rows = db
        .prepare(
          `
          SELECT document_id, distance
          FROM ${profile.table}
          WHERE embedding MATCH ?
            AND k = ?
          ORDER BY distance
        `,
        )
        .all(serializedEmbedding, kValue) as {
        document_id: string;
        distance: number;
      }[];
      for (const row of rows) {
        const similarity = 1 - row.distance / 2;
        const existing = fusedScores.get(row.document_id) ?? {
          weightedScore: 0,
          totalWeight: 0,
          profileHits: 0,
        };
        existing.weightedScore += similarity * profile.weight;
        existing.totalWeight += profile.weight;
        existing.profileHits++;
        fusedScores.set(row.document_id, existing);
      }
    }

    const results: SearchResult[] = [];
    for (const [documentId, fused] of fusedScores) {
      const doc = getDocumentById(documentId);
      if (!doc) continue;
      if (!matchesSearchFilters(doc, options)) continue;

      const similarity = fused.weightedScore / fused.totalWeight;
      if (similarity < threshold) continue;

      results.push({
        document: doc,
        score: similarity,
        semanticScore: similarity,
        matchType: "vector",
        matchedField: fused.profileHits > 1 ? "multi_vector" : "document",
      });
    }
    results.sort(
      (left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id),
    );
    bestResults = results;

    // Stop if we have enough candidates that pass filters
    if (results.length >= minCandidates || largestKValue >= totalIndexed) {
      return results.slice(0, options.limit);
    }
  }

  return bestResults.slice(0, options.limit);
}

function multiVectorEnabled(): boolean {
  const configured = process.env["PAPERHUB_MULTI_VECTOR"]?.trim().toLocaleLowerCase();
  return configured !== "off" && configured !== "false" && configured !== "0";
}

function countVectorRows(
  table: "document_vectors_v2" | "document_title_abstract_vectors_v2" | "document_tag_vectors_v2",
): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  } catch {
    return 0;
  }
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

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: String(row.id),
    title: String(row.title),
    source: String(row.source) as Document["source"],
    url: String(row.url),
    publishedAt: String(row.published_at),
    authors: safeJsonParse<string[]>(row.authors, []),
    abstract: String(row.abstract ?? ""),
    fullText: row.full_text ? String(row.full_text) : undefined,
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
}

// ---------------------------------------------------------------------------
// Vector storage
// ---------------------------------------------------------------------------

export function storeVector(documentId: string, embedding: number[], dimensions?: number): void {
  const db = getDb();
  const runtime = getEmbeddingRuntime();
  ensureEmbeddingIndexRuntime(runtime);
  const expectedDimensions = dimensions ?? runtime.dimensions;
  db.prepare("INSERT OR REPLACE INTO document_vectors_v2(document_id, embedding) VALUES (?, ?)").run(
    documentId,
    serializeEmbedding(embedding, expectedDimensions),
  );
  db.prepare(
    `
    INSERT INTO document_index_state(
      document_id, vector_signature, vector_indexed_at,
      embedding_status, embedding_attempts, last_error, updated_at
    ) VALUES (?, ?, datetime('now'), 'ready', 0, NULL, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      vector_signature = excluded.vector_signature,
      vector_indexed_at = excluded.vector_indexed_at,
      embedding_status = 'ready',
      embedding_attempts = 0,
      last_error = NULL,
      vector_error = NULL,
      vector_retry_count = 0,
      updated_at = datetime('now')
  `,
  ).run(documentId, runtime.signature);
  if (getEmbeddingIndexMetadata()?.status === "rebuilding") {
    finalizeEmbeddingIndex();
  }
}

export async function indexDocumentVector(doc: Document): Promise<void> {
  await indexDocumentVectors([doc]);
}

export async function indexDocumentVectors(documents: Document[]): Promise<void> {
  if (documents.length === 0) return;

  const db = getDb();
  const runtime = await resolveEmbeddingRuntime();
  ensureEmbeddingIndexRuntime(runtime);
  const metadata = getEmbeddingIndexMetadata();
  if (!metadata || !["ready", "rebuilding"].includes(metadata.status)) {
    throw new EmbeddingIndexUnavailableError(`embedding_index_${metadata?.status ?? "unconfigured"}`);
  }

  const markRunning = db.prepare(`
    INSERT INTO document_index_state (
      document_id, embedding_status, vector_signature, updated_at
    ) VALUES (?, 'running', ?, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      embedding_status = 'running',
      vector_signature = excluded.vector_signature,
      last_error = NULL,
      updated_at = datetime('now')
  `);
  const markReady = db.prepare(`
    INSERT INTO document_index_state (
      document_id, vector_signature, vector_indexed_at,
      embedding_status, embedding_attempts, last_error, updated_at
    )
    VALUES (?, ?, datetime('now'), 'ready', 0, NULL, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      vector_signature = excluded.vector_signature,
      vector_indexed_at = excluded.vector_indexed_at,
      embedding_status = 'ready',
      embedding_attempts = 0,
      last_error = NULL,
      vector_error = NULL,
      vector_retry_count = 0,
      updated_at = datetime('now')
  `);
  const store = db.prepare(
    "INSERT OR REPLACE INTO document_vectors_v2(document_id, embedding) VALUES (?, ?)",
  );

  const markBatchRunning = db.transaction(() => {
    for (const document of documents) markRunning.run(document.id, runtime.signature);
  });
  markBatchRunning();

  const texts = documents.flatMap((document) => [
    buildDocumentEmbeddingTextForRuntime(document, runtime),
    buildTitleAbstractEmbeddingText(document, runtime.maxInputChars),
    buildTagEmbeddingText(document, runtime.maxInputChars),
  ]);
  const embeddings = await generateEmbeddings(texts);
  const expectedEmbeddingCount = documents.length * 3;
  if (embeddings.length !== expectedEmbeddingCount) {
    throw new Error(
      `Embedding batch count mismatch: expected ${expectedEmbeddingCount}, received ${embeddings.length}`,
    );
  }

  const storeTitleAbstract = db.prepare(
    "INSERT OR REPLACE INTO document_title_abstract_vectors_v2(document_id, embedding) VALUES (?, ?)",
  );
  const storeTags = db.prepare(
    "INSERT OR REPLACE INTO document_tag_vectors_v2(document_id, embedding) VALUES (?, ?)",
  );
  const writeBatch = db.transaction(() => {
    documents.forEach((document, index) => {
      const embeddingOffset = index * 3;
      store.run(document.id, serializeEmbedding(embeddings[embeddingOffset]!, runtime.dimensions));
      storeTitleAbstract.run(
        document.id,
        serializeEmbedding(embeddings[embeddingOffset + 1]!, runtime.dimensions),
      );
      storeTags.run(document.id, serializeEmbedding(embeddings[embeddingOffset + 2]!, runtime.dimensions));
      markReady.run(document.id, runtime.signature);
    });
  });
  writeBatch();

  if (metadata.status === "rebuilding") {
    finalizeEmbeddingIndex();
  }
}

export function countIndexedVectors(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM document_vectors_v2").get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

/**
 * Get documents that need vector indexing (not yet indexed or stale signature).
 */
export function getPendingVectorDocuments(limit = 50): Document[] {
  const db = getDb();
  const runtime = getEmbeddingRuntime();
  const rows = db
    .prepare(
      `
    SELECT d.*
    FROM documents d
    LEFT JOIN document_index_state s ON d.id = s.document_id
    WHERE s.vector_indexed_at IS NULL
       OR s.vector_signature != ?
       OR s.embedding_status = 'pending'
       OR (s.embedding_status = 'failed' AND s.embedding_attempts < 5)
       OR d.updated_at > s.vector_indexed_at
    ORDER BY d.published_at DESC
    LIMIT ?
  `,
    )
    .all(runtime.signature, limit) as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function markVectorIndexFailed(documentId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getDb()
    .prepare(
      `
      UPDATE document_index_state
      SET embedding_status = 'failed',
          embedding_attempts = embedding_attempts + 1,
          last_error = ?,
          vector_error = ?,
          vector_retry_count = vector_retry_count + 1,
          updated_at = datetime('now')
      WHERE document_id = ?
    `,
    )
    .run(message.slice(0, 1000), message.slice(0, 1000), documentId);
}

/**
 * Get aggregated index state statistics for monitoring.
 */
export function getIndexStateStats(): {
  total: number;
  ftsIndexed: number;
  vectorIndexed: number;
  vectorPending: number;
  vectorErrors: number;
} {
  const progress = getEmbeddingIndexProgress();

  return {
    total: progress.total,
    ftsIndexed: countFtsDocuments(),
    vectorIndexed: progress.ready,
    vectorPending: progress.pending + progress.running,
    vectorErrors: progress.failed,
  };
}

function serializeEmbedding(embedding: number[], expectedDimensions: number): Buffer {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDimensions}, received ${embedding.length}`,
    );
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite numeric value");
  }

  const values = Float32Array.from(embedding);
  return Buffer.from(values.buffer);
}

function assertVectorSearchReady(runtime: Awaited<ReturnType<typeof resolveEmbeddingRuntime>>): void {
  try {
    assertEmbeddingIndexReady(runtime);
  } catch (error) {
    throw new EmbeddingIndexUnavailableError(
      error instanceof Error ? error.message : "embedding_index_unavailable",
    );
  }
}

/**
 * Shared filter predicate used by both vector search and the hybrid-search
 * merge layer.  Kept in a single location so filters in both branches stay
 * in lockstep.
 */
export function matchesSearchFilters(
  document: Document,
  filters: {
    sources?: string[];
    tags?: string[];
    tagMatchMode?: "any" | "all";
    allTags?: string[];
    anyTags?: string[];
    excludeTags?: string[];
    dateRange?: { start: string; end: string };
  },
): boolean {
  if (filters.sources && filters.sources.length > 0 && !filters.sources.includes(document.source)) {
    return false;
  }

  const normalized = normalizeFilterTags(filters);
  const documentTags = new Set(collectDocumentCanonicalTags(document).map((entry) => entry.canonicalTag));
  if (!normalized.allTags.every((tag) => documentTags.has(tag))) return false;
  if (normalized.anyTags.length > 0 && !normalized.anyTags.some((tag) => documentTags.has(tag))) {
    return false;
  }
  if (normalized.excludeTags.some((tag) => documentTags.has(tag))) return false;

  if (
    filters.dateRange &&
    (document.publishedAt < filters.dateRange.start || document.publishedAt > filters.dateRange.end)
  ) {
    return false;
  }

  return true;
}

export function hasIndexedSearchTag(tag: string): boolean {
  return resolveKnownSearchTag(tag) !== null;
}

function appendSqlFilters(
  sql: string,
  params: Array<string | number>,
  options: {
    sources?: string[];
    tags?: string[];
    tagMatchMode?: "any" | "all";
    allTags?: string[];
    anyTags?: string[];
    excludeTags?: string[];
    dateRange?: { start: string; end: string };
  },
): { sql: string } {
  if (options.sources?.length) {
    sql += ` AND d.source IN (${options.sources.map(() => "?").join(",")})`;
    params.push(...options.sources);
  }

  const tags = normalizeFilterTags(options);
  if (tags.allTags.length > 0) {
    sql += `
      AND d.id IN (
        SELECT document_id
        FROM document_search_tags
        WHERE canonical_tag IN (${tags.allTags.map(() => "?").join(",")})
        GROUP BY document_id
        HAVING COUNT(DISTINCT canonical_tag) = ?
      )`;
    params.push(...tags.allTags, tags.allTags.length);
  }
  if (tags.anyTags.length > 0) {
    sql += `
      AND EXISTS (
        SELECT 1 FROM document_search_tags st
        WHERE st.document_id = d.id
          AND st.canonical_tag IN (${tags.anyTags.map(() => "?").join(",")})
      )`;
    params.push(...tags.anyTags);
  }
  if (tags.excludeTags.length > 0) {
    sql += `
      AND NOT EXISTS (
        SELECT 1 FROM document_search_tags st
        WHERE st.document_id = d.id
          AND st.canonical_tag IN (${tags.excludeTags.map(() => "?").join(",")})
      )`;
    params.push(...tags.excludeTags);
  }

  if (options.dateRange) {
    sql += " AND d.published_at >= ? AND d.published_at <= ?";
    params.push(options.dateRange.start, options.dateRange.end);
  }
  return { sql };
}

function normalizeFilterTags(filters: {
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
}): {
  allTags: string[];
  anyTags: string[];
  excludeTags: string[];
} {
  const legacy = (filters.tags ?? []).map(getCanonicalTagId);
  return {
    allTags: [
      ...(filters.allTags ?? []).map(getCanonicalTagId),
      ...(filters.tagMatchMode === "any" ? [] : legacy),
    ],
    anyTags: [
      ...(filters.anyTags ?? []).map(getCanonicalTagId),
      ...(filters.tagMatchMode === "any" ? legacy : []),
    ],
    excludeTags: (filters.excludeTags ?? []).map(getCanonicalTagId),
  };
}

function countFtsDocuments(): number {
  try {
    const row = getDb().prepare("SELECT COUNT(*) AS count FROM document_fts_v2").get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}
