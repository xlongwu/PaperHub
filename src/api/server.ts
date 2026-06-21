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
import type { ApiResponse, DocumentLanguage } from "@/types";
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
import { getConfiguredSummaryLevel, summarizeBatch, summarizeDocument } from "@/summarizer";
import { hybridSearch, generateSearchReport } from "@/search";
import { SearchContractError, type SearchFallbackPolicy } from "@/search-contract";
import {
  LLM_PROVIDER_CATALOG,
  createLlmConnectionInputFromPreset,
  discoverLlmModels,
  getLlmSettingsState,
  parseLlmConnectionInput,
  probeLlmConnection,
  redactSecrets,
  resolveLlmRuntime,
  saveLlmSettings,
  toTestableConnection,
  VALID_PROVIDER_NAMES,
  type LlmConnectionInput,
  type LlmSettingsUpdate,
  type ProviderName,
} from "@/providers";
import { resetLlmProvider } from "@/report";
import {
  activateLlmConnection,
  deleteLlmConnection,
  getActiveLlmConnectionId,
  getLlmConnection,
  listLlmConnections,
  saveLlmConnection,
  updateLlmConnectionTest,
} from "@/db/llm-connections";
import { getIndexStateStats } from "@/db/search";
import { getIndexerState, processPending, startIndexer } from "@/search-indexer";
import {
  getEmbeddingConfiguration,
  getEmbeddingConfigurationSource,
  probeEmbeddingConfiguration,
  resetEmbeddingRuntime,
} from "@/embedding";
import {
  getStoredEmbeddingSettings,
  saveStoredEmbeddingSettings,
  type EmbeddingProviderSetting,
} from "@/db/embedding-settings";
import { forceRebuildEmbeddingIndex, getEmbeddingIndexProgress } from "@/db/embedding-index";
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
import {
  corsMiddleware,
  createRateLimiter,
  securityHeadersMiddleware,
} from "./security";
import { startWebSearchCleanup, webSearchRouter } from "./routes/web-search";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const config = loadPaperHubConfig();
const app = express();

// --- Security middleware ---
app.use(corsMiddleware); // CORS: localhost only
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: "1mb" })); // Request body size cap
app.use("/api/web-search", webSearchRouter);

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

export function parseLlmConnectionRequest(body: unknown): LlmConnectionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return parseLlmConnectionInput(body);
  }
  const input = body as Record<string, unknown>;
  if (input.protocol === undefined && typeof input.presetId === "string" && input.presetId.trim()) {
    const preset = createLlmConnectionInputFromPreset(
      input.presetId.trim(),
      typeof input.name === "string" ? input.name : undefined,
    );
    return parseLlmConnectionInput({ ...preset, ...input });
  }
  return parseLlmConnectionInput(input);
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

function readRouteParam(value: string | string[] | undefined, field: string): string {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized) throw new LlmSettingsValidationError(`${field} is required.`);
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

function err(
  res: Response,
  status: number,
  message: string,
  errorCode?: string,
  details?: Record<string, unknown>,
): void {
  const payload: ApiResponse<never> = { success: false, error: message, errorCode, details };
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
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  fallbackPolicy?: SearchFallbackPolicy;
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
    allTags: options.allTags,
    anyTags: options.anyTags,
    excludeTags: options.excludeTags,
    mustConcepts: options.mustConcepts,
    shouldConcepts: options.shouldConcepts,
    excludeConcepts: options.excludeConcepts,
    fallbackPolicy: options.fallbackPolicy,
    dateRange:
      options.from || options.to
        ? { start: options.from ?? "", end: options.to ?? "" }
        : undefined,
  });
}

export async function indexAllVectors(): Promise<{ indexed: number; total: number }> {
  const total = countDocuments();
  const indexed = await processPending(total);
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

app.get("/api/llm/catalog", (_req, res) => {
  ok(res, LLM_PROVIDER_CATALOG);
});

app.get("/api/llm/connections", (_req, res) => {
  try {
    const runtime = resolveLlmRuntime();
    ok(res, {
      connections: listLlmConnections(),
      activeConnectionId: getActiveLlmConnectionId(),
      runtimeConnectionId: runtime.connection.id,
      runtimeSource: runtime.source,
      environmentOverride:
        runtime.source === "environment_connection" || runtime.source === "environment_provider",
    });
  } catch (e) {
    logError("api/llm/connections", e);
    err(res, 500, "Failed to fetch LLM connections");
  }
});

app.post("/api/llm/connections", writeLimiter, (req, res) => {
  try {
    const connection = saveLlmConnection(parseLlmConnectionRequest(req.body));
    ok(res, connection);
  } catch (e) {
    err(res, 400, e instanceof Error ? e.message : "Invalid LLM connection");
  }
});

app.put("/api/llm/connections/:id", writeLimiter, (req, res) => {
  try {
    const connection = saveLlmConnection(
      parseLlmConnectionRequest({
        ...(req.body && typeof req.body === "object" ? req.body : {}),
        id: req.params.id,
      }),
    );
    if (connection.isActive) resetLlmProvider();
    ok(res, connection);
  } catch (e) {
    err(res, 400, e instanceof Error ? e.message : "Invalid LLM connection");
  }
});

app.delete("/api/llm/connections/:id", writeLimiter, (req, res) => {
  try {
    const connectionId = readRouteParam(req.params.id, "id");
    if (!deleteLlmConnection(connectionId)) {
      err(res, 404, "LLM connection not found");
      return;
    }
    ok(res, { deleted: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete LLM connection";
    err(res, message.includes("active") ? 409 : 400, message);
  }
});

app.post("/api/llm/connections/:id/activate", writeLimiter, (req, res) => {
  try {
    const connection = activateLlmConnection(readRouteParam(req.params.id, "id"));
    resetLlmProvider();
    ok(res, connection);
  } catch (e) {
    err(res, 404, e instanceof Error ? e.message : "LLM connection not found");
  }
});

app.post("/api/llm/connections/test", llmLimiter, async (req, res) => {
  const startedAt = Date.now();
  let connectionId: string | undefined;
  let apiKey: string | undefined;
  try {
    const connection = resolveConnectionRequest(req.body);
    connectionId = connection.id === "draft" ? undefined : connection.id;
    apiKey = connection.apiKey;
    const text = await probeLlmConnection(connection);
    if (connectionId) {
      updateLlmConnectionTest(connectionId, "success", "Connection successful");
    }
    ok(res, {
      reachable: true,
      latencyMs: Date.now() - startedAt,
      responsePreview: text.slice(0, 160),
    });
  } catch (e) {
    const message = redactSecrets(e instanceof Error ? e.message : "LLM connection test failed", apiKey);
    if (connectionId) {
      updateLlmConnectionTest(connectionId, "failed", message);
    }
    err(res, 503, message);
  }
});

app.post("/api/llm/connections/models", llmLimiter, async (req, res) => {
  let apiKey: string | undefined;
  try {
    const connection = resolveConnectionRequest(req.body);
    apiKey = connection.apiKey;
    const models = await discoverLlmModels(connection);
    ok(res, { models });
  } catch (e) {
    err(res, 503, redactSecrets(e instanceof Error ? e.message : "Failed to discover models", apiKey));
  }
});

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
    const body = req.body as { document_id?: unknown; lang?: unknown };
    const outputLanguage = parseSummaryLanguage(body.lang);
    const summaryLevel = getConfiguredSummaryLevel();
    const documentId = typeof body.document_id === "string" ? body.document_id : undefined;

    if (documentId) {
      const doc = getDocumentById(documentId);
      if (!doc) {
        err(res, 404, "Document not found");
        return;
      }
      await summarizeDocument(doc, outputLanguage, {
        summaryLevel,
      });
      const updatedDocument = getDocumentById(documentId);
      if (!updatedDocument) {
        err(res, 500, "Summarized document could not be reloaded");
        return;
      }
      ok(res, {
        document_id: documentId,
        lang: outputLanguage,
        summarized: true,
        document: updatedDocument,
      });
      return;
    }

    // Summarize all pending documents
    const pending = getPendingSummaryDocuments(100, {
      lang: outputLanguage,
      summaryLevel,
    });
    await summarizeBatch(pending, outputLanguage, undefined, {
      summaryLevel,
    });
    ok(res, { pending: pending.length, summarized: true });
  } catch (e) {
    if (e instanceof SummaryLanguageValidationError) {
      err(res, 400, e.message);
      return;
    }
    logError("api/summarize", e);
    err(res, 500, "Summarization failed");
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const localSearchHandler = async (req: Request, res: Response): Promise<void> => {
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

    const tagMatchMode = String(req.query.tagMatch ?? "all").toLowerCase() === "any" ? "any" : "all";
    const fallbackPolicy =
      String(req.query.fallback ?? "strict").toLowerCase() === "allow_relaxed" ? "allow_relaxed" : "strict";
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
      allTags: req.query.allTags ? String(req.query.allTags).split(",") : undefined,
      anyTags: req.query.anyTags ? String(req.query.anyTags).split(",") : undefined,
      excludeTags: req.query.excludeTags ? String(req.query.excludeTags).split(",") : undefined,
      mustConcepts: req.query.mustConcepts ? String(req.query.mustConcepts).split(",") : undefined,
      shouldConcepts: req.query.shouldConcepts ? String(req.query.shouldConcepts).split(",") : undefined,
      excludeConcepts: req.query.excludeConcepts ? String(req.query.excludeConcepts).split(",") : undefined,
      fallbackPolicy,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    const searchEventId = recordSearchEvent({
      query: q,
      mode,
      modeUsed: result.modeUsed ?? result.mode,
      resultCount: result.total,
      latencyMs: Date.now() - startedAt,
      queryType: result.queryPlan?.intent,
      resultDocumentIds: result.results.map((entry) => entry.document.id),
    });
    ok(res, { ...result, searchEventId });
  } catch (e) {
    if (e instanceof SearchContractError) {
      err(res, 400, e.message, e.code, e.details);
      return;
    }
    logError("api/search", e);
    err(res, 500, "Search failed");
  }
};

app.get("/api/search", searchLimiter, localSearchHandler);
app.get("/api/local-search", searchLimiter, localSearchHandler);

// POST /api/search/report — async LLM summary (non-blocking)
app.post("/api/search/report", llmLimiter, async (req, res) => {
  try {
    const { query, documentIds, maxResults } = req.body as {
      query: string;
      documentIds: string[];
      maxResults?: number;
    };
    if (!query || !documentIds?.length) {
      err(res, 400, "query and documentIds are required");
      return;
    }

    // Fetch documents by their IDs, capped by user-specified count
    const cappedIds = maxResults ? documentIds.slice(0, Math.min(maxResults, 100)) : documentIds;
    const docs = cappedIds.map((id: string) => getDocumentById(id)).filter(Boolean);
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

app.get("/api/settings/embedding", (_req, res) => {
  try {
    const configuration = getEmbeddingConfiguration();
    const source = getEmbeddingConfigurationSource();
    let hasApiKey = false;
    try {
      hasApiKey =
        source === "stored"
          ? Boolean(getStoredEmbeddingSettings()?.apiKey)
          : Boolean(process.env["EMBEDDING_API_KEY"] || process.env["OPENAI_API_KEY"]);
    } catch {
      // ignore
    }
    ok(res, {
      provider: configuration.provider,
      model: configuration.model,
      baseUrl: configuration.baseUrl,
      expectedDimensions: configuration.expectedDimensions ?? null,
      timeoutMs: configuration.timeoutMs,
      batchSize: configuration.batchSize,
      keepAlive: configuration.keepAlive ?? null,
      truncate: configuration.truncate,
      maxInputChars: configuration.maxInputChars,
      source,
      hasApiKey,
      index: getEmbeddingIndexProgress(),
    });
  } catch (e) {
    logError("api/settings/embedding", e);
    err(res, 400, e instanceof Error ? e.message : "Invalid embedding configuration");
  }
});

/**
 * PUT /api/settings/embedding — Save embedding provider configuration.
 *
 * Accepts: { provider, model?, baseUrl?, apiKey?, clearApiKey? }
 * - apiKey is stored locally and never returned.
 * - Resets the embedding runtime cache so next request uses new settings.
 * - Does NOT trigger an automatic rebuild; the user must do that separately.
 */
app.put("/api/settings/embedding", writeLimiter, (req, res) => {
  try {
    const body = req.body as {
      provider?: unknown;
      model?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      clearApiKey?: unknown;
    };

    const VALID_PROVIDERS: EmbeddingProviderSetting[] = ["openai", "ollama"];
    const providerRaw = String(body.provider ?? "")
      .trim()
      .toLowerCase();
    if (!VALID_PROVIDERS.includes(providerRaw as EmbeddingProviderSetting)) {
      err(res, 400, `Invalid provider "${providerRaw}". Use: ${VALID_PROVIDERS.join(", ")}`);
      return;
    }
    const provider = providerRaw as EmbeddingProviderSetting;

    const model = typeof body.model === "string" ? body.model.trim() || null : undefined;
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || null : undefined;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() || null : undefined;
    const clearApiKey = body.clearApiKey === true || body.clearApiKey === "true";

    saveStoredEmbeddingSettings({ provider, model, baseUrl, apiKey, clearApiKey });

    // Reset runtime cache so the new configuration takes effect immediately
    resetEmbeddingRuntime();

    // Build safe response — never return the stored API key
    const configuration = getEmbeddingConfiguration();
    const source = getEmbeddingConfigurationSource();
    let hasApiKey = false;
    try {
      hasApiKey = Boolean(getStoredEmbeddingSettings()?.apiKey);
    } catch {
      // ignore
    }
    ok(res, {
      provider: configuration.provider,
      model: configuration.model,
      baseUrl: configuration.baseUrl,
      expectedDimensions: configuration.expectedDimensions ?? null,
      timeoutMs: configuration.timeoutMs,
      batchSize: configuration.batchSize,
      keepAlive: configuration.keepAlive ?? null,
      truncate: configuration.truncate,
      maxInputChars: configuration.maxInputChars,
      source,
      hasApiKey,
      index: getEmbeddingIndexProgress(),
    });
  } catch (e) {
    logError("api/settings/embedding PUT", e);
    err(res, 500, e instanceof Error ? e.message : "Failed to save embedding settings");
  }
});

app.post("/api/settings/embedding/test", writeLimiter, async (_req, res) => {
  try {
    const runtime = await probeEmbeddingConfiguration();
    ok(res, {
      provider: runtime.provider,
      model: runtime.model,
      dimensions: runtime.dimensions,
      reachable: true,
      signature: runtime.signature,
    });
  } catch (e) {
    logError("api/settings/embedding/test", e);
    err(res, 503, e instanceof Error ? e.message : "Embedding provider is unavailable");
  }
});

app.post("/api/index/embedding/rebuild", writeLimiter, async (_req, res) => {
  try {
    const activation = await forceRebuildEmbeddingIndex();
    startIndexer();
    ok(res, {
      rebuilt: activation.rebuilt,
      runtime: activation.runtime,
      index: getEmbeddingIndexProgress(),
    });
  } catch (e) {
    logError("api/index/embedding/rebuild", e);
    err(res, 503, e instanceof Error ? e.message : "Embedding index rebuild failed");
  }
});

app.get("/api/index/embedding/status", (_req, res) => {
  try {
    ok(res, getEmbeddingIndexProgress());
  } catch (e) {
    logError("api/index/embedding/status", e);
    err(res, 500, "Failed to fetch embedding index status");
  }
});

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
  startWebSearchCleanup();
  const server = app.listen(config.port, "127.0.0.1", () => {
    console.log(`[api] Server listening on http://127.0.0.1:${config.port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[api] Port ${config.port} is already in use.\n` +
          "  Another PaperHub instance may already be running.\n" +
          "  Fix: close all other PaperHub windows and retry.",
      );
    } else {
      console.error("[api] Server error:", err);
    }
    process.exit(1);
  });

  return server;
}

export { app };

class SummaryLanguageValidationError extends Error {}

function resolveConnectionRequest(body: unknown) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const input = body as Record<string, unknown>;
    if (typeof input.id === "string" && Object.keys(input).length === 1) {
      const stored = getLlmConnection(input.id);
      if (!stored) throw new Error(`LLM connection "${input.id}" was not found.`);
      return stored;
    }
    if (input.connection !== undefined) {
      return toTestableConnection(parseLlmConnectionRequest(input.connection));
    }
  }
  return toTestableConnection(parseLlmConnectionRequest(body));
}

export function parseSummaryLanguage(value: unknown): DocumentLanguage {
  if (value === undefined || value === null || value === "") {
    return "zh";
  }
  if (value === "zh" || value === "en") {
    return value;
  }
  throw new SummaryLanguageValidationError('Invalid summary language. Use "zh" or "en".');
}

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
