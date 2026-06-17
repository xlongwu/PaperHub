/**
 * Document CRUD operations.
 * All methods use better-sqlite3 synchronous API for simplicity and performance.
 */

import type { Document, DocumentSource } from "@/types";
import { getDb } from "./index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface DocumentQueryOptions {
  limit?: number;
  offset?: number;
  source?: string;
  from?: string;
  to?: string;
}

function toDb(doc: Document): Record<string, unknown> {
  return {
    id: doc.id,
    title: doc.title,
    source: doc.source,
    url: doc.url,
    published_at: doc.publishedAt,
    authors: JSON.stringify(doc.authors),
    abstract: doc.abstract,
    full_text_path: doc.fullTextPath ?? null,
    language: doc.language,
    domain_tags: JSON.stringify(doc.domainTags),
    source_tag: doc.sourceTag,
    type_tag: doc.typeTag,
    year_tag: doc.yearTag,
    model_tags: JSON.stringify(doc.modelTags),
    summary_zh: doc.summaryZh ?? null,
    summary_en: doc.summaryEn ?? null,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    is_summarized: doc.isSummarized ? 1 : 0,
  };
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return parsed as T;
  } catch {
    return fallback;
  }
}

function fromDb(row: Record<string, unknown>): Document {
  return {
    id: String(row.id),
    title: String(row.title),
    source: String(row.source) as DocumentSource,
    url: String(row.url),
    publishedAt: String(row.published_at),
    authors: safeJsonParse<string[]>(row.authors, []),
    abstract: String(row.abstract ?? ""),
    fullTextPath: row.full_text_path ? String(row.full_text_path) : undefined,
    language: String(row.language) as "zh" | "en",
    domainTags: safeJsonParse<string[]>(row.domain_tags, []),
    sourceTag: String(row.source_tag),
    typeTag: String(row.type_tag) as "paper" | "blog" | "tutorial" | "review",
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
// CRUD
// ---------------------------------------------------------------------------

export function insertDocument(doc: Document): string {
  const db = getDb();
  const data = toDb(doc);
  const stmt = db.prepare(`
    INSERT INTO documents (
      id, title, source, url, published_at, authors, abstract,
      full_text_path, language, domain_tags, source_tag, type_tag,
      year_tag, model_tags, summary_zh, summary_en,
      created_at, updated_at, is_summarized
    ) VALUES (
      @id, @title, @source, @url, @published_at, @authors, @abstract,
      @full_text_path, @language, @domain_tags, @source_tag, @type_tag,
      @year_tag, @model_tags, @summary_zh, @summary_en,
      @created_at, @updated_at, @is_summarized
    )
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      abstract = excluded.abstract,
      authors = excluded.authors,
      updated_at = excluded.updated_at
  `);
  stmt.run(data);
  return doc.id;
}

export function getDocumentById(id: string): Document | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? fromDb(row) : null;
}

export function getDocumentByUrl(url: string): Document | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM documents WHERE url = ?").get(url) as Record<string, unknown> | undefined;
  return row ? fromDb(row) : null;
}

export function getDocumentsBySource(source: string): Document[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM documents WHERE source = ? ORDER BY published_at DESC").all(source) as Record<string, unknown>[];
  return rows.map(fromDb);
}

export function getDocumentsByTimeRange(start: string, end: string): Document[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM documents WHERE published_at >= ? AND published_at <= ? ORDER BY published_at DESC").all(start, end) as Record<string, unknown>[];
  return rows.map(fromDb);
}

function buildDocumentQuery(options?: DocumentQueryOptions): {
  whereSql: string;
  params: (string | number)[];
} {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options?.source) {
    where.push("source = ?");
    params.push(options.source);
  }

  if (options?.from) {
    where.push("published_at >= ?");
    params.push(options.from);
  }

  if (options?.to) {
    where.push("published_at <= ?");
    params.push(options.to);
  }

  return {
    whereSql: where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function getAllDocuments(options?: DocumentQueryOptions): Document[] {
  const db = getDb();
  const { whereSql, params } = buildDocumentQuery(options);
  let sql = `SELECT * FROM documents${whereSql}`;

  sql += " ORDER BY published_at DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += " OFFSET ?";
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(fromDb);
}

export function getPendingSummaryDocuments(limit = 100): Document[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM documents WHERE is_summarized = 0 ORDER BY published_at DESC LIMIT ?",
    )
    .all(Math.max(1, limit)) as Record<string, unknown>[];
  return rows.map(fromDb);
}

export function countDocuments(source?: string): number;
export function countDocuments(options?: Pick<DocumentQueryOptions, "source" | "from" | "to">): number;
export function countDocuments(
  sourceOrOptions?: string | Pick<DocumentQueryOptions, "source" | "from" | "to">,
): number {
  const db = getDb();
  const options =
    typeof sourceOrOptions === "string" ? { source: sourceOrOptions } : sourceOrOptions;
  const { whereSql, params } = buildDocumentQuery(options);
  const sql = `SELECT COUNT(*) as count FROM documents${whereSql}`;

  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function countDocumentsByDate(date: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM documents WHERE date(created_at) = date(?)").get(date) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function updateDocument(id: string, updates: Partial<Document>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) { sets.push("title = ?"); values.push(updates.title); }
  if (updates.abstract !== undefined) { sets.push("abstract = ?"); values.push(updates.abstract); }
  if (updates.summaryZh !== undefined) { sets.push("summary_zh = ?"); values.push(updates.summaryZh); }
  if (updates.summaryEn !== undefined) { sets.push("summary_en = ?"); values.push(updates.summaryEn); }
  if (updates.domainTags !== undefined) { sets.push("domain_tags = ?"); values.push(JSON.stringify(updates.domainTags)); }
  if (updates.modelTags !== undefined) { sets.push("model_tags = ?"); values.push(JSON.stringify(updates.modelTags)); }
  if (updates.isSummarized !== undefined) { sets.push("is_summarized = ?"); values.push(updates.isSummarized ? 1 : 0); }
  if (updates.fullTextPath !== undefined) { sets.push("full_text_path = ?"); values.push(updates.fullTextPath); }

  if (sets.length === 0) return;

  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function documentExists(url: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM documents WHERE url = ? LIMIT 1").get(url) as { 1: number } | undefined;
  return row !== undefined;
}

export function deleteDocument(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}
