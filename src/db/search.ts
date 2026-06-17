/**
 * Full-text search (FTS5) and vector search (sqlite-vec) module.
 */

import { getDb } from "./index";
import { getDocumentById } from "./documents";
import { generateEmbedding, EMBEDDING_DIMENSION } from "@/embedding";
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

// ---------------------------------------------------------------------------
// FTS5 keyword search
// ---------------------------------------------------------------------------

export function searchFts5(options: Fts5SearchOptions): SearchResult[] {
  const db = getDb();
  const limit = Math.min(options.limit ?? 20, SEARCH_RESULT_LIMIT_CAP);
  const offset = Math.max(options.offset ?? 0, 0);

  // Build prefix query: "term*" for each term, joined with AND
  const terms = options.query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `${t}*`);

  if (terms.length === 0) return [];

  const ftsQuery = terms.join(" AND ");

  // Base SQL
  let sql = `
    SELECT d.*, rank
    FROM document_fts fts
    JOIN documents d ON d.rowid = fts.rowid
    WHERE document_fts MATCH ?
  `;
  const params: (string | number)[] = [ftsQuery];

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

  sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    document: rowToDocument(row),
    score: normalizeRank(Number(row["rank"])),
    matchType: "fts",
    snippet: buildSnippet(rowToDocument(row), options.query),
  }));
}

function normalizeRank(rank: number): number {
  // FTS5 rank is negative (lower = better). Convert to 0–1.
  const r = Math.abs(rank);
  return Math.max(0, Math.min(1, 1 - r / 10));
}

function buildSnippet(document: Document, query: string): string | undefined {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return undefined;

  const candidates = [document.title, document.abstract];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const matchIndex = terms
      .map((term) => lower.indexOf(term))
      .find((index) => index >= 0);

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

  const rows = db.prepare(sql).all(serializedEmbedding, totalIndexed) as {
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

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: String(row.id),
    title: String(row.title),
    source: String(row.source) as Document["source"],
    url: String(row.url),
    publishedAt: String(row.published_at),
    authors: JSON.parse(String(row.authors ?? "[]")),
    abstract: String(row.abstract ?? ""),
    fullTextPath: row.full_text_path ? String(row.full_text_path) : undefined,
    language: String(row.language) as "zh" | "en",
    domainTags: JSON.parse(String(row.domain_tags ?? "[]")),
    sourceTag: String(row.source_tag),
    typeTag: String(row.type_tag) as Document["typeTag"],
    yearTag: Number(row.year_tag),
    modelTags: JSON.parse(String(row.model_tags ?? "[]")),
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
  db.prepare(
    "INSERT OR REPLACE INTO document_vectors(document_id, embedding) VALUES (?, ?)"
  ).run(documentId, serializeEmbedding(embedding));
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
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, received ${embedding.length}`
    );
  }

  const values = Float32Array.from(
    embedding.map((value) => (Number.isFinite(value) ? value : 0))
  );
  return Buffer.from(values.buffer);
}

function matchesSearchFilters(
  document: Document,
  filters: Pick<VectorSearchOptions, "sources" | "tags" | "dateRange">,
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
