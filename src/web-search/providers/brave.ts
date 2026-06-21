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

const DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";
type ConnectionResolver = () => WebSearchConnectionConfig | null;

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly id = "brave";
  readonly displayName = "Brave Search";
  readonly kind = "web" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: true,
    supportsDomainFilter: true,
    supportsExactLookup: false,
    supportsSemanticSearch: false,
    supportsPagination: true,
  };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveConnection: ConnectionResolver = resolveBraveConnection,
  ) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.resolveConnection()?.apiKey);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const connection = this.resolveConnection();
    if (!connection?.apiKey) {
      return { status: "unavailable", message: "Brave Search is not configured", checkedAt: new Date().toISOString() };
    }
    const response = await this.search(
      { query: "PaperHub connection test", intent: "topic_discovery", limit: 1 },
      { sessionId: "health-check", timeoutMs: 5_000 },
    );
    return {
      status: response.status === "success" ? "healthy" : "unavailable",
      message: response.warning ?? (response.status === "success" ? "Brave Search connection succeeded" : "Brave Search connection failed"),
      checkedAt: new Date().toISOString(),
    };
  }

  async search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const connection = this.resolveConnection();
    if (!connection?.apiKey) {
      return { providerId: this.id, items: [], status: "not_configured", latencyMs: 0, warning: "Brave Search is not configured" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(buildBraveUrl(request, connection), {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": connection.apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          providerId: this.id,
          items: [],
          status: response.status === 429 ? "rate_limited" : "failed",
          latencyMs: Date.now() - startedAt,
          warning: `Brave Search returned HTTP ${response.status}`,
        };
      }
      return {
        providerId: this.id,
        items: parseBraveResponse((await response.json()) as unknown).slice(0, request.limit),
        status: "success",
        latencyMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id") ?? undefined,
        estimatedCredits: 1,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        providerId: this.id,
        items: [],
        status: timedOut ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: timedOut ? "Brave Search request timed out" : "Brave Search request failed",
      };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}

export const braveWebSearchProvider = new BraveWebSearchProvider();

export function buildBraveUrl(
  request: ProviderSearchRequest,
  connection: Pick<WebSearchConnectionConfig, "settings">,
): string {
  const baseUrl = (connection.settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/web/search`);
  url.searchParams.set("q", buildBraveQuery(request));
  url.searchParams.set("count", String(Math.min(Math.max(request.limit, 1), 20)));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("extra_snippets", "true");
  if (request.cursor && /^\d+$/.test(request.cursor)) url.searchParams.set("offset", request.cursor);
  if (request.language) url.searchParams.set("search_lang", request.language);
  const freshness = buildFreshness(request.dateRange);
  if (freshness) url.searchParams.set("freshness", freshness);
  return url.toString();
}

export function parseBraveResponse(payload: unknown): ProviderSearchItem[] {
  const web = objectValue(objectValue(payload).web);
  const results = Array.isArray(web.results) ? web.results : [];
  return results
    .map((value, index): ProviderSearchItem | null => {
      const row = objectValue(value);
      const title = stringValue(row.title);
      const url = stringValue(row.url);
      if (!title || !url) return null;
      const snippets = Array.isArray(row.extra_snippets)
        ? row.extra_snippets.filter((entry): entry is string => typeof entry === "string")
        : [];
      return {
        providerResultId: stringValue(row.profile) || url,
        title,
        url,
        canonicalUrl: url,
        authors: [],
        publishedAt: stringValue(row.page_age) || stringValue(row.age) || undefined,
        language: stringValue(row.language) || undefined,
        contentType: classifyWebContent(url, title, stringValue(row.type)),
        snippet: [stringValue(row.description), ...snippets].filter(Boolean).join(" ").trim() || undefined,
        identifiers: {},
        origin: { domain: domainOf(url), sourceName: "Brave Search" },
        providerRank: index + 1,
      };
    })
    .filter((item): item is ProviderSearchItem => item !== null);
}

function resolveBraveConnection(): WebSearchConnectionConfig | null {
  const environmentKey = process.env["BRAVE_SEARCH_API_KEY"]?.trim() || process.env["BRAVE_API_KEY"]?.trim();
  if (environmentKey) {
    return {
      id: "env-brave",
      provider: "brave",
      name: "Brave environment",
      enabled: true,
      isPrimary: true,
      settings: { baseUrl: process.env["BRAVE_SEARCH_BASE_URL"] || DEFAULT_BASE_URL },
      hasApiKey: true,
      apiKey: environmentKey,
      createdAt: "",
      updatedAt: "",
    };
  }
  return getActiveWebSearchConnection("brave");
}

function buildBraveQuery(request: ProviderSearchRequest): string {
  const include = request.includeDomains?.map(normalizeDomain).filter(Boolean) ?? [];
  const exclude = request.excludeDomains?.map(normalizeDomain).filter(Boolean) ?? [];
  const includeClause =
    include.length === 0
      ? ""
      : include.length === 1
        ? ` site:${include[0]}`
        : ` (${include.map((domain) => `site:${domain}`).join(" OR ")})`;
  const excludeClause = exclude.map((domain) => ` -site:${domain}`).join("");
  return `${request.query}${includeClause}${excludeClause}`.trim();
}

function buildFreshness(dateRange: ProviderSearchRequest["dateRange"]): string | undefined {
  if (!dateRange?.start && !dateRange?.end) return undefined;
  const start = dateRange.start ? new Date(dateRange.start).toISOString().slice(0, 10) : "1970-01-01";
  const end = dateRange.end ? new Date(dateRange.end).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${start}to${end}`;
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
