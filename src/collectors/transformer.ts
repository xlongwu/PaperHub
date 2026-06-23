/**
 * Data transformer — converts RawDocument to standardized Document.
 */

import crypto from "node:crypto";
import type {
  RawDocument,
  Document,
  DocumentDiscovery,
  DocumentExternalIds,
  DocumentOrigin,
  DocumentSource,
  DocumentType,
} from "@/types";

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export function rawToDocument(raw: RawDocument): Document {
  const source = raw.source as DocumentSource;
  const id = hashId(source, raw.url);
  const now = new Date().toISOString();
  const year = extractYear(raw.publishedAt);
  const typeTag = inferTypeTag(source, raw.metadata);

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
    externalIds: asObject(raw.metadata?.externalIds) as DocumentExternalIds | undefined,
    canonicalUrl: stringValue(raw.metadata?.canonicalUrl),
    origin: asObject(raw.metadata?.origin) as DocumentOrigin | undefined,
    discovery: asObject(raw.metadata?.discovery) as DocumentDiscovery | undefined,
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

function inferTypeTag(source: DocumentSource, metadata?: Record<string, unknown>): DocumentType {
  const contentType = stringValue(metadata?.contentType);
  if (contentType === "paper") return "paper";
  if (contentType === "documentation" || contentType === "repository") return "tutorial";
  if (contentType === "official_blog" || contentType === "technical_article") return "blog";
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
