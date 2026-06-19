/**
 * Tag system — statistics, cloud, filtering.
 */

import { getDb } from "./index";
import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagInfo {
  tag: string;
  category: "domain" | "source" | "model" | "type" | "year";
  count: number;
}

// ---------------------------------------------------------------------------
// Tag cloud
// ---------------------------------------------------------------------------

export function getTagCloud(options?: { category?: string; limit?: number }): TagInfo[] {
  const db = getDb();
  let sql = "SELECT tag, category, count FROM tag_stats WHERE 1=1";
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

  const rows = db.prepare(sql).all(...params) as { tag: string; category: string; count: number }[];
  return rows.map((r) => ({ tag: r.tag, category: r.category as TagInfo["category"], count: r.count }));
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

  let sql = `
    SELECT * FROM documents
    WHERE
      EXISTS (SELECT 1 FROM json_each(domain_tags) WHERE value = ?)
      OR EXISTS (SELECT 1 FROM json_each(model_tags) WHERE value = ?)
      OR source = ?
      OR source_tag = ?
      OR type_tag = ?
      OR CAST(year_tag AS TEXT) = ?
  `;
  const params: (string | number)[] = [tag, tag, tag, tag, tag, tag];

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
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
     FROM documents
     WHERE
       EXISTS (SELECT 1 FROM json_each(domain_tags) WHERE value = ?)
       OR EXISTS (SELECT 1 FROM json_each(model_tags) WHERE value = ?)
       OR source = ?
       OR source_tag = ?
       OR type_tag = ?
       OR CAST(year_tag AS TEXT) = ?`,
    )
    .get(tag, tag, tag, tag, tag, tag) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Refresh tag stats
// ---------------------------------------------------------------------------

export function refreshTagStats(): void {
  const db = getDb();

  const refreshAll = db.transaction(() => {
    db.prepare("DELETE FROM tag_stats").run();

    // Domain tags
    const domainRows = db
      .prepare("SELECT domain_tags FROM documents WHERE domain_tags IS NOT NULL AND domain_tags != '[]'")
      .all() as { domain_tags: string }[];

    const domainCounts = new Map<string, number>();
    for (const row of domainRows) {
      try {
        const tags = JSON.parse(row.domain_tags) as string[];
        for (const tag of tags) {
          domainCounts.set(tag, (domainCounts.get(tag) ?? 0) + 1);
        }
      } catch {
        // ignore
      }
    }

    const insert = db.prepare("INSERT INTO tag_stats(tag, category, count) VALUES (?, ?, ?)");
    for (const [tag, count] of domainCounts) {
      insert.run(tag, "domain", count);
    }

    // Model tags
    const modelRows = db
      .prepare("SELECT model_tags FROM documents WHERE model_tags IS NOT NULL AND model_tags != '[]'")
      .all() as { model_tags: string }[];

    const modelCounts = new Map<string, number>();
    for (const row of modelRows) {
      try {
        const tags = JSON.parse(row.model_tags) as string[];
        for (const tag of tags) {
          modelCounts.set(tag, (modelCounts.get(tag) ?? 0) + 1);
        }
      } catch {
        // ignore
      }
    }
    for (const [tag, count] of modelCounts) {
      insert.run(tag, "model", count);
    }

    // Source tags
    const sourceRows = db
      .prepare("SELECT source_tag, COUNT(*) as count FROM documents GROUP BY source_tag")
      .all() as { source_tag: string; count: number }[];
    for (const row of sourceRows) {
      insert.run(row.source_tag, "source", row.count);
    }

    // Type tags
    const typeRows = db
      .prepare("SELECT type_tag, COUNT(*) as count FROM documents GROUP BY type_tag")
      .all() as { type_tag: string; count: number }[];
    for (const row of typeRows) {
      insert.run(row.type_tag, "type", row.count);
    }

    // Year tags
    const yearRows = db
      .prepare("SELECT year_tag, COUNT(*) as count FROM documents GROUP BY year_tag")
      .all() as { year_tag: number; count: number }[];
    for (const row of yearRows) {
      insert.run(String(row.year_tag), "year", row.count);
    }

    console.log(`[tags] Refreshed stats: ${domainCounts.size} domain, ${modelCounts.size} model tags`);
  });

  refreshAll();
}

// ---------------------------------------------------------------------------
// Incremental update (call when new document inserted)
// ---------------------------------------------------------------------------

export function updateTagStatsForDocument(doc: Document): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO tag_stats(tag, category, count) VALUES (?, ?, 1) ON CONFLICT(tag, category) DO UPDATE SET count = count + 1, last_updated = CURRENT_TIMESTAMP",
  );

  for (const tag of doc.domainTags) {
    insert.run(tag, "domain");
  }
  for (const tag of doc.modelTags) {
    insert.run(tag, "model");
  }
  insert.run(doc.sourceTag, "source");
  insert.run(doc.typeTag, "type");
  insert.run(String(doc.yearTag), "year");
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    isSummarized: Boolean(row.is_summarized),
  };
}
