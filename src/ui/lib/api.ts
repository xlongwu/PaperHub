import type { Document, MemoryTerm, RecommendationEntry } from "@/types";

declare global {
  interface Window {
    PAPERHUB_API_BASE?: string;
  }
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export interface SearchResponse {
  results: Array<{
    document: Document;
    score: number;
    matchType: "fts" | "vector" | "hybrid";
    snippet?: string;
  }>;
  total: number;
  mode: string;
  report?: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  page: number;
}

export type TimeRangePreset = "all" | "7d" | "30d" | "90d" | "365d";
export type LlmProviderName = "anthropic" | "openai" | "github-copilot" | "openrouter" | "deepseek";

export interface LlmSettings {
  provider: LlmProviderName;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "stored" | "environment" | "missing";
  supportedProviders: LlmProviderName[];
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

export async function searchDocuments(params: {
  query: string;
  mode: string;
  sources: string[];
  tags: string[];
  timeRange?: TimeRangePreset;
  limit?: number;
  page?: number;
}): Promise<SearchResponse> {
  const search = new URLSearchParams();
  search.set("q", params.query);
  search.set("mode", params.mode);
  const limit = params.limit ?? 12;
  const page = Math.max(params.page ?? 1, 1);
  search.set("limit", String(limit));
  search.set("offset", String((page - 1) * limit));
  if (params.sources.length > 0) {
    search.set("sources", params.sources.join(","));
  }
  if (params.tags.length > 0) {
    search.set("tags", params.tags.join(","));
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

export async function getTagCloud(
  category?: string,
): Promise<Array<{ tag: string; category: string; count: number }>> {
  const suffix = category ? `?category=${encodeURIComponent(category)}` : "";
  const response = await apiGet<Array<{ tag: string; category: string; count: number }>>(
    `/api/tags${suffix}`,
  );
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

async function apiRequest<T>(endpoint: string, init: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(toApiUrl(endpoint), init);
  const payload = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok || payload.success === false) {
    throw new Error(payload.error ?? `Request failed for ${endpoint}`);
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
