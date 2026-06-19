/**
 * Express API server for PaperHub.
 */

import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { getAppRootDir, loadPaperHubConfig } from "@/config";
import { getAllDocuments, getDocumentById, countDocuments, countDocumentsByDate } from "@/db/documents";
import { arxivCollector } from "@/collectors/arxiv";
import { gptBlogCollector } from "@/collectors/gpt-blog";
import { claudeBlogCollector } from "@/collectors/claude-blog";
import { ingestDocuments } from "@/services/document-ingestion";
import { getPendingSummaryDocuments } from "@/db/documents";
import { withRetry, logError } from "@/utils/retry";
import type { ApiResponse } from "@/types";
import {
  getUserPreferences,
  setUserPreference,
  getHistory,
  recordHistory,
  getFavorites,
  addFavorite,
  removeFavorite,
  countHistory,
  countFavorites,
} from "@/db/user";
import { summarizeBatch } from "@/summarizer";
import { hybridSearch, generateSearchReport } from "@/search";
import {
  getLlmSettingsState,
  saveLlmSettings,
  VALID_PROVIDER_NAMES,
  type LlmSettingsUpdate,
  type ProviderName,
} from "@/providers";
import { resetLlmProvider } from "@/report";
import { indexDocumentVector, getIndexStateStats } from "@/db/search";
import { getIndexerState } from "@/search-indexer";
import { getTagCloud, getDocumentsByTag, countDocumentsByTag, refreshTagStats } from "@/db/tags";
import { getDb, rebuildFtsV2 } from "@/db/index";
import {
  getSearchQualityStats,
  markSearchReformulated,
  recordSearchClick,
  recordSearchEvent,
} from "@/db/search-events";
import {
  buildPersonalizedRecommendations,
  getCurrentMemory,
  getHotRecommendations,
  rebuildUserMemoryFromDigests,
  refreshHotRecommendations,
} from "@/recommendation";
import type { MemoryTerm, RecommendationEntry } from "@/types";
import { corsMiddleware, createRateLimiter } from "./security";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const config = loadPaperHubConfig();
const app = express();

// --- Security middleware ---
app.use(corsMiddleware); // CORS: localhost only
app.use(express.json({ limit: "1mb" })); // Request body size cap

// Rate limiters: different limits per endpoint sensitivity
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const collectLimiter = createRateLimiter({ windowMs: 300_000, max: 5 }); // 5 per 5 min
const llmLimiter = createRateLimiter({ windowMs: 300_000, max: 10 }); // 10 per 5 min
const searchLimiter = createRateLimiter({ windowMs: 60_000, max: 30 }); // 30 per min

/**
 * Whitelist of allowed user-preference keys.  Any key not in this set is
 * rejected at the API boundary to prevent attackers from writing internal
 * config keys (e.g. DB path, log path) via the preferences endpoint.
 */
const ALLOWED_PREFERENCE_KEYS = new Set([
  "interest_tags",
  "default_language",
  "summary_length",
  "daily_recommend_count",
  "theme",
  "sources",
  "reading_hours",
  "email_notifications",
  "weekly_digest",
  "monthly_digest",
  "default_date_range",
]);

export function sanitizePreferences(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (ALLOWED_PREFERENCE_KEYS.has(key) && typeof value === "string") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

class LlmSettingsValidationError extends Error {}

export function parseLlmSettingsUpdate(body: unknown): LlmSettingsUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LlmSettingsValidationError("LLM settings must be an object.");
  }

  const input = body as Record<string, unknown>;
  const provider = normalizeBoundedString(input.provider, "provider", 64);
  if (!VALID_PROVIDER_NAMES.includes(provider as ProviderName)) {
    throw new LlmSettingsValidationError(
      `Unsupported LLM provider. Valid providers: ${VALID_PROVIDER_NAMES.join(", ")}.`,
    );
  }

  const update: LlmSettingsUpdate = { provider: provider as ProviderName };

  if (input.apiKey !== undefined) {
    const apiKey = normalizeBoundedString(input.apiKey, "apiKey", 4096);
    if (apiKey) {
      update.apiKey = apiKey;
    }
  }

  if (input.clearApiKey !== undefined) {
    if (typeof input.clearApiKey !== "boolean") {
      throw new LlmSettingsValidationError("clearApiKey must be a boolean.");
    }
    update.clearApiKey = input.clearApiKey;
  }

  if (input.model !== undefined) {
    update.model = normalizeBoundedString(input.model, "model", 256);
  }

  if (input.baseUrl !== undefined) {
    const baseUrl = normalizeBoundedString(input.baseUrl, "baseUrl", 2048);
    if (baseUrl) {
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        throw new LlmSettingsValidationError("baseUrl must be a valid HTTP(S) URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new LlmSettingsValidationError("baseUrl must use HTTP or HTTPS.");
      }
    }
    update.baseUrl = baseUrl;
  }

  return update;
}

function normalizeBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new LlmSettingsValidationError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new LlmSettingsValidationError(`${field} is too long.`);
  }
  return normalized;
}

const frontendDistDir = path.resolve(getAppRootDir(), "dist-ui");
const frontendIndexHtml = path.join(frontendDistDir, "index.html");

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Safely parse an integer query parameter. Returns `fallback` for NaN or
 *  non-numeric strings. Unlike `parseInt() || fallback`, this correctly
 *  handles `0` and negative values. */
function safeParseInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function ok<T>(res: Response, data: T, meta?: ApiResponse<T>["meta"]): void {
  const payload: ApiResponse<T> = { success: true, data, meta };
  res.json(payload);
}

function err(res: Response, status: number, message: string): void {
  const payload: ApiResponse<never> = { success: false, error: message };
  res.status(status).json(payload);
}

export function listDocumentsResponse(options: {
  source?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}): { data: ReturnType<typeof getAllDocuments>; meta: NonNullable<ApiResponse<unknown>["meta"]> } {
  const limit = Math.min(options.limit ?? 20, 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const docs = getAllDocuments({
    source: options.source,
    limit,
    offset,
    from: options.from,
    to: options.to,
  });
  const total = countDocuments({
    source: options.source,
    from: options.from,
    to: options.to,
  });

  return {
    data: docs,
    meta: { page: Math.floor(offset / limit) + 1, limit, total },
  };
}

export async function searchResponse(options: {
  query: string;
  mode?: "keyword" | "semantic" | "hybrid";
  limit?: number;
  offset?: number;
  cursor?: string;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  from?: string;
  to?: string;
}): Promise<Awaited<ReturnType<typeof hybridSearch>>> {
  return hybridSearch({
    query: options.query,
    mode: options.mode,
    limit: options.limit,
    offset: options.offset,
    cursor: options.cursor,
    sources: options.sources,
    tags: options.tags,
    tagMatchMode: options.tagMatchMode,
    dateRange: options.from && options.to ? { start: options.from, end: options.to } : undefined,
  });
}

export async function indexAllVectors(): Promise<{ indexed: number; total: number }> {
  let indexed = 0;
  let total = 0;
  let offset = 0;
  const batchSize = 200;

  while (true) {
    const docs = getAllDocuments({ limit: batchSize, offset });
    if (docs.length === 0) {
      break;
    }

    total += docs.length;

    for (let index = 0; index < docs.length; index += 4) {
      const batch = docs.slice(index, index + 4);
      const results = await Promise.allSettled(batch.map((doc) => indexDocumentVector(doc)));
      results.forEach((result, resultIndex) => {
        if (result.status === "fulfilled") {
          indexed++;
        } else {
          console.error(
            `[api/index-vectors] Failed for ${batch[resultIndex]?.id ?? "unknown"}:`,
            result.reason,
          );
        }
      });
    }

    offset += docs.length;
  }

  return { indexed, total };
}

export function userMemoryResponse(options?: { limit?: number; source?: "digest" }): {
  data: MemoryTerm[];
  meta: NonNullable<ApiResponse<unknown>["meta"]>;
} {
  const limit = Math.min(options?.limit ?? 20, 100);
  const data = getCurrentMemory().slice(0, limit);
  return {
    data,
    meta: { limit, total: data.length },
  };
}

export function rebuildUserMemoryResponse(options?: {
  maxDays?: number;
  maxTerms?: number;
  useLlmFallback?: boolean;
}): { rebuilt: number; terms: MemoryTerm[] } {
  const terms = rebuildUserMemoryFromDigests(options);
  return { rebuilt: terms.length, terms };
}

export function hotRecommendationsResponse(options?: {
  limit?: number;
  windowDays?: number;
  includeRead?: boolean;
}): {
  data: RecommendationEntry[];
  meta: NonNullable<ApiResponse<unknown>["meta"]>;
} {
  const limit = Math.min(options?.limit ?? 10, 100);
  const result = getHotRecommendations({
    limit,
    windowDays: options?.windowDays,
    includeRead: options?.includeRead,
  });

  return {
    data: result.entries.slice(0, limit),
    meta: { limit, total: result.entries.length },
  };
}

export function refreshHotRecommendationsResponse(options?: {
  limit?: number;
  windowDays?: number;
  includeRead?: boolean;
}): { rebuilt: number; entries: RecommendationEntry[] } {
  const entries = refreshHotRecommendations(options);
  return { rebuilt: entries.length, entries };
}

export async function personalizedRecommendationsResponse(options?: {
  limit?: number;
  windowDays?: number;
  includeRead?: boolean;
}): Promise<{
  data: RecommendationEntry[];
  meta: NonNullable<ApiResponse<unknown>["meta"]>;
}> {
  const limit = Math.min(options?.limit ?? 10, 100);
  const entries = await buildPersonalizedRecommendations({
    limit,
    windowDays: options?.windowDays,
    includeRead: options?.includeRead,
  });

  return {
    data: entries,
    meta: { limit, total: entries.length },
  };
}

export function parseUserMemoryRebuildBody(body: {
  maxDays?: unknown;
  maxTerms?: unknown;
  useLlmFallback?: unknown;
}): {
  maxDays?: number;
  maxTerms?: number;
  useLlmFallback?: boolean;
} {
  return {
    maxDays: parseInt(body.maxDays as string) || undefined,
    maxTerms: parseInt(body.maxTerms as string) || undefined,
    useLlmFallback: parseBooleanQuery(body.useLlmFallback),
  };
}

export function parseRecommendationRequestOptions(query: {
  limit?: unknown;
  windowDays?: unknown;
  includeRead?: unknown;
}): {
  limit: number;
  windowDays?: number;
  includeRead?: boolean;
} {
  return {
    limit: parseInt(query.limit as string) || 10,
    windowDays: parseInt(query.windowDays as string) || undefined,
    includeRead: parseBooleanQuery(query.includeRead),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get("/health", (_req, res) => {
  ok(res, { status: "ok", timestamp: new Date().toISOString() });
});

// List documents (paginated, filterable)
app.get("/api/documents", (req, res) => {
  try {
    const result = listDocumentsResponse({
      source: req.query.source as string | undefined,
      limit: safeParseInt(req.query.limit, 20),
      offset: safeParseInt(req.query.offset, 0),
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/documents", e);
    err(res, 500, "Failed to fetch documents");
  }
});

// Get single document
app.get("/api/documents/:id", (req, res) => {
  try {
    const doc = getDocumentById(req.params.id);
    if (!doc) {
      err(res, 404, "Document not found");
      return;
    }
    ok(res, doc);
  } catch (e) {
    logError("api/documents/:id", e);
    err(res, 500, "Failed to fetch document");
  }
});

// Trigger collection manually
app.post("/api/collect", collectLimiter, async (req, res) => {
  try {
    const source = req.body.source as string | undefined;
    const validSources = ["all", "arxiv", "gpt_blog", "claude_blog"];

    if (source && !validSources.includes(source)) {
      err(res, 400, `Invalid source. Use one of: ${validSources.join(", ")}`);
      return;
    }

    const results: Record<string, { collected: number; skipped?: number; errors?: number; error?: string }> =
      {};

    const collectors = [
      { id: "arxiv", collector: arxivCollector },
      { id: "gpt_blog", collector: gptBlogCollector },
      { id: "claude_blog", collector: claudeBlogCollector },
    ];

    for (const { id, collector } of collectors) {
      if (source && source !== "all" && source !== id) continue;

      try {
        const rawDocs = await withRetry(() => collector.fetch(), {
          maxRetries: 3,
          baseDelayMs: 1000,
        });

        const ingestionResult = await ingestDocuments(rawDocs);
        results[id] = {
          collected: ingestionResult.inserted,
          skipped: ingestionResult.skipped,
          errors: ingestionResult.errors,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results[id] = { collected: 0, error: msg };
        logError(`collect/${id}`, e);
      }
    }

    ok(res, results);
  } catch (e) {
    logError("api/collect", e);
    err(res, 500, "Collection failed");
  }
});

// Stats
app.get("/api/stats", (_req, res) => {
  try {
    const total = countDocuments();
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = countDocumentsByDate(today);

    const bySource: Record<string, number> = {};
    for (const s of ["arxiv", "gpt_blog", "claude_blog"]) {
      bySource[s] = countDocuments(s);
    }

    ok(res, { total, today: todayCount, bySource });
  } catch (e) {
    logError("api/stats", e);
    err(res, 500, "Failed to fetch stats");
  }
});

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

app.get("/api/llm/settings", (_req, res) => {
  try {
    ok(res, getLlmSettingsState());
  } catch (e) {
    logError("api/llm/settings", e);
    err(res, 500, "Failed to fetch LLM settings");
  }
});

app.post("/api/llm/settings", writeLimiter, (req, res) => {
  try {
    const settings = saveLlmSettings(parseLlmSettingsUpdate(req.body));
    resetLlmProvider();
    ok(res, settings);
  } catch (e) {
    if (e instanceof LlmSettingsValidationError) {
      err(res, 400, e.message);
      return;
    }
    logError("api/llm/settings", e);
    err(res, 500, "Failed to update LLM settings");
  }
});

app.get("/api/user/preferences", (_req, res) => {
  try {
    const prefs = getUserPreferences();
    ok(res, prefs);
  } catch (e) {
    logError("api/user/preferences", e);
    err(res, 500, "Failed to fetch preferences");
  }
});

app.post("/api/user/preferences", writeLimiter, (req, res) => {
  try {
    const prefs = sanitizePreferences(req.body);
    if (Object.keys(prefs).length === 0) {
      err(
        res,
        400,
        "No valid preferences provided. Allowed keys: " + [...ALLOWED_PREFERENCE_KEYS].join(", "),
      );
      return;
    }

    for (const [key, value] of Object.entries(prefs)) {
      setUserPreference(key, value);
    }

    ok(res, getUserPreferences());
  } catch (e) {
    logError("api/user/preferences", e);
    err(res, 500, "Failed to update preferences");
  }
});

app.get("/api/user/memory", (req, res) => {
  try {
    const result = userMemoryResponse({
      limit: safeParseInt(req.query.limit, 20),
      source: "digest",
    });
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/user/memory", e);
    err(res, 500, "Failed to fetch user memory");
  }
});

app.post("/api/user/memory/rebuild", writeLimiter, (req, res) => {
  try {
    ok(res, rebuildUserMemoryResponse(parseUserMemoryRebuildBody(req.body ?? {})));
  } catch (e) {
    logError("api/user/memory/rebuild", e);
    err(res, 500, "Failed to rebuild user memory");
  }
});

// ---------------------------------------------------------------------------
// Browsing history
// ---------------------------------------------------------------------------

app.get("/api/user/history", (req, res) => {
  try {
    const limit = Math.min(safeParseInt(req.query.limit, 20), 100);
    const offset = safeParseInt(req.query.offset, 0);
    const history = getHistory({ limit, offset });
    const total = countHistory();
    ok(res, history, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/user/history", e);
    err(res, 500, "Failed to fetch history");
  }
});

app.post("/api/user/history", writeLimiter, (req, res) => {
  try {
    const { document_id } = req.body as { document_id?: string };
    if (!document_id) {
      err(res, 400, "document_id required");
      return;
    }
    recordHistory(document_id);
    ok(res, { document_id, recorded: true });
  } catch (e) {
    logError("api/user/history", e);
    err(res, 500, "Failed to record history");
  }
});

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

app.get("/api/user/favorites", (req, res) => {
  try {
    const limit = Math.min(safeParseInt(req.query.limit, 20), 100);
    const offset = safeParseInt(req.query.offset, 0);
    const favorites = getFavorites({ limit, offset });
    const total = countFavorites();
    ok(res, favorites, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/user/favorites", e);
    err(res, 500, "Failed to fetch favorites");
  }
});

app.post("/api/user/favorites", writeLimiter, (req, res) => {
  try {
    const { document_id } = req.body as { document_id?: string };
    if (!document_id) {
      err(res, 400, "document_id required");
      return;
    }
    addFavorite(document_id);
    ok(res, { document_id, favorited: true });
  } catch (e) {
    logError("api/user/favorites", e);
    err(res, 500, "Failed to add favorite");
  }
});

app.delete("/api/user/favorites/:id", (req, res) => {
  try {
    removeFavorite(req.params.id);
    ok(res, { document_id: req.params.id, favorited: false });
  } catch (e) {
    logError("api/user/favorites/delete", e);
    err(res, 500, "Failed to remove favorite");
  }
});

// ---------------------------------------------------------------------------
// Summarization trigger
// ---------------------------------------------------------------------------

app.post("/api/summarize", llmLimiter, async (req, res) => {
  try {
    const { document_id, lang } = req.body as { document_id?: string; lang?: "zh" | "en" };

    if (document_id) {
      const doc = getDocumentById(document_id);
      if (!doc) {
        err(res, 404, "Document not found");
        return;
      }
      await summarizeBatch([doc], lang || "zh");
      ok(res, { document_id, summarized: true });
      return;
    }

    // Summarize all pending documents
    const pending = getPendingSummaryDocuments(100);
    await summarizeBatch(pending, lang || "zh");
    ok(res, { pending: pending.length, summarized: true });
  } catch (e) {
    logError("api/summarize", e);
    err(res, 500, "Summarization failed");
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

app.get("/api/search", searchLimiter, async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      err(res, 400, "Query parameter 'q' is required");
      return;
    }

    const modeRaw = String(req.query.mode ?? "hybrid").toLowerCase();
    const VALID_SEARCH_MODES = ["keyword", "semantic", "hybrid"];
    if (!VALID_SEARCH_MODES.includes(modeRaw)) {
      err(res, 400, `Invalid search mode "${modeRaw}". Use: ${VALID_SEARCH_MODES.join(", ")}`);
      return;
    }
    const mode = modeRaw as "keyword" | "semantic" | "hybrid";

    const tagMatchMode = String(req.query.tagMatch ?? "any").toLowerCase() === "all" ? "all" : "any";
    const startedAt = Date.now();
    const result = await searchResponse({
      query: q,
      mode,
      limit: safeParseInt(req.query.limit, 20),
      offset: safeParseInt(req.query.offset, 0),
      cursor: req.query.cursor as string | undefined,
      sources: req.query.sources ? String(req.query.sources).split(",") : undefined,
      tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
      tagMatchMode,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    const searchEventId = recordSearchEvent({
      query: q,
      mode,
      modeUsed: result.modeUsed ?? result.mode,
      resultCount: result.total,
      latencyMs: Date.now() - startedAt,
    });
    ok(res, { ...result, searchEventId });
  } catch (e) {
    logError("api/search", e);
    err(res, 500, "Search failed");
  }
});

// POST /api/search/report — async LLM summary (non-blocking)
app.post("/api/search/report", llmLimiter, async (req, res) => {
  try {
    const { query, documentIds } = req.body as { query: string; documentIds: string[] };
    if (!query || !documentIds?.length) {
      err(res, 400, "query and documentIds are required");
      return;
    }

    // Fetch documents by their IDs
    const docs = documentIds.map((id: string) => getDocumentById(id)).filter(Boolean);
    const mockResults = docs.map((doc) => ({ document: doc!, score: 1, matchType: "fts" as const }));

    const report = await generateSearchReport(mockResults, query);
    ok(res, { report });
  } catch (e) {
    logError("api/search/report", e);
    err(res, 500, "Report generation failed");
  }
});

app.post("/api/search/feedback", writeLimiter, (req, res) => {
  try {
    const body = req.body as {
      eventId?: number;
      documentId?: string;
      rank?: number;
      reformulated?: boolean;
    };
    if (!Number.isInteger(body.eventId) || Number(body.eventId) <= 0) {
      err(res, 400, "A valid eventId is required");
      return;
    }
    if (body.reformulated) {
      markSearchReformulated(Number(body.eventId));
    }
    if (body.documentId && Number.isInteger(body.rank) && Number(body.rank) > 0) {
      recordSearchClick({
        eventId: Number(body.eventId),
        documentId: body.documentId,
        rank: Number(body.rank),
      });
    }
    ok(res, { recorded: true });
  } catch (e) {
    logError("api/search/feedback", e);
    err(res, 500, "Failed to record search feedback");
  }
});

app.get("/api/search/metrics", (_req, res) => {
  try {
    ok(res, getSearchQualityStats());
  } catch (e) {
    logError("api/search/metrics", e);
    err(res, 500, "Failed to fetch search metrics");
  }
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

app.get("/api/tags", (req, res) => {
  try {
    const category = req.query.category as string | undefined;
    const limit = Math.min(safeParseInt(req.query.limit, 50), 200);
    const tags = getTagCloud({ category, limit });
    ok(res, tags);
  } catch (e) {
    logError("api/tags", e);
    err(res, 500, "Failed to fetch tags");
  }
});

app.get("/api/tags/:tag/documents", (req, res) => {
  try {
    const tag = req.params.tag;
    const limit = Math.min(safeParseInt(req.query.limit, 20), 100);
    const offset = safeParseInt(req.query.offset, 0);
    const sortBy = (req.query.sortBy as "time" | "relevance") || "time";

    const docs = getDocumentsByTag(tag, { limit, offset, sortBy });
    const total = countDocumentsByTag(tag);
    ok(res, docs, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/tags/:tag/documents", e);
    err(res, 500, "Failed to fetch documents by tag");
  }
});

app.post("/api/tags/refresh", writeLimiter, (_req, res) => {
  try {
    refreshTagStats();
    ok(res, { refreshed: true });
  } catch (e) {
    logError("api/tags/refresh", e);
    err(res, 500, "Failed to refresh tag stats");
  }
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

app.get("/api/recommendations/hot", (req, res) => {
  try {
    const result = hotRecommendationsResponse({
      limit: safeParseInt(req.query.limit, 10),
      windowDays: safeParseInt(req.query.windowDays, 0) || undefined,
      includeRead: parseBooleanQuery(req.query.includeRead),
    });
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/recommendations/hot", e);
    err(res, 500, "Failed to fetch hot recommendations");
  }
});

app.post("/api/recommendations/refresh-hot", writeLimiter, (req, res) => {
  try {
    ok(
      res,
      refreshHotRecommendationsResponse({
        limit: safeParseInt(req.body?.limit, 0) || undefined,
        windowDays: safeParseInt(req.body?.windowDays, 0) || undefined,
        includeRead: parseBooleanQuery(req.body?.includeRead),
      }),
    );
  } catch (e) {
    logError("api/recommendations/refresh-hot", e);
    err(res, 500, "Failed to refresh hot recommendations");
  }
});

app.get("/api/recommendations/personalized", async (req, res) => {
  try {
    const result = await personalizedRecommendationsResponse(parseRecommendationRequestOptions(req.query));
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/recommendations/personalized", e);
    err(res, 500, "Failed to fetch personalized recommendations");
  }
});

// ---------------------------------------------------------------------------
// Vector indexing
// ---------------------------------------------------------------------------

app.post("/api/index-vectors", writeLimiter, async (_req, res) => {
  try {
    ok(res, await indexAllVectors());
  } catch (e) {
    logError("api/index-vectors", e);
    err(res, 500, "Vector indexing failed");
  }
});

// GET /api/index/status — index coverage and indexer state
app.get("/api/index/status", (_req, res) => {
  try {
    const stats = getIndexStateStats();
    const indexer = getIndexerState();
    ok(res, { ...stats, indexer });
  } catch (e) {
    logError("api/index/status", e);
    err(res, 500, "Failed to fetch index status");
  }
});

// GET /api/index/coverage — corpus coverage with date range
app.get("/api/index/coverage", (_req, res) => {
  try {
    const db = getDb();
    const totalDocs = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;
    const firstDate = (
      db.prepare("SELECT MIN(published_at) as d FROM documents").get() as { d: string | null }
    ).d;
    const lastDate = (
      db.prepare("SELECT MAX(published_at) as d FROM documents").get() as { d: string | null }
    ).d;

    const vectorIndexed = (
      db.prepare("SELECT COUNT(*) as c FROM document_index_state WHERE embedding_status = 'ready'").get() as {
        c: number;
      }
    ).c;
    const ftsIndexed = (db.prepare("SELECT COUNT(*) as c FROM document_fts_v2").get() as { c: number }).c;

    const bySource = db
      .prepare("SELECT source, COUNT(*) as c FROM documents GROUP BY source")
      .all() as Array<{ source: string; c: number }>;

    ok(res, {
      totalDocs,
      ftsIndexed,
      vectorIndexed,
      coverage: totalDocs > 0 ? `${vectorIndexed}/${totalDocs}` : "0/0",
      dateRange: firstDate && lastDate ? { from: firstDate, to: lastDate } : null,
      bySource: Object.fromEntries(bySource.map((r) => [r.source, r.c])),
    });
  } catch (e) {
    logError("api/index/coverage", e);
    err(res, 500, "Failed to fetch coverage");
  }
});

// POST /api/index/rebuild-fts — manually rebuild FTS from content table
app.post("/api/index/rebuild-fts", writeLimiter, (_req, res) => {
  try {
    rebuildFtsV2();
    ok(res, { rebuilt: true });
  } catch (e) {
    logError("api/index/rebuild-fts", e);
    err(res, 500, "FTS rebuild failed");
  }
});

if (fs.existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));

  app.get(/^\/(?!api\/|health$).*/, (_req, res) => {
    res.sendFile(frontendIndexHtml);
  });
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  logError("api/uncaught", error);
  err(res, 500, "Internal server error");
});

app.use((_req: Request, res: Response) => {
  err(res, 404, "Not found");
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function startServer(): ReturnType<typeof app.listen> {
  const server = app.listen(config.port, "127.0.0.1", () => {
    console.log(`[api] Server listening on http://127.0.0.1:${config.port}`);
  });
  return server;
}

export { app };

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return undefined;
}
