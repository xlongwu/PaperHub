import { getActiveWebSearchConnection } from "@/db/web-search-connections";
import { extractArxivId, extractAuthorQuery, extractDoi, extractOpenAlexId } from "../query-planner";
import type {
  ProviderHealth,
  ProviderSearchContext,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchConnectionConfig,
  WebSearchProvider,
} from "../types";

const DEFAULT_BASE_URL = "https://api.openalex.org";

type ConnectionResolver = () => WebSearchConnectionConfig | null;

export class OpenAlexWebSearchProvider implements WebSearchProvider {
  readonly id = "openalex";
  readonly displayName = "OpenAlex";
  readonly kind = "academic" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: false,
    supportsDomainFilter: false,
    supportsExactLookup: true,
    supportsSemanticSearch: false,
    supportsPagination: true,
  };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveConnection: ConnectionResolver = resolveOpenAlexConnection,
  ) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.resolveConnection()?.apiKey);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const connection = this.resolveConnection();
    if (!connection?.apiKey) {
      return {
        status: "unavailable",
        message: "OpenAlex is not configured",
        checkedAt: new Date().toISOString(),
      };
    }
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(buildOpenAlexHealthUrl(connection), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      return {
        status: response.ok ? "healthy" : "degraded",
        message: response.ok
          ? `OpenAlex reachable in ${Date.now() - startedAt} ms`
          : `OpenAlex returned HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        status: "unavailable",
        message: "OpenAlex connection failed",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const connection = this.resolveConnection();
    if (!connection?.apiKey) {
      return {
        providerId: this.id,
        items: [],
        status: "not_configured",
        latencyMs: 0,
        warning: "OpenAlex is not configured",
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      let authorId: string | undefined;
      let requestCount = 1;
      if (request.intent === "author_lookup") {
        const authorResponse = await this.fetchImpl(buildOpenAlexAuthorUrl(request, connection), {
          headers: { Accept: "application/json", "User-Agent": "PaperHub/0.1" },
          signal: controller.signal,
        });
        if (!authorResponse.ok) {
          return {
            providerId: this.id,
            items: [],
            status: authorResponse.status === 429 ? "rate_limited" : "failed",
            latencyMs: Date.now() - startedAt,
            warning: `OpenAlex returned HTTP ${authorResponse.status}`,
            estimatedCredits: 1,
          };
        }
        authorId = parseFirstOpenAlexAuthorId((await authorResponse.json()) as unknown);
        if (!authorId) {
          return {
            providerId: this.id,
            items: [],
            status: "success",
            latencyMs: Date.now() - startedAt,
            estimatedCredits: 1,
            warning: "OpenAlex found no matching author",
          };
        }
        requestCount += 1;
      }
      const url = buildOpenAlexUrl(request, connection, authorId);
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "PaperHub/0.1" },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          providerId: this.id,
          items: [],
          status: response.status === 429 ? "rate_limited" : "failed",
          latencyMs: Date.now() - startedAt,
          warning: `OpenAlex returned HTTP ${response.status}`,
          estimatedCredits: requestCount,
        };
      }
      const payload = (await response.json()) as unknown;
      return {
        providerId: this.id,
        items: parseOpenAlexResponse(payload).slice(0, request.limit),
        status: "success",
        latencyMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id") ?? undefined,
        estimatedCredits: requestCount,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        providerId: this.id,
        items: [],
        status: timedOut ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: timedOut ? "OpenAlex request timed out" : "OpenAlex request failed",
      };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}

export const openAlexWebSearchProvider = new OpenAlexWebSearchProvider();

export function buildOpenAlexUrl(
  request: ProviderSearchRequest,
  connection: Pick<WebSearchConnectionConfig, "apiKey" | "settings">,
  authorId?: string,
): string {
  const baseUrl = (connection.settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doi = extractDoi(request.query);
  const openAlexId = extractOpenAlexId(request.query);
  const exactPath = doi
    ? `/works/https://doi.org/${encodeURIComponent(doi)}`
    : openAlexId
      ? `/works/${openAlexId.toUpperCase()}`
      : "/works";
  const url = new URL(`${baseUrl}${exactPath}`);
  url.searchParams.set("api_key", connection.apiKey ?? "");
  if (!doi && !openAlexId) {
    if (!authorId) url.searchParams.set("search", request.query);
    url.searchParams.set("per-page", String(Math.min(Math.max(request.limit, 1), 100)));
    if (request.cursor) url.searchParams.set("cursor", request.cursor);
    const filters: string[] = [];
    if (authorId) filters.push(`author.id:${authorId}`);
    if (request.dateRange?.start) {
      filters.push(`from_publication_date:${toOpenAlexDate(request.dateRange.start)}`);
    }
    if (request.dateRange?.end) {
      filters.push(`to_publication_date:${toOpenAlexDate(request.dateRange.end)}`);
    }
    if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  }
  return url.toString();
}

export function buildOpenAlexAuthorUrl(
  request: ProviderSearchRequest,
  connection: Pick<WebSearchConnectionConfig, "apiKey" | "settings">,
): string {
  const baseUrl = (connection.settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/authors`);
  url.searchParams.set("api_key", connection.apiKey ?? "");
  url.searchParams.set("search", extractAuthorQuery(request.query));
  url.searchParams.set("per-page", "1");
  return url.toString();
}

export function parseOpenAlexResponse(payload: unknown): ProviderSearchItem[] {
  const records =
    payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [payload];
  return records
    .map((record, index) => parseOpenAlexWork(record, index + 1))
    .filter((item): item is ProviderSearchItem => item !== null);
}

function parseOpenAlexWork(value: unknown, rank: number): ProviderSearchItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const work = value as Record<string, unknown>;
  const title = stringValue(work.title) || stringValue(work.display_name);
  const openAlexId = extractOpenAlexId(stringValue(work.id));
  if (!title || !openAlexId) return null;
  const ids = objectValue(work.ids);
  const doi = normalizeDoi(stringValue(ids.doi));
  const locations = arrayValue(work.locations);
  const primaryLocation = objectValue(work.primary_location);
  const landingPageUrl =
    stringValue(primaryLocation.landing_page_url) ||
    locations.map((entry) => stringValue(objectValue(entry).landing_page_url)).find(Boolean) ||
    "";
  const arxivId = findArxivId([
    landingPageUrl,
    ...locations.map((entry) => stringValue(objectValue(entry).landing_page_url)),
  ]);
  const authorships = arrayValue(work.authorships);
  const authors = authorships
    .map((entry) => stringValue(objectValue(objectValue(entry).author).display_name))
    .filter(Boolean);
  const source = objectValue(primaryLocation.source);
  const venue = stringValue(source.display_name);
  const publisher = stringValue(source.host_organization_name);
  const canonicalUrl = doi
    ? `https://doi.org/${doi}`
    : landingPageUrl || `https://openalex.org/${openAlexId}`;
  const topics = arrayValue(work.topics)
    .map((entry) => stringValue(objectValue(entry).display_name))
    .filter(Boolean);
  const institutions = authorships.flatMap((entry) =>
    arrayValue(objectValue(entry).institutions)
      .map((institution) => stringValue(objectValue(institution).display_name))
      .filter(Boolean),
  );

  return {
    providerResultId: openAlexId,
    title,
    url: canonicalUrl,
    canonicalUrl,
    authors,
    publishedAt: stringValue(work.publication_date) || undefined,
    language: stringValue(work.language) || undefined,
    contentType: "paper",
    abstract: reconstructAbstract(objectValue(work.abstract_inverted_index)),
    identifiers: { doi, arxivId, openAlexId },
    origin: {
      domain: domainOf(canonicalUrl),
      publisher: publisher || undefined,
      venue: venue || undefined,
      sourceName: "OpenAlex",
    },
    providerRank: rank,
    metadata: {
      citedByCount: numberValue(work.cited_by_count),
      openAccess: objectValue(work.open_access),
      institutions: [...new Set(institutions)],
      topics,
      workType: stringValue(work.type) || undefined,
      landingPageUrl: landingPageUrl || undefined,
    },
  };
}

function resolveOpenAlexConnection(): WebSearchConnectionConfig | null {
  const stored = getActiveWebSearchConnection("openalex");
  const environmentKey = process.env["OPENALEX_API_KEY"]?.trim();
  if (environmentKey) {
    return {
      id: "env-openalex",
      provider: "openalex",
      name: "OpenAlex environment",
      enabled: true,
      isPrimary: true,
      settings: { baseUrl: process.env["OPENALEX_BASE_URL"] || DEFAULT_BASE_URL },
      hasApiKey: true,
      apiKey: environmentKey,
      createdAt: "",
      updatedAt: "",
    };
  }
  return stored;
}

function buildOpenAlexHealthUrl(connection: WebSearchConnectionConfig): string {
  return buildOpenAlexUrl({ query: "W2741809807", intent: "exact_identifier", limit: 1 }, connection);
}

function reconstructAbstract(index: Record<string, unknown>): string | undefined {
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of arrayValue(positions)) {
      if (typeof position === "number") words.push([position, word]);
    }
  }
  return words.length > 0
    ? words
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1])
        .join(" ")
    : undefined;
}

function parseFirstOpenAlexAuthorId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const results = arrayValue((payload as Record<string, unknown>).results);
  const id = stringValue(objectValue(results[0]).id);
  return id.match(/\bA\d+\b/i)?.[0]?.toUpperCase();
}

function findArxivId(urls: string[]): string | undefined {
  for (const url of urls) {
    const id = extractArxivId(url);
    if (id) return id;
  }
  return undefined;
}

function normalizeDoi(value: string): string | undefined {
  return value ? value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase() : undefined;
}

function toOpenAlexDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "openalex.org";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
