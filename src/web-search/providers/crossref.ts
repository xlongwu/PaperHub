import { extractDoi } from "../query-planner";
import type {
  ProviderHealth,
  ProviderSearchContext,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchProvider,
} from "../types";

const DEFAULT_BASE_URL = "https://api.crossref.org";
const USER_AGENT = "PaperHub/0.1 (mailto:paperhub@example.invalid)";

export class CrossrefWebSearchProvider implements WebSearchProvider {
  readonly id = "crossref";
  readonly displayName = "Crossref";
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
    private readonly baseUrl: string = process.env["CROSSREF_BASE_URL"] || DEFAULT_BASE_URL,
  ) {}

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const response = await this.search(
      { query: "10.1038/nphys1170", intent: "exact_identifier", limit: 1 },
      { sessionId: "health-check", timeoutMs: 5_000 },
    );
    return {
      status: response.status === "success" ? "healthy" : "degraded",
      message: response.warning ?? "Crossref connection succeeded",
      checkedAt: new Date().toISOString(),
    };
  }

  async search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(buildCrossrefUrl(request, this.baseUrl), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          providerId: this.id,
          items: [],
          status: response.status === 429 ? "rate_limited" : "failed",
          latencyMs: Date.now() - startedAt,
          warning: `Crossref returned HTTP ${response.status}`,
        };
      }
      const payload = (await response.json()) as unknown;
      return {
        providerId: this.id,
        items: parseCrossrefResponse(payload).slice(0, request.limit),
        status: "success",
        latencyMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id") ?? undefined,
        estimatedCredits: 0,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        providerId: this.id,
        items: [],
        status: timedOut ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: timedOut ? "Crossref request timed out" : "Crossref request failed",
      };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}

export const crossrefWebSearchProvider = new CrossrefWebSearchProvider();

export function buildCrossrefUrl(request: ProviderSearchRequest, baseUrl = DEFAULT_BASE_URL): string {
  const doi = extractDoi(request.query);
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/works${doi ? `/${encodeURIComponent(doi)}` : ""}`);
  if (!doi) {
    url.searchParams.set("query.bibliographic", request.query);
    url.searchParams.set("rows", String(Math.min(Math.max(request.limit, 1), 100)));
    const filters: string[] = [];
    if (request.dateRange?.start) filters.push(`from-pub-date:${isoDate(request.dateRange.start)}`);
    if (request.dateRange?.end) filters.push(`until-pub-date:${isoDate(request.dateRange.end)}`);
    if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  }
  return url.toString();
}

export function parseCrossrefResponse(payload: unknown): ProviderSearchItem[] {
  const message = objectValue(objectValue(payload).message);
  const records = Array.isArray(message.items) ? message.items : message.DOI ? [message] : [];
  return records
    .map((record, index) => parseCrossrefWork(record, index + 1))
    .filter((item): item is ProviderSearchItem => item !== null);
}

function parseCrossrefWork(value: unknown, rank: number): ProviderSearchItem | null {
  const work = objectValue(value);
  const doi = stringValue(work.DOI).toLowerCase();
  const title = firstString(work.title) || firstString(work["short-title"]);
  if (!doi || !title) return null;
  const url = stringValue(work.URL) || `https://doi.org/${doi}`;
  const authors = arrayValue(work.author)
    .map((author) => {
      const row = objectValue(author);
      return [stringValue(row.given), stringValue(row.family)].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const publishedAt = datePartsToIso(
    objectValue(work.published)?.["date-parts"] ??
      objectValue(work["published-print"])["date-parts"] ??
      objectValue(work["published-online"])["date-parts"],
  );
  return {
    providerResultId: doi,
    title,
    url,
    canonicalUrl: `https://doi.org/${doi}`,
    authors,
    publishedAt,
    contentType: "paper",
    abstract: stripTags(stringValue(work.abstract)) || undefined,
    identifiers: { doi },
    origin: {
      domain: domainOf(url),
      publisher: stringValue(work.publisher) || undefined,
      venue: firstString(work["container-title"]) || undefined,
      sourceName: "Crossref",
    },
    providerRank: rank,
    metadata: {
      citedByCount: numberValue(work["is-referenced-by-count"]),
      issue: stringValue(work.issue) || undefined,
      volume: stringValue(work.volume) || undefined,
      page: stringValue(work.page) || undefined,
      type: stringValue(work.type) || undefined,
    },
  };
}

function isoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function datePartsToIso(value: unknown): string | undefined {
  const parts = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : undefined;
  const year = typeof parts?.[0] === "number" ? parts[0] : undefined;
  if (!year) return undefined;
  const month = typeof parts?.[1] === "number" ? parts[1] : 1;
  const day = typeof parts?.[2] === "number" ? parts[2] : 1;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "doi.org";
  }
}

function firstString(value: unknown): string {
  return arrayValue(value).map(stringValue).find(Boolean) ?? "";
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
