import type Database from "better-sqlite3";
import {
  collectDocumentCanonicalTags,
  getCanonicalTagDefinition,
  getCanonicalTagId,
  normalizeCanonicalAlias,
} from "@/canonical-tags";
import type { Document } from "@/types";
import { getDb } from "./index";

export function replaceDocumentSearchTags(document: Document, db: Database.Database = getDb()): void {
  const remove = db.prepare("DELETE FROM document_search_tags WHERE document_id = ?");
  const insert = db.prepare(
    `INSERT INTO document_search_tags(
       document_id, canonical_tag, raw_tag, category, confidence
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  const write = db.transaction(() => {
    remove.run(document.id);
    for (const tag of collectDocumentCanonicalTags(document)) {
      insert.run(document.id, tag.canonicalTag, tag.rawTag, tag.category, tag.confidence);
    }
  });
  write();
}

export function rebuildDocumentSearchTags(db: Database.Database = getDb()): number {
  const documentsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get();
  if (!documentsTable) return 0;

  const rows = db.prepare("SELECT * FROM documents").all() as Record<string, unknown>[];
  const removeAll = db.prepare("DELETE FROM document_search_tags");
  const insert = db.prepare(
    `INSERT INTO document_search_tags(
       document_id, canonical_tag, raw_tag, category, confidence
     ) VALUES (?, ?, ?, ?, ?)`,
  );

  const rebuild = db.transaction(() => {
    removeAll.run();
    for (const row of rows) {
      const document = documentFromRow(row);
      for (const tag of collectDocumentCanonicalTags(document)) {
        insert.run(document.id, tag.canonicalTag, tag.rawTag, tag.category, tag.confidence);
      }
    }
  });
  rebuild();
  return rows.length;
}

export function resolveKnownSearchTag(rawTag: string): string | null {
  const canonicalTag = getCanonicalTagId(rawTag);
  if (getCanonicalTagDefinition(canonicalTag)) return canonicalTag;

  const normalized = normalizeCanonicalAlias(rawTag);
  const row = getDb()
    .prepare(
      `SELECT canonical_tag
       FROM document_search_tags
       WHERE canonical_tag = ?
          OR lower(replace(replace(raw_tag, '-', ''), ' ', '')) = ?
       LIMIT 1`,
    )
    .get(canonicalTag, normalized) as { canonical_tag: string } | undefined;
  return row?.canonical_tag ?? null;
}

export function resolveKnownSearchTags(rawTags: string[]): {
  canonicalTags: string[];
  unknownTags: string[];
} {
  const canonicalTags: string[] = [];
  const unknownTags: string[] = [];
  for (const rawTag of rawTags) {
    const normalized = rawTag.trim();
    if (!normalized) continue;
    const canonicalTag = resolveKnownSearchTag(normalized);
    if (!canonicalTag) {
      unknownTags.push(normalized);
    } else if (!canonicalTags.includes(canonicalTag)) {
      canonicalTags.push(canonicalTag);
    }
  }
  return { canonicalTags, unknownTags };
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw ?? "")) as T;
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
    fullText: row.full_text ? String(row.full_text) : undefined,
    fullTextPath: row.full_text_path ? String(row.full_text_path) : undefined,
    language: String(row.language) as Document["language"],
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
