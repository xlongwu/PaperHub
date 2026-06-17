/**
 * Express API server for PaperHub.
 */

import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { loadPaperHubConfig } from "@/config";
import {
  getAllDocuments,
  getDocumentById,
  countDocuments,
  countDocumentsByDate,
} from "@/db/documents";
import { arxivCollector } from "@/collectors/arxiv";
import { gptBlogCollector } from "@/collectors/gpt-blog";
import { claudeBlogCollector } from "@/collectors/claude-blog";
import { rawToDocument } from "@/collectors/transformer";
import { insertDocument } from "@/db/documents";
import { documentExists } from "@/db/documents";
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
import { mapArxivCategories } from "@/tagger/arxiv-mapping";
import { extractModelTags } from "@/tagger/model-extract";
import type { Document } from "@/types";
import { summarizeBatch } from "@/summarizer";
import { hybridSearch } from "@/search";
import { indexDocumentVector } from "@/db/search";
import { getTagCloud, getDocumentsByTag, countDocumentsByTag, refreshTagStats } from "@/db/tags";
import {
  buildPersonalizedRecommendations,
  getCurrentMemory,
  getHotRecommendations,
  rebuildUserMemoryFromDigests,
  refreshHotRecommendations,
} from "@/recommendation";
import type { MemoryTerm, RecommendationEntry } from "@/types";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const config = loadPaperHubConfig();
const app = express();
app.use(express.json());

const frontendDistDir = path.resolve(process.cwd(), "dist-ui");
const frontendIndexHtml = path.join(frontendDistDir, "index.html");

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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
  sources?: string[];
  tags?: string[];
  from?: string;
  to?: string;
}): Promise<Awaited<ReturnType<typeof hybridSearch>>> {
  return hybridSearch({
    query: options.query,
    mode: options.mode,
    limit: options.limit,
    offset: options.offset,
    sources: options.sources,
    tags: options.tags,
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

    for (const doc of docs) {
      try {
        await indexDocumentVector(doc);
        indexed++;
      } catch (e) {
        console.error(`[api/index-vectors] Failed for ${doc.id}:`, e);
      }
    }

    offset += docs.length;
  }

  return { indexed, total };
}

export function userMemoryResponse(options?: {
  limit?: number;
  source?: "digest";
}): {
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
      limit: parseInt(req.query.limit as string) || 20,
      offset: parseInt(req.query.offset as string) || 0,
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
app.post("/api/collect", async (req, res) => {
  try {
    const source = req.body.source as string | undefined;
    const validSources = ["all", "arxiv", "gpt_blog", "claude_blog"];

    if (source && !validSources.includes(source)) {
      err(res, 400, `Invalid source. Use one of: ${validSources.join(", ")}`);
      return;
    }

    const results: Record<string, { collected: number; error?: string }> = {};

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

        let inserted = 0;
        for (const raw of rawDocs) {
          const doc = rawToDocument(raw);
          if (!documentExists(doc.url)) {
            // Apply tags before insert
            applyTags(doc, raw);
            insertDocument(doc);
            inserted++;
          }
        }

        results[id] = { collected: inserted };
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

// Tag application helper
function applyTags(doc: Document, raw: { metadata?: Record<string, unknown> }): void {
  // arXiv: use category mapping
  if (doc.source === "arxiv" && raw.metadata?.categories) {
    const cats = raw.metadata.categories as string[];
    doc.domainTags = mapArxivCategories(cats);
  }

  // Extract model tags from title + abstract for all sources
  const text = `${doc.title} ${doc.abstract}`;
  doc.modelTags = extractModelTags(text);
}

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

app.get("/api/user/preferences", (_req, res) => {
  try {
    const prefs = getUserPreferences();
    ok(res, prefs);
  } catch (e) {
    logError("api/user/preferences", e);
    err(res, 500, "Failed to fetch preferences");
  }
});

app.post("/api/user/preferences", (req, res) => {
  try {
    const prefs = req.body as Record<string, string>;
    if (!prefs || typeof prefs !== "object") {
      err(res, 400, "Invalid preferences body");
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
      limit: parseInt(req.query.limit as string) || 20,
      source: "digest",
    });
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/user/memory", e);
    err(res, 500, "Failed to fetch user memory");
  }
});

app.post("/api/user/memory/rebuild", (req, res) => {
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
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const history = getHistory({ limit, offset });
    const total = countHistory();
    ok(res, history, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/user/history", e);
    err(res, 500, "Failed to fetch history");
  }
});

app.post("/api/user/history", (req, res) => {
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
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const favorites = getFavorites({ limit, offset });
    const total = countFavorites();
    ok(res, favorites, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/user/favorites", e);
    err(res, 500, "Failed to fetch favorites");
  }
});

app.post("/api/user/favorites", (req, res) => {
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

app.post("/api/summarize", async (req, res) => {
  try {
    const { document_id, lang } = req.body as { document_id?: string; lang?: "zh" | "en" };

    if (document_id) {
      const doc = getDocumentById(document_id);
      if (!doc) {
        err(res, 404, "Document not found");
        return;
      }
      const summary = await summarizeBatch([doc], lang || "zh");
      ok(res, { document_id, summarized: true });
      return;
    }

    // Summarize all pending documents
    const docs = getAllDocuments({ limit: 100 });
    const pending = docs.filter((d) => !d.isSummarized);
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

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      err(res, 400, "Query parameter 'q' is required");
      return;
    }

    const result = await searchResponse({
      query: q,
      mode: (req.query.mode as "keyword" | "semantic" | "hybrid") || "hybrid",
      limit: parseInt(req.query.limit as string) || 20,
      offset: parseInt(req.query.offset as string) || 0,
      sources: req.query.sources ? String(req.query.sources).split(",") : undefined,
      tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    ok(res, result);
  } catch (e) {
    logError("api/search", e);
    err(res, 500, "Search failed");
  }
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

app.get("/api/tags", (req, res) => {
  try {
    const category = req.query.category as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
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
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const sortBy = (req.query.sortBy as "time" | "relevance") || "time";

    const docs = getDocumentsByTag(tag, { limit, offset, sortBy });
    const total = countDocumentsByTag(tag);
    ok(res, docs, { page: Math.floor(offset / limit) + 1, limit, total });
  } catch (e) {
    logError("api/tags/:tag/documents", e);
    err(res, 500, "Failed to fetch documents by tag");
  }
});

app.post("/api/tags/refresh", (_req, res) => {
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
      limit: parseInt(req.query.limit as string) || 10,
      windowDays: parseInt(req.query.windowDays as string) || undefined,
      includeRead: parseBooleanQuery(req.query.includeRead),
    });
    ok(res, result.data, result.meta);
  } catch (e) {
    logError("api/recommendations/hot", e);
    err(res, 500, "Failed to fetch hot recommendations");
  }
});

app.post("/api/recommendations/refresh-hot", (req, res) => {
  try {
    ok(
      res,
      refreshHotRecommendationsResponse({
        limit: parseInt(req.body?.limit as string) || undefined,
        windowDays: parseInt(req.body?.windowDays as string) || undefined,
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

app.post("/api/index-vectors", async (_req, res) => {
  try {
    ok(res, await indexAllVectors());
  } catch (e) {
    logError("api/index-vectors", e);
    err(res, 500, "Vector indexing failed");
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
  const server = app.listen(config.port, () => {
    console.log(`[api] Server listening on http://localhost:${config.port}`);
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
