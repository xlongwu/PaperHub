/**
 * Full-text search (FTS5) and vector search (sqlite-vec) module.
 */

import { getDb } from "./index";
import { getDocumentById } from "./documents";
import { generateEmbedding, EMBEDDING_DIMENSION } from "@/embedding";
import { analyzeSearchQuery, scoreDocumentAgainstQuery } from "@/search-query";
import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fts5SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  sources?: string[];
  tags?: string[];
  dateRange?: { start: string; end: string };
}

export interface VectorSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  threshold?: number;
  sources?: string[];
  tags?: string[];
  dateRange?: { start: string; end: string };
}

export interface SearchResult {
  document: Document;
  score: number; // 0–1, higher is better
  matchType: "fts" | "vector" | "hybrid";
  snippet?: string;
}

const SEARCH_RESULT_LIMIT_CAP = 1000;
const VECTOR_K_CAP = 200; // Prevent full-scan KNN when index grows large

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
    SELECT d.*, bm25(document_fts, 8.0, 2.0, 5.0) AS fts_rank
    FROM document_fts fts
    JOIN documents d ON d.rowid = fts.rowid
    WHERE document_fts MATCH ?
  `;
  const params: (string | number)[] = [analysis.ftsQuery];

  // Source filter
  if (options.sources && options.sources.length > 0) {
    const placeholders = options.sources.map(() => "?").join(",");
    sql += ` AND d.source IN (${placeholders})`;
    params.push(...options.sources);
  }

  // Tag filter (domain_tags or model_tags contains the tag)
  if (options.tags && options.tags.length > 0) {
    for (const tag of options.tags) {
      sql += `
        AND (
          EXISTS (SELECT 1 FROM json_each(d.domain_tags) WHERE value = ?)
          OR EXISTS (SELECT 1 FROM json_each(d.model_tags) WHERE value = ?)
        )
      `;
      params.push(tag, tag);
    }
  }

  if (options.dateRange) {
    sql += " AND d.published_at >= ? AND d.published_at <= ?";
    params.push(options.dateRange.start, options.dateRange.end);
  }

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
        snippet: buildSnippet(document, options.query),
        matchedConcepts: relevance.matchedConcepts,
      };
    })
    .filter((result) => result.matchedConcepts >= analysis.minimumLexicalMatches)
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

// ---------------------------------------------------------------------------
// Vector (semantic) search via sqlite-vec
// ---------------------------------------------------------------------------

export async function searchVector(options: VectorSearchOptions): Promise<SearchResult[]> {
  const db = getDb();
  const limit = Math.min(options.limit ?? 20, SEARCH_RESULT_LIMIT_CAP);
  const offset = Math.max(options.offset ?? 0, 0);
  const threshold = options.threshold ?? 0.5;

  // Generate query embedding
  const embedding = await generateEmbedding(options.query);
  const serializedEmbedding = serializeEmbedding(embedding);

  // sqlite-vec KNN search — expects compact JSON array string
  const sql = `
    SELECT document_id, distance
    FROM document_vectors
    WHERE embedding MATCH ?
      AND k = ?
    ORDER BY distance
  `;

  const totalIndexed = countIndexedVectors();
  if (totalIndexed === 0) {
    return [];
  }

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
    });
  }

  const filtered = results.filter((result) => result.score >= threshold);
  if (filtered.length > 0 || options.threshold !== undefined) {
    return filtered.slice(offset, offset + limit);
  }

  return results.slice(offset, offset + limit);
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
    fullTextPath: row.full_text_path ? String(row.full_text_path) : undefined,
    language: String(row.language) as "zh" | "en",
    domainTags: safeJsonParse<string[]>(row.domain_tags, []),
    sourceTag: String(row.source_tag),
    typeTag: String(row.type_tag) as Document["typeTag"],
    yearTag: Number(row.year_tag),
    modelTags: safeJsonParse<string[]>(row.model_tags, []),
    summaryZh: row.summary_zh ? String(row.summary_zh) : undefined,
    summaryEn: row.summary_en ? String(row.summary_en) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    isSummarized: Boolean(row.is_summarized),
  };
}

// ---------------------------------------------------------------------------
// Vector storage
// ---------------------------------------------------------------------------

export function storeVector(documentId: string, embedding: number[]): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO document_vectors(document_id, embedding) VALUES (?, ?)").run(
    documentId,
    serializeEmbedding(embedding),
  );
}

export async function indexDocumentVector(doc: Document): Promise<void> {
  const text = `${doc.title}\n${doc.abstract}\n${doc.domainTags.join(" ")}\n${doc.modelTags.join(" ")}`;
  const embedding = await generateEmbedding(text);
  storeVector(doc.id, embedding);
}

export function countIndexedVectors(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM document_vectors").get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function serializeEmbedding(embedding: number[]): Buffer {
  if (embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, received ${embedding.length}`,
    );
  }

  const values = Float32Array.from(embedding.map((value) => (Number.isFinite(value) ? value : 0)));
  return Buffer.from(values.buffer);
}

/**
 * Shared filter predicate used by both vector search and the hybrid-search
 * merge layer.  Kept in a single location so filters in both branches stay
 * in lockstep.
 */
export function matchesSearchFilters(
  document: Document,
  filters: { sources?: string[]; tags?: string[]; dateRange?: { start: string; end: string } },
): boolean {
  if (filters.sources && filters.sources.length > 0 && !filters.sources.includes(document.source)) {
    return false;
  }

  if (
    filters.tags &&
    filters.tags.length > 0 &&
    !filters.tags.every(
      (tag) =>
        document.domainTags.includes(tag) ||
        document.modelTags.includes(tag) ||
        document.source === tag ||
        document.sourceTag === tag ||
        document.typeTag === tag ||
        String(document.yearTag) === tag,
    )
  ) {
    return false;
  }

  if (
    filters.dateRange &&
    (document.publishedAt < filters.dateRange.start || document.publishedAt > filters.dateRange.end)
  ) {
    return false;
  }

  return true;
}
