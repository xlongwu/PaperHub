import type { Document, MemoryTerm, RecommendationEntry } from "@/types";
import type { SearchMatchExplanation, SearchQueryPlan } from "@/search-contract";
import type { SearchRerankerMetadata } from "@/search-reranker";
import type {
  WebSearchConnection,
  WebSearchConnectionTestDiagnostic,
  WebSearchRequest,
  WebSearchSummary,
  WebSearchSession,
  WebSearchSessionStatus,
} from "@/web-search/types";

declare global {
  interface Window {
    PAPERHUB_API_BASE?: string;
  }
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export class ApiRequestError extends Error {
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { errorCode?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.errorCode = options.errorCode;
    this.details = options.details;
  }
}

export interface SearchResponse {
  results: Array<{
    document: Document;
    score: number;
    matchType: "fts" | "vector" | "hybrid";
    snippet?: string;
    explanation?: SearchMatchExplanation;
  }>;
  total: number;
  mode: string;
  modeUsed?: "keyword" | "semantic" | "hybrid" | "keyword_fallback";
  returned?: number;
  candidateTotal?: number;
  hasMore?: boolean;
  nextCursor?: string;
  matchReasons?: string[];
  appliedTags?: string[];
  topicTerms?: string[];
  searchEventId?: number;
  degraded?: boolean;
  reason?: string;
  queryPlan?: SearchQueryPlan;
  reranker?: SearchRerankerMetadata;
}

export interface IndexCoverage {
  totalDocs: number;
  ftsIndexed: number;
  vectorIndexed: number;
  coverage: string;
  dateRange: { from: string; to: string } | null;
  bySource: Record<string, number>;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  page: number;
}

export type TimeRangePreset = "all" | "7d" | "30d" | "90d" | "365d";
export type LlmProviderName = "anthropic" | "openai" | "github-copilot" | "openrouter" | "deepseek";
export type EmbeddingProviderName = "openai" | "ollama";
export type LlmProtocol = "openai_chat" | "anthropic_messages" | "gemini_generate_content" | "custom_json";
export type LlmAuthType = "bearer" | "header" | "query" | "none";

export interface LlmAuthConfig {
  type: LlmAuthType;
  headerName?: string;
  queryParam?: string;
}

export interface LlmRequestTemplate {
  method: "POST" | "PUT";
  path: string;
  headers: Record<string, string>;
  body: unknown;
  responsePath: string;
}

export interface LlmModelDiscoveryTemplate {
  method: "GET" | "POST" | "PUT";
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  listPath: string;
  idPath: string;
}

export interface LlmProviderPreset {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  defaultModel: string;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
}

export interface LlmConnection {
  id: string;
  name: string;
  presetId: string | null;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
  hasApiKey: boolean;
  isActive: boolean;
  lastTestStatus: "success" | "failed" | null;
  lastTestMessage: string | null;
  lastTestAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmConnectionPayload {
  id?: string;
  name: string;
  presetId: string | null;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
}

export interface LlmConnectionsState {
  connections: LlmConnection[];
  activeConnectionId: string | null;
  runtimeConnectionId: string;
  runtimeSource: "environment_connection" | "environment_provider" | "stored" | "default";
  environmentOverride: boolean;
}

export interface LlmSettings {
  provider: LlmProviderName;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "stored" | "environment" | "missing";
  supportedProviders: LlmProviderName[];
}

export interface EmbeddingIndexProgress {
  signature: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  status: "unconfigured" | "probing" | "ready" | "rebuild_required" | "rebuilding" | "failed";
  lastError: string | null;
  rebuildStartedAt: string | null;
  rebuildCompletedAt: string | null;
  updatedAt: string | null;
  total: number;
  ready: number;
  pending: number;
  running: number;
  failed: number;
}

export interface EmbeddingSettings {
  provider: "openai" | "ollama" | "mock";
  model: string;
  baseUrl?: string;
  expectedDimensions: number | null;
  timeoutMs: number;
  batchSize: number;
  keepAlive: string | null;
  truncate: boolean;
  maxInputChars: number;
  /** Where the config came from: "environment" (env vars) | "stored" (UI-saved DB) | "default" */
  source: "environment" | "stored" | "default";
  /** Whether an API key is stored (key itself is never returned). */
  hasApiKey: boolean;
  index: EmbeddingIndexProgress;
}

export interface SummarizeDocumentResponse {
  document_id: string;
  lang: "zh" | "en";
  summarized: boolean;
  document: Document;
}

export interface CreatedWebSearchSession {
  sessionId: string;
  status: WebSearchSessionStatus;
  eventsUrl: string;
  expiresAt: string;
}

export interface WebSearchHealth {
  status: "healthy" | "degraded";
  checkedAt: string;
  providers: Array<{
    providerId: string;
    configured: boolean;
    enabled: boolean;
    lastTestStatus?: "success" | "failed";
    lastTestedAt?: string;
  }>;
  cache: {
    sessions: number;
    results: number;
    evidence: number;
    summaries: number;
    content: number;
  };
  maintenance: {
    lastCleanupAt?: string;
    lastRecoveryAt?: string;
  };
  lastSevenDays: {
    searches: number;
    providerFailureRate: number;
    estimatedCredits: number;
  };
}

export interface WebSearchProviderCatalogItem {
  id: string;
  displayName: string;
  kind: "academic" | "web" | "mcp";
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  capabilities: Record<string, boolean>;
}

export interface WebSearchMetrics {
  range: { from: string; to: string };
  providers: Array<{
    providerId: string;
    calls: number;
    successRate: number;
    timeoutRate: number;
    rateLimitRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    resultCount: number;
    estimatedCredits: number;
    cacheHitRate: number;
  }>;
  summaries: {
    attempts: number;
    successRate: number;
    p95LatencyMs: number;
    citationMappingAccuracy: number;
    uncitedClaims: number;
    evidenceInsufficient: number;
    estimatedTokens: number;
  };
  usage: {
    searches: number;
    resultOpens: number;
    deepSummaries: number;
    saves: number;
    favorites: number;
    pdfDownloads: number;
    partialSessionRate: number;
    noResultRate: number;
  };
}

export async function getHotRecommendations(): Promise<RecommendationEntry[]> {
  const response = await apiGet<RecommendationEntry[]>("/api/recommendations/hot");
  return response.data ?? [];
}

export async function getPersonalizedRecommendations(): Promise<RecommendationEntry[]> {
  const response = await apiGet<RecommendationEntry[]>("/api/recommendations/personalized");
  return response.data ?? [];
}

export async function getLatestDocuments(): Promise<Document[]> {
  const response = await apiGet<Document[]>("/api/documents?limit=8");
  return response.data ?? [];
}

export async function getDocument(documentId: string): Promise<Document> {
  const response = await apiGet<Document>(`/api/documents/${documentId}`);
  if (!response.data) {
    throw new Error("Document not found");
  }
  return response.data;
}

export async function summarizeDocument(
  documentId: string,
  lang: "zh" | "en",
): Promise<SummarizeDocumentResponse> {
  const response = await apiPost<SummarizeDocumentResponse>("/api/summarize", {
    document_id: documentId,
    lang,
  });
  if (!response.data) {
    throw new Error("Summary generation returned no document");
  }
  return response.data;
}

export async function searchDocuments(params: {
  query: string;
  mode: string;
  sources: string[];
  tags: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  fallbackPolicy?: "strict" | "allow_relaxed";
  timeRange?: TimeRangePreset;
  limit?: number;
  page?: number;
  cursor?: string;
}): Promise<SearchResponse> {
  const search = new URLSearchParams();
  search.set("q", params.query);
  search.set("mode", params.mode);
  const limit = params.limit ?? 12;
  const page = Math.max(params.page ?? 1, 1);
  search.set("limit", String(limit));
  if (params.cursor) {
    search.set("cursor", params.cursor);
  } else {
    search.set("offset", String((page - 1) * limit));
  }
  if (params.sources.length > 0) {
    search.set("sources", params.sources.join(","));
  }
  if (params.tags.length > 0) {
    search.set("tags", params.tags.join(","));
    search.set("tagMatch", params.tagMatchMode ?? "all");
  }
  if (params.allTags?.length) {
    search.set("allTags", params.allTags.join(","));
  }
  if (params.anyTags?.length) {
    search.set("anyTags", params.anyTags.join(","));
  }
  if (params.excludeTags?.length) {
    search.set("excludeTags", params.excludeTags.join(","));
  }
  if (params.mustConcepts?.length) {
    search.set("mustConcepts", params.mustConcepts.join(","));
  }
  if (params.shouldConcepts?.length) {
    search.set("shouldConcepts", params.shouldConcepts.join(","));
  }
  if (params.excludeConcepts?.length) {
    search.set("excludeConcepts", params.excludeConcepts.join(","));
  }
  if (params.fallbackPolicy === "allow_relaxed") {
    search.set("fallback", "allow_relaxed");
  }
  const range = resolveTimeRange(params.timeRange ?? "all");
  if (range) {
    search.set("from", range.from);
    search.set("to", range.to);
  }

  const response = await apiGet<SearchResponse>(`/api/search?${search.toString()}`);
  if (!response.data) {
    return { results: [], total: 0, mode: params.mode };
  }
  return response.data;
}

export async function createWebSearch(request: WebSearchRequest): Promise<CreatedWebSearchSession> {
  const response = await apiPost<CreatedWebSearchSession>("/api/web-search", request);
  if (!response.data) throw new Error("Web Search session was not created.");
  return response.data;
}

export async function getWebSearchSession(sessionId: string): Promise<WebSearchSession> {
  const response = await apiGet<WebSearchSession>(`/api/web-search/${encodeURIComponent(sessionId)}`);
  if (!response.data) throw new Error("Web Search session was not found.");
  return response.data;
}

export async function summarizeWebSearch(sessionId: string): Promise<WebSearchSummary> {
  const response = await apiPost<WebSearchSummary>(
    `/api/web-search/${encodeURIComponent(sessionId)}/summarize`,
    {},
  );
  if (!response.data) throw new Error("Web Search summary was not generated.");
  return response.data;
}

export async function summarizeWebSearchResult(
  sessionId: string,
  resultId: string,
): Promise<WebSearchSummary> {
  const response = await apiPost<WebSearchSummary>(
    `/api/web-search/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(resultId)}/summarize`,
    {},
  );
  if (!response.data) throw new Error("Web result summary was not generated.");
  return response.data;
}

export async function retryWebSearchSession(
  sessionId: string,
  providerIds?: string[],
): Promise<{ sessionId: string; status: string; providerIds?: string[] }> {
  const response = await apiPost<{
    sessionId: string;
    status: string;
    providerIds?: string[];
  }>(`/api/web-search/${encodeURIComponent(sessionId)}/retry`, {
    providerIds,
  });
  if (!response.data) throw new Error("Web Search retry was not started.");
  return response.data;
}

export async function saveWebSearchResult(
  sessionId: string,
  resultId: string,
  input: {
    mode: "metadata_only" | "save_content" | "download_pdf";
    favorite?: boolean;
    generateSummary?: boolean;
  },
): Promise<import("@/web-search/types").WebSaveResponse> {
  const response = await apiPost<import("@/web-search/types").WebSaveResponse>(
    `/api/web-search/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(resultId)}/save`,
    input,
  );
  if (!response.data) throw new Error("Web result was not saved.");
  return response.data;
}

export function getWebSearchEventsUrl(sessionId: string, afterEventId?: number): string {
  const query =
    afterEventId && afterEventId > 0
      ? `?after=${encodeURIComponent(String(afterEventId))}`
      : "";
  return toApiUrl(`/api/web-search/${encodeURIComponent(sessionId)}/events${query}`);
}

export async function getWebSearchConnections(): Promise<WebSearchConnection[]> {
  const response = await apiGet<WebSearchConnection[]>("/api/web-search/connections");
  return response.data ?? [];
}

export async function getWebSearchProviderCatalog(): Promise<WebSearchProviderCatalogItem[]> {
  const response = await apiGet<WebSearchProviderCatalogItem[]>("/api/web-search/providers/catalog");
  return response.data ?? [];
}

export async function saveWebSearchConnection(payload: {
  id?: string;
  provider: "openalex" | "tavily" | "brave" | "mcp";
  name: string;
  enabled?: boolean;
  isPrimary?: boolean;
  settings: WebSearchConnection["settings"];
  apiKey?: string;
  clearApiKey?: boolean;
}): Promise<WebSearchConnection> {
  const response = payload.id
    ? await apiPut<WebSearchConnection>(
        `/api/web-search/connections/${encodeURIComponent(payload.id)}`,
        payload,
      )
    : await apiPost<WebSearchConnection>("/api/web-search/connections", payload);
  if (!response.data) throw new Error("Web Search connection was not saved.");
  return response.data;
}

export async function activateWebSearchConnection(id: string): Promise<WebSearchConnection> {
  const response = await apiPost<WebSearchConnection>(
    `/api/web-search/connections/${encodeURIComponent(id)}/activate`,
    {},
  );
  if (!response.data) throw new Error("Web Search connection was not activated.");
  return response.data;
}

export interface WebSearchConnectionTestResult {
  status: "healthy" | "degraded" | "unavailable";
  checkedAt: string;
  message?: string;
  diagnostic?: WebSearchConnectionTestDiagnostic;
  discoveredTools?: Array<{ name: string; description?: string }>;
  selectedTool?: { name: string; description?: string };
}

export async function testWebSearchConnection(id: string): Promise<WebSearchConnectionTestResult | undefined> {
  const response = await apiPost<WebSearchConnectionTestResult>(
    `/api/web-search/connections/${encodeURIComponent(id)}/test`,
    {},
  );
  return response.data;
}

export async function getWebSearchHealth(): Promise<WebSearchHealth> {
  const response = await apiGet<WebSearchHealth>("/api/web-search/health");
  if (!response.data) throw new Error("Web Search health is unavailable.");
  return response.data;
}

export async function getWebSearchMetrics(): Promise<WebSearchMetrics> {
  const response = await apiGet<WebSearchMetrics>("/api/web-search/metrics");
  if (!response.data) throw new Error("Web Search metrics are unavailable.");
  return response.data;
}

export async function recordWebSearchResultOpen(
  sessionId: string,
  resultId: string,
): Promise<void> {
  await apiPost(
    `/api/web-search/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(resultId)}/open`,
    {},
  );
}

export async function cancelWebSearch(sessionId: string): Promise<WebSearchSession> {
  const response = await apiPost<WebSearchSession>(
    `/api/web-search/${encodeURIComponent(sessionId)}/cancel`,
    {},
  );
  if (!response.data) throw new Error("Web Search session could not be cancelled.");
  return response.data;
}

export async function generateSearchReport(
  query: string,
  documentIds: string[],
  maxResults?: number,
): Promise<string> {
  const response = await apiPost<{ report: string }>("/api/search/report", {
    query,
    documentIds,
    maxResults,
  });
  return response.data?.report ?? "";
}

export async function getIndexCoverage(): Promise<IndexCoverage> {
  const response = await apiGet<IndexCoverage>("/api/index/coverage");
  return (
    response.data ?? {
      totalDocs: 0,
      ftsIndexed: 0,
      vectorIndexed: 0,
      coverage: "0/0",
      dateRange: null,
      bySource: {},
    }
  );
}

export async function recordSearchFeedback(input: {
  eventId: number;
  documentId?: string;
  rank?: number;
  reformulated?: boolean;
}): Promise<void> {
  await apiPost("/api/search/feedback", input);
}

export async function getTagCloud(category?: string): Promise<
  Array<{
    tag: string;
    canonicalTag?: string;
    aliases?: string[];
    category: string;
    count: number;
  }>
> {
  const suffix = category ? `?category=${encodeURIComponent(category)}` : "";
  const response = await apiGet<
    Array<{
      tag: string;
      canonicalTag?: string;
      aliases?: string[];
      category: string;
      count: number;
    }>
  >(`/api/tags${suffix}`);
  return response.data ?? [];
}

export async function getDocumentsByTag(
  tag: string,
  options?: { limit?: number; page?: number; sortBy?: "time" | "relevance" },
): Promise<PagedResult<Document>> {
  const limit = options?.limit ?? 12;
  const page = Math.max(options?.page ?? 1, 1);
  const search = new URLSearchParams();
  search.set("limit", String(limit));
  search.set("offset", String((page - 1) * limit));
  search.set("sortBy", options?.sortBy ?? "time");
  const response = await apiGet<Document[]>(
    `/api/tags/${encodeURIComponent(tag)}/documents?${search.toString()}`,
  );
  return {
    items: response.data ?? [],
    total: response.meta?.total ?? 0,
    limit: response.meta?.limit ?? limit,
    page: response.meta?.page ?? page,
  };
}

export async function getUserPreferences(): Promise<Record<string, string>> {
  const response = await apiGet<Record<string, string>>("/api/user/preferences");
  return response.data ?? {};
}

export async function saveUserPreferences(payload: Record<string, string>): Promise<Record<string, string>> {
  const response = await apiPost<Record<string, string>>("/api/user/preferences", payload);
  return response.data ?? {};
}

export async function getLlmSettings(): Promise<LlmSettings> {
  const response = await apiGet<LlmSettings>("/api/llm/settings");
  if (!response.data) {
    throw new Error("LLM settings are unavailable");
  }
  return response.data;
}

export async function saveLlmSettings(payload: {
  provider: LlmProviderName;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  baseUrl?: string;
}): Promise<LlmSettings> {
  const response = await apiPost<LlmSettings>("/api/llm/settings", payload);
  if (!response.data) {
    throw new Error("LLM settings were not saved");
  }
  return response.data;
}

export async function getLlmCatalog(): Promise<LlmProviderPreset[]> {
  const response = await apiGet<LlmProviderPreset[]>("/api/llm/catalog");
  return response.data ?? [];
}

export async function getLlmConnections(): Promise<LlmConnectionsState> {
  const response = await apiGet<LlmConnectionsState>("/api/llm/connections");
  if (!response.data) throw new Error("LLM connections are unavailable");
  return response.data;
}

export async function createLlmConnection(payload: LlmConnectionPayload): Promise<LlmConnection> {
  const response = await apiPost<LlmConnection>("/api/llm/connections", payload);
  if (!response.data) throw new Error("LLM connection was not created");
  return response.data;
}

export async function updateLlmConnection(id: string, payload: LlmConnectionPayload): Promise<LlmConnection> {
  const response = await apiPut<LlmConnection>(`/api/llm/connections/${encodeURIComponent(id)}`, payload);
  if (!response.data) throw new Error("LLM connection was not updated");
  return response.data;
}

export async function deleteLlmConnection(id: string): Promise<void> {
  await apiDelete(`/api/llm/connections/${encodeURIComponent(id)}`);
}

export async function activateLlmConnection(id: string): Promise<LlmConnection> {
  const response = await apiPost<LlmConnection>(
    `/api/llm/connections/${encodeURIComponent(id)}/activate`,
    {},
  );
  if (!response.data) throw new Error("LLM connection was not activated");
  return response.data;
}

export async function testLlmConnection(
  connection: LlmConnectionPayload,
): Promise<{ reachable: boolean; latencyMs: number; responsePreview: string }> {
  const response = await apiPost<{
    reachable: boolean;
    latencyMs: number;
    responsePreview: string;
  }>("/api/llm/connections/test", { connection });
  if (!response.data) throw new Error("LLM connection test failed");
  return response.data;
}

export async function discoverLlmConnectionModels(connection: LlmConnectionPayload): Promise<string[]> {
  const response = await apiPost<{ models: string[] }>("/api/llm/connections/models", { connection });
  return response.data?.models ?? [];
}

export async function getEmbeddingSettings(): Promise<EmbeddingSettings> {
  const response = await apiGet<EmbeddingSettings>("/api/settings/embedding");
  if (!response.data) throw new Error("Embedding settings are unavailable");
  return response.data;
}

export async function saveEmbeddingSettings(payload: {
  provider: EmbeddingProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}): Promise<EmbeddingSettings> {
  const response = await apiPut<EmbeddingSettings>("/api/settings/embedding", payload);
  if (!response.data) throw new Error("Embedding settings were not saved");
  return response.data;
}

export async function testEmbeddingConnection(): Promise<{
  provider: string;
  model: string;
  dimensions: number;
  reachable: boolean;
  signature: string;
}> {
  const response = await apiPost<{
    provider: string;
    model: string;
    dimensions: number;
    reachable: boolean;
    signature: string;
  }>("/api/settings/embedding/test", {});
  if (!response.data) throw new Error("Embedding connection test failed");
  return response.data;
}

export async function rebuildEmbeddingIndex(): Promise<{
  rebuilt: boolean;
  index: EmbeddingIndexProgress;
}> {
  const response = await apiPost<{ rebuilt: boolean; index: EmbeddingIndexProgress }>(
    "/api/index/embedding/rebuild",
    {},
  );
  if (!response.data) throw new Error("Embedding index rebuild failed");
  return response.data;
}

export async function getUserMemory(): Promise<MemoryTerm[]> {
  const response = await apiGet<MemoryTerm[]>("/api/user/memory?limit=24");
  return response.data ?? [];
}

export async function rebuildUserMemory(): Promise<{ rebuilt: number }> {
  const response = await apiPost<{ rebuilt: number }>("/api/user/memory/rebuild", {});
  return response.data ?? { rebuilt: 0 };
}

export async function getHistory(options?: {
  limit?: number;
  page?: number;
}): Promise<Array<{ id: number; documentId: string; viewedAt: string }>> {
  const limit = options?.limit ?? 24;
  const page = Math.max(options?.page ?? 1, 1);
  const response = await apiGet<Array<{ id: number; documentId: string; viewedAt: string }>>(
    `/api/user/history?limit=${limit}&offset=${(page - 1) * limit}`,
  );
  return response.data ?? [];
}

export async function getFavorites(options?: {
  limit?: number;
  page?: number;
}): Promise<Array<{ id: number; documentId: string; createdAt: string }>> {
  const limit = options?.limit ?? 24;
  const page = Math.max(options?.page ?? 1, 1);
  const response = await apiGet<Array<{ id: number; documentId: string; createdAt: string }>>(
    `/api/user/favorites?limit=${limit}&offset=${(page - 1) * limit}`,
  );
  return response.data ?? [];
}

export async function addFavorite(documentId: string): Promise<void> {
  await apiPost("/api/user/favorites", { document_id: documentId });
}

export async function removeFavorite(documentId: string): Promise<void> {
  await apiDelete(`/api/user/favorites/${encodeURIComponent(documentId)}`);
}

export async function recordHistory(documentId: string): Promise<void> {
  await apiPost("/api/user/history", { document_id: documentId });
}

async function apiGet<T>(endpoint: string): Promise<ApiEnvelope<T>> {
  return apiRequest<T>(endpoint, { method: "GET" });
}

async function apiPost<T>(endpoint: string, body: unknown): Promise<ApiEnvelope<T>> {
  return apiRequest<T>(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiDelete<T>(endpoint: string): Promise<ApiEnvelope<T>> {
  return apiRequest<T>(endpoint, { method: "DELETE" });
}

async function apiPut<T>(endpoint: string, body: unknown): Promise<ApiEnvelope<T>> {
  return apiRequest<T>(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiRequest<T>(endpoint: string, init: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(toApiUrl(endpoint), init);
  const payload = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok || payload.success === false) {
    throw new ApiRequestError(payload.error ?? `Request failed for ${endpoint}`, {
      errorCode: payload.errorCode,
      details: payload.details,
    });
  }

  return payload;
}

function toApiUrl(endpoint: string): string {
  if (/^https?:\/\//.test(endpoint)) {
    return endpoint;
  }

  return `${resolveApiBase()}${endpoint}`;
}

function resolveApiBase(): string {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.PAPERHUB_API_BASE) {
    return window.PAPERHUB_API_BASE;
  }

  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:3000";
  }

  return "";
}

function resolveTimeRange(range: TimeRangePreset): { from: string; to: string } | null {
  if (range === "all") {
    return null;
  }

  const now = new Date();
  const from = new Date(now);
  const days = getRangeDays(range);
  from.setUTCDate(from.getUTCDate() - days);

  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

function getRangeDays(range: Exclude<TimeRangePreset, "all">): number {
  switch (range) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "365d":
      return 365;
  }
}
