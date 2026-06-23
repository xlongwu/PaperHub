import { getActiveWebSearchConnection } from "@/db/web-search-connections";
import { classifyWebContent, normalizeDomain } from "../content-classifier";
import type {
  ProviderHealth,
  ProviderSearchContext,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchConnectionConfig,
  WebSearchProvider,
} from "../types";

const DEFAULT_BASE_URL = "https://api.tavily.com";
type ConnectionResolver = () => WebSearchConnectionConfig | null;

export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = "tavily";
  readonly displayName = "Tavily";
  readonly kind = "web" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: false,
    supportsDomainFilter: true,
    supportsExactLookup: false,
    supportsSemanticSearch: true,
    supportsPagination: false,
  };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveConnection: ConnectionResolver = resolveTavilyConnection,
  ) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.resolveConnection()?.apiKey);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const connection = this.resolveConnection();
    if (!connection?.apiKey) {
      return {
        status: "unavailable",
        message: "Tavily is not configured",
        checkedAt: new Date().toISOString(),
      };
    }
    const response = await this.search(
      { query: "PaperHub connection test", intent: "topic_discovery", limit: 1 },
      { sessionId: "health-check", timeoutMs: 5_000 },
    );
    return {
      status: response.status === "success" ? "healthy" : "unavailable",
      message:
        response.warning ??
        (response.status === "success" ? "Tavily connection succeeded" : "Tavily connection failed"),
      checkedAt: new Date().toISOString(),
    };
  }

  async search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const connection = this.resolveConnection();
    if (!connection?.apiKey) return notConfigured(this.id, "Tavily is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(buildTavilyUrl(connection), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify(buildTavilyRequest(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          providerId: this.id,
          items: [],
          status: response.status === 429 ? "rate_limited" : "failed",
          latencyMs: Date.now() - startedAt,
          warning: `Tavily returned HTTP ${response.status}`,
        };
      }
      const payload = (await response.json()) as unknown;
      return {
        providerId: this.id,
        items: parseTavilyResponse(payload).slice(0, request.limit),
        status: "success",
        latencyMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id") ?? objectString(payload, "request_id"),
        estimatedCredits: 1,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        providerId: this.id,
        items: [],
        status: timedOut ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: timedOut ? "Tavily request timed out" : "Tavily request failed",
      };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}

export const tavilyWebSearchProvider = new TavilyWebSearchProvider();

export function buildTavilyRequest(request: ProviderSearchRequest): Record<string, unknown> {
  return {
    query: request.query,
    search_depth: "basic",
    max_results: Math.min(Math.max(request.limit, 1), 20),
    include_raw_content: false,
    include_answer: false,
    ...(request.includeDomains?.length
      ? { include_domains: request.includeDomains.map(normalizeDomain).filter(Boolean) }
      : {}),
    ...(request.excludeDomains?.length
      ? { exclude_domains: request.excludeDomains.map(normalizeDomain).filter(Boolean) }
      : {}),
    ...(request.dateRange?.start ? { start_date: isoDate(request.dateRange.start) } : {}),
    ...(request.dateRange?.end ? { end_date: isoDate(request.dateRange.end) } : {}),
  };
}

export function parseTavilyResponse(payload: unknown): ProviderSearchItem[] {
  const results = objectArray(payload, "results");
  return results
    .map((value, index): ProviderSearchItem | null => {
      const row = objectValue(value);
      const title = stringValue(row.title);
      const url = stringValue(row.url);
      if (!title || !url) return null;
      return {
        providerResultId: stringValue(row.id) || url,
        title,
        url,
        canonicalUrl: url,
        authors: [],
        publishedAt: stringValue(row.published_date) || undefined,
        contentType: classifyWebContent(url, title, stringValue(row.type)),
        snippet: stringValue(row.content) || undefined,
        identifiers: {},
        origin: { domain: domainOf(url), sourceName: "Tavily" },
        providerRank: index + 1,
        providerRawScore: numberValue(row.score),
      };
    })
    .filter((item): item is ProviderSearchItem => item !== null);
}

function resolveTavilyConnection(): WebSearchConnectionConfig | null {
  const environmentKey = process.env["TAVILY_API_KEY"]?.trim();
  if (environmentKey) {
    return environmentConnection(
      "tavily",
      environmentKey,
      process.env["TAVILY_BASE_URL"] || DEFAULT_BASE_URL,
    );
  }
  return getActiveWebSearchConnection("tavily");
}

function buildTavilyUrl(connection: WebSearchConnectionConfig): string {
  return `${(connection.settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/search`;
}

function environmentConnection(
  provider: "tavily",
  apiKey: string,
  baseUrl: string,
): WebSearchConnectionConfig {
  return {
    id: `env-${provider}`,
    provider,
    name: `${provider} environment`,
    enabled: true,
    isPrimary: true,
    settings: { baseUrl },
    hasApiKey: true,
    apiKey,
    createdAt: "",
    updatedAt: "",
  };
}

function notConfigured(providerId: string, warning: string): ProviderSearchResponse {
  return { providerId, items: [], status: "not_configured", latencyMs: 0, warning };
}

function isoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectArray(value: unknown, key: string): unknown[] {
  const result = objectValue(value)[key];
  return Array.isArray(result) ? result : [];
}

function objectString(value: unknown, key: string): string | undefined {
  return stringValue(objectValue(value)[key]) || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
