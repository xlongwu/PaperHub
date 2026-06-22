import { extractArxivId, extractDoi } from "../query-planner";
import type {
  ProviderHealth,
  ProviderSearchContext,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchProvider,
} from "../types";

const DEFAULT_BASE_URL = "https://api.github.com";

export class GitHubRepositorySearchProvider implements WebSearchProvider {
  readonly id = "github";
  readonly displayName = "GitHub Repositories";
  readonly kind = "web" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: true,
    supportsDomainFilter: false,
    supportsExactLookup: false,
    supportsSemanticSearch: false,
    supportsPagination: true,
  };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = process.env["GITHUB_API_BASE_URL"] || DEFAULT_BASE_URL,
    private readonly token: string | undefined = process.env["GITHUB_TOKEN"]?.trim() || undefined,
  ) {}

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const response = await this.search(
      { query: "paper implementation", intent: "code_lookup", limit: 1 },
      { sessionId: "health-check", timeoutMs: 5_000 },
    );
    return {
      status: response.status === "success" ? "healthy" : "degraded",
      message: response.warning ?? "GitHub repository search succeeded",
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
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "PaperHub/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await this.fetchImpl(buildGitHubSearchUrl(request, this.baseUrl), {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          providerId: this.id,
          items: [],
          status: response.status === 403 || response.status === 429 ? "rate_limited" : "failed",
          latencyMs: Date.now() - startedAt,
          warning: `GitHub Search returned HTTP ${response.status}`,
        };
      }
      const payload = (await response.json()) as unknown;
      return {
        providerId: this.id,
        items: parseGitHubRepositoryResponse(payload).slice(0, request.limit),
        status: "success",
        latencyMs: Date.now() - startedAt,
        requestId: response.headers.get("x-github-request-id") ?? undefined,
        estimatedCredits: 1,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        providerId: this.id,
        items: [],
        status: timedOut ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: timedOut ? "GitHub Search request timed out" : "GitHub Search request failed",
      };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}

export const githubRepositorySearchProvider = new GitHubRepositorySearchProvider();

export function buildGitHubSearchUrl(
  request: ProviderSearchRequest,
  baseUrl = DEFAULT_BASE_URL,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/search/repositories`);
  url.searchParams.set("q", buildGitHubQuery(request));
  url.searchParams.set("per_page", String(Math.min(Math.max(request.limit, 1), 100)));
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  return url.toString();
}

export function buildGitHubQuery(request: ProviderSearchRequest): string {
  const terms = [request.query];
  const doi = extractDoi(request.query);
  const arxivId = extractArxivId(request.query);
  if (doi) terms.push(doi.replace(/^10\.\d{4,9}\//i, ""));
  if (arxivId) terms.push(arxivId);
  terms.push("implementation OR paper OR research");
  if (request.language) terms.push(`language:${request.language}`);
  if (request.dateRange?.start) terms.push(`pushed:>=${isoDate(request.dateRange.start)}`);
  if (request.dateRange?.end) terms.push(`pushed:<=${isoDate(request.dateRange.end)}`);
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].join(" ");
}

export function parseGitHubRepositoryResponse(payload: unknown): ProviderSearchItem[] {
  const items = objectArray(payload, "items");
  return items
    .map((item, index): ProviderSearchItem | null => {
      const row = objectValue(item);
      const owner = objectValue(row.owner);
      const fullName = stringValue(row.full_name);
      const url = stringValue(row.html_url);
      if (!fullName || !url) return null;
      const description = stringValue(row.description);
      return {
        providerResultId: String(row.id ?? fullName),
        title: fullName,
        url,
        canonicalUrl: url,
        authors: [stringValue(owner.login)].filter(Boolean),
        publishedAt: stringValue(row.pushed_at) || stringValue(row.updated_at) || undefined,
        language: stringValue(row.language) || undefined,
        contentType: "repository",
        snippet: description || undefined,
        identifiers: {},
        origin: { domain: "github.com", sourceName: "GitHub" },
        providerRank: index + 1,
        providerRawScore: numberValue(row.score),
        metadata: {
          stars: numberValue(row.stargazers_count),
          forks: numberValue(row.forks_count),
          topics: arrayValue(row.topics).filter((value): value is string => typeof value === "string"),
          owner: stringValue(owner.login) || undefined,
          officialLikelihood: scoreRepositoryQuality(row),
        },
      };
    })
    .filter((item): item is ProviderSearchItem => item !== null);
}

function scoreRepositoryQuality(row: Record<string, unknown>): number {
  const stars = numberValue(row.stargazers_count) ?? 0;
  const archivedPenalty = row.archived === true ? 0.25 : 0;
  const forkPenalty = row.fork === true ? 0.2 : 0;
  return Math.max(0, Math.min(1, Math.log10(stars + 1) / 4 - archivedPenalty - forkPenalty));
}

function isoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
