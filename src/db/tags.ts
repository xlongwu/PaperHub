/**
 * Tag system — statistics, cloud, filtering.
 */

import { getDb } from "./index";
import type { Document } from "@/types";
import { getCanonicalTagAlternatives, getCanonicalTagDisplayName } from "@/canonical-tags";
import { resolveKnownSearchTag } from "./search-tags";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagInfo {
  tag: string;
  category: "domain" | "model" | "method" | "task" | "source" | "type" | "year";
  count: number;
  canonicalTag?: string;
  aliases?: string[];
}

// ---------------------------------------------------------------------------
// Tag cloud
// ---------------------------------------------------------------------------

export function getTagCloud(options?: { category?: string; limit?: number }): TagInfo[] {
  const db = getDb();
  let sql = `
    SELECT
      ts.tag,
      ts.category,
      ts.count,
      COALESCE(
        (
          SELECT st.raw_tag
          FROM document_search_tags st
          WHERE st.canonical_tag = ts.tag AND st.category = ts.category
          ORDER BY st.raw_tag
          LIMIT 1
        ),
        ts.tag
      ) AS display_tag
    FROM tag_stats ts
    WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.category) {
    sql += " AND category = ?";
    params.push(options.category);
  }

  sql += " ORDER BY count DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    tag: string;
    category: string;
    count: number;
    display_tag: string;
  }>;
  return rows.map((r) => ({
    tag: getCanonicalTagDisplayName(r.tag) === r.tag ? r.display_tag : getCanonicalTagDisplayName(r.tag),
    canonicalTag: r.tag,
    aliases: getCanonicalTagAlternatives(r.tag),
    category: r.category as TagInfo["category"],
    count: r.count,
  }));
}

// ---------------------------------------------------------------------------
// Documents by tag
// ---------------------------------------------------------------------------

export function getDocumentsByTag(
  tag: string,
  options?: { limit?: number; offset?: number; sortBy?: "time" | "relevance" },
): Document[] {
  const db = getDb();
  const limit = Math.min(options?.limit ?? 20, 100);
  const offset = options?.offset ?? 0;
  const canonicalTag = resolveKnownSearchTag(tag);
  if (!canonicalTag) return [];

  let sql = `
    SELECT DISTINCT d.*
    FROM documents d
    JOIN document_search_tags st ON st.document_id = d.id
    WHERE st.canonical_tag = ?
  `;
  const params: (string | number)[] = [canonicalTag];

  if (options?.sortBy === "relevance") {
    sql += " ORDER BY is_summarized DESC, published_at DESC";
  } else {
    sql += " ORDER BY published_at DESC";
  }

  sql += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(documentFromRow);
}

export function countDocumentsByTag(tag: string): number {
  const db = getDb();
  const canonicalTag = resolveKnownSearchTag(tag);
  if (!canonicalTag) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM (
         SELECT DISTINCT document_id
         FROM document_search_tags
         WHERE canonical_tag = ?
       )`,
    )
    .get(canonicalTag) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Refresh tag stats
// ---------------------------------------------------------------------------

export function refreshTagStats(): void {
  const db = getDb();

  const refreshAll = db.transaction(() => {
    db.prepare("DELETE FROM tag_stats").run();

    const insert = db.prepare("INSERT INTO tag_stats(tag, category, count) VALUES (?, ?, ?)");
    const rows = db
      .prepare(
        `SELECT canonical_tag, category, COUNT(DISTINCT document_id) AS count
         FROM document_search_tags
         GROUP BY canonical_tag, category`,
      )
      .all() as Array<{ canonical_tag: string; category: string; count: number }>;
    for (const row of rows) {
      insert.run(row.canonical_tag, row.category, row.count);
    }

    console.log(`[tags] Refreshed stats: ${rows.length} canonical tag entries`);
  });

  refreshAll();
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

function documentFromRow(row: Record<string, unknown>): Document {
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
