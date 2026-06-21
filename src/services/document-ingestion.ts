/**
 * Unified document ingestion service.
 *
 * All collection paths (scheduler, API manual collection) funnel through this
 * service.  It is the single place where:
 *   - dedup checks happen
 *   - tags are applied
 *   - documents are inserted into the database
 *   - canonical tag indexes and stats are updated
 *   - vector indexing is scheduled
 *
 * No caller should directly compose insertDocument + updateTagStats — they
 * should go through ingestDocuments.
 */

import { rawToDocument } from "@/collectors/transformer";
import {
  findDocumentByCanonicalUrl,
  findDocumentByExternalIds,
  getDocumentByUrl,
  insertDocument,
} from "@/db/documents";
import { applyDocumentTags } from "@/tagger/apply";
import { findDuplicateByTitle } from "@/utils/dedup";
import type { RawDocument } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestionResult {
  inserted: number;
  skipped: number;
  errors: number;
  details: Array<{
    documentId: string;
    title: string;
    status: "inserted" | "duplicate" | "error";
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Main ingestion function
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of raw documents from any collector.
 * Handles dedup → tagging → insert → tag stats → vector scheduling.
 */
export async function ingestDocuments(rawDocs: RawDocument[]): Promise<IngestionResult> {
  const result: IngestionResult = {
    inserted: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  const vectorQueue: string[] = [];

  for (const raw of rawDocs) {
    const doc = rawToDocument(raw);

    // Dedup: URL exact match or title fuzzy match
    const duplicate =
      (doc.externalIds ? findDocumentByExternalIds(doc.externalIds) : null) ??
      (doc.canonicalUrl ? findDocumentByCanonicalUrl(doc.canonicalUrl) : null) ??
      getDocumentByUrl(doc.url) ??
      findDuplicateByTitle(doc.title);
    if (duplicate) {
      result.skipped++;
      result.details.push({
        documentId: duplicate.id,
        title: doc.title,
        status: "duplicate",
      });
      continue;
    }

    try {
      // Apply domain/model tags
      await applyDocumentTags(doc, raw);

      // Insert into documents table (FTS triggers auto-sync FTS index)
      insertDocument(doc);

      // Schedule vector indexing (non-blocking)
      vectorQueue.push(doc.id);

      result.inserted++;
      result.details.push({
        documentId: doc.id,
        title: doc.title,
        status: "inserted",
      });
    } catch (e) {
      result.errors++;
      result.details.push({
        documentId: doc.id,
        title: doc.title,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Batch-enqueue for background vector indexing
  if (vectorQueue.length > 0) {
    // Dynamic import to avoid circular dependency at module level
    const { enqueueVectorIndexing } = await import("@/search-indexer");
    enqueueVectorIndexing(vectorQueue);
  }

  return result;
}

/**
 * Simplified single-document ingestion for paths where only one doc is
 * produced (e.g. manual creation).
 */
export async function ingestSingleDocument(raw: RawDocument): Promise<{
  documentId: string;
  status: "inserted" | "duplicate" | "error";
  error?: string;
}> {
  const result = await ingestDocuments([raw]);
  return (
    result.details[0] ?? {
      documentId: "",
      title: raw.title,
      status: "error",
      error: "No details produced",
    }
  );
}
