import { getDb } from "./index";
import type {
  EvidenceChunk,
  WebSearchCitation,
  WebSearchSummary,
  WebSearchSynthesis,
} from "@/web-search/types";

export interface CachedWebContent {
  cacheKey: string;
  url: string;
  canonicalUrl?: string;
  contentType: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  textContent: string;
  contentHash: string;
  fetchedAt: string;
  expiresAt: string;
}

export function getCachedWebContent(cacheKey: string): CachedWebContent | null {
  const row = getDb()
    .prepare(
      `SELECT cache_key, url, canonical_url, content_type, title, author, published_at,
              text_content, content_hash, fetched_at, expires_at
       FROM web_content_cache
       WHERE cache_key = ? AND expires_at > ?`,
    )
    .get(cacheKey, new Date().toISOString()) as ContentRow | undefined;
  return row ? mapContent(row) : null;
}

export function upsertCachedWebContent(content: CachedWebContent): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO web_content_cache(
         cache_key, url, canonical_url, content_type, title, author, published_at,
         text_content, content_hash, fetched_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         url = excluded.url,
         canonical_url = excluded.canonical_url,
         content_type = excluded.content_type,
         title = excluded.title,
         author = excluded.author,
         published_at = excluded.published_at,
         text_content = excluded.text_content,
         content_hash = excluded.content_hash,
         fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      content.cacheKey,
      content.url,
      content.canonicalUrl ?? null,
      content.contentType,
      content.title ?? null,
      content.author ?? null,
      content.publishedAt ?? null,
      content.textContent,
      content.contentHash,
      content.fetchedAt,
      now,
      now,
      content.expiresAt,
    );
}

export function replaceEvidenceChunks(
  sessionId: string,
  resultId: string,
  chunks: EvidenceChunk[],
  expiresAt: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO web_search_result_evidence(
       id, session_id, result_id, evidence_json, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(
      "DELETE FROM web_search_result_evidence WHERE session_id = ? AND result_id = ?",
    ).run(sessionId, resultId);
    for (const chunk of chunks) {
      insert.run(chunk.id, sessionId, resultId, JSON.stringify(chunk), now, now, expiresAt);
    }
  })();
}

export function listEvidenceChunks(sessionId: string, resultId?: string): EvidenceChunk[] {
  const rows = resultId
    ? getDb()
        .prepare(
          `SELECT evidence_json FROM web_search_result_evidence
           WHERE session_id = ? AND result_id = ? ORDER BY created_at, id`,
        )
        .all(sessionId, resultId)
    : getDb()
        .prepare(
          `SELECT evidence_json FROM web_search_result_evidence
           WHERE session_id = ? ORDER BY created_at, result_id, id`,
        )
        .all(sessionId);
  return (rows as Array<{ evidence_json: string }>).map((row) =>
    JSON.parse(row.evidence_json),
  ) as EvidenceChunk[];
}

export function getWebSearchSummary(
  sessionId: string,
  kind: WebSearchSummary["kind"],
  resultId?: string,
): WebSearchSummary | null {
  const row = getDb()
    .prepare(
      `SELECT id, session_id, result_id, kind, status, summary_json, citations_json,
              evidence_count, latency_ms, estimated_tokens, cited_claims, uncited_claims,
              evidence_insufficient, error, created_at, updated_at, expires_at
       FROM web_search_summaries
       WHERE session_id = ? AND kind = ? AND COALESCE(result_id, '') = ?
         AND expires_at > ?`,
    )
    .get(sessionId, kind, resultId ?? "", new Date().toISOString()) as SummaryRow | undefined;
  return row ? mapSummary(row) : null;
}

export function upsertWebSearchSummary(summary: WebSearchSummary): WebSearchSummary {
  getDb()
    .prepare(
      `INSERT INTO web_search_summaries(
         id, session_id, result_id, kind, status, summary_json, citations_json,
         evidence_count, latency_ms, estimated_tokens, cited_claims, uncited_claims,
         evidence_insufficient, error, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         id = excluded.id,
         status = excluded.status,
         summary_json = excluded.summary_json,
         citations_json = excluded.citations_json,
         evidence_count = excluded.evidence_count,
         latency_ms = excluded.latency_ms,
         estimated_tokens = excluded.estimated_tokens,
         cited_claims = excluded.cited_claims,
         uncited_claims = excluded.uncited_claims,
         evidence_insufficient = excluded.evidence_insufficient,
         error = excluded.error,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      summary.id,
      summary.sessionId,
      summary.resultId ?? null,
      summary.kind,
      summary.status,
      summary.synthesis ? JSON.stringify(summary.synthesis) : null,
      JSON.stringify(summary.citations),
      summary.evidenceCount,
      summary.latencyMs ?? null,
      summary.estimatedTokens ?? null,
      summary.citedClaims ?? 0,
      summary.uncitedClaims ?? 0,
      summary.evidenceInsufficient ?? 0,
      summary.error ?? null,
      summary.createdAt,
      summary.updatedAt,
      summary.expiresAt,
    );
  return getWebSearchSummary(summary.sessionId, summary.kind, summary.resultId)!;
}

export function cleanupExpiredWebSearchContent(now = new Date()): {
  evidence: number;
  summaries: number;
  content: number;
} {
  const iso = now.toISOString();
  return getDb().transaction(() => ({
    evidence: getDb()
      .prepare("DELETE FROM web_search_result_evidence WHERE expires_at <= ?")
      .run(iso).changes,
    summaries: getDb()
      .prepare("DELETE FROM web_search_summaries WHERE expires_at <= ?")
      .run(iso).changes,
    content: getDb().prepare("DELETE FROM web_content_cache WHERE expires_at <= ?").run(iso)
      .changes,
  }))();
}

function mapContent(row: ContentRow): CachedWebContent {
  return {
    cacheKey: row.cache_key,
    url: row.url,
    canonicalUrl: row.canonical_url ?? undefined,
    contentType: row.content_type,
    title: row.title ?? undefined,
    author: row.author ?? undefined,
    publishedAt: row.published_at ?? undefined,
    textContent: row.text_content,
    contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

function mapSummary(row: SummaryRow): WebSearchSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    resultId: row.result_id ?? undefined,
    kind: row.kind,
    status: row.status,
    synthesis: row.summary_json
      ? (JSON.parse(row.summary_json) as WebSearchSynthesis)
      : undefined,
    citations: JSON.parse(row.citations_json) as WebSearchCitation[],
    evidenceCount: row.evidence_count,
    latencyMs: row.latency_ms ?? undefined,
    estimatedTokens: row.estimated_tokens ?? undefined,
    citedClaims: row.cited_claims,
    uncitedClaims: row.uncited_claims,
    evidenceInsufficient: row.evidence_insufficient,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

interface ContentRow {
  cache_key: string;
  url: string;
  canonical_url: string | null;
  content_type: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  text_content: string;
  content_hash: string;
  fetched_at: string;
  expires_at: string;
}

interface SummaryRow {
  id: string;
  session_id: string;
  result_id: string | null;
  kind: WebSearchSummary["kind"];
  status: WebSearchSummary["status"];
  summary_json: string | null;
  citations_json: string;
  evidence_count: number;
  latency_ms: number | null;
  estimated_tokens: number | null;
  cited_claims: number;
  uncited_claims: number;
  evidence_insufficient: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}
