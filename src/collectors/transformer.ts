/**
 * Data transformer — converts RawDocument to standardized Document.
 */

import crypto from "node:crypto";
import type { RawDocument, Document, DocumentSource, DocumentType } from "@/types";

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export function rawToDocument(raw: RawDocument): Document {
  const source = raw.source as DocumentSource;
  const id = hashId(source, raw.url);
  const now = new Date().toISOString();
  const year = extractYear(raw.publishedAt);
  const typeTag = inferTypeTag(source);

  return {
    id,
    title: raw.title,
    source,
    url: raw.url,
    publishedAt: raw.publishedAt,
    authors: raw.authors,
    abstract: raw.abstract,
    fullText: raw.content,
    fullTextPath: undefined,
    language: raw.language,
    domainTags: [], // filled in Phase 2
    sourceTag: raw.source,
    typeTag,
    yearTag: year,
    modelTags: [], // filled in Phase 2
    summaryZh: undefined,
    summaryEn: undefined,
    createdAt: now,
    updatedAt: now,
    isSummarized: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashId(source: string, url: string): string {
  return crypto.createHash("sha256").update(`${source}:${url}`).digest("hex").slice(0, 16);
}

function extractYear(isoDate: string): number {
  try {
    return new Date(isoDate).getFullYear();
  } catch {
    return new Date().getFullYear();
  }
}

function inferTypeTag(source: DocumentSource): DocumentType {
  switch (source) {
    case "arxiv":
      return "paper";
    case "gpt_blog":
    case "claude_blog":
      return "blog";
    default:
      return "blog";
  }
}
