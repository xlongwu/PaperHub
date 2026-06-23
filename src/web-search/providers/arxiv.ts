import { extractArxivId } from "../query-planner";
import type {
  ProviderHealth,
  ProviderSearchContext,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchProvider,
} from "../types";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const USER_AGENT = "PaperHub/0.1 (local academic search)";

export class ArxivWebSearchProvider implements WebSearchProvider {
  readonly id = "arxiv";
  readonly displayName = "arXiv";
  readonly kind = "academic" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: false,
    supportsDomainFilter: false,
    supportsExactLookup: true,
    supportsSemanticSearch: false,
    supportsPagination: true,
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "healthy", checkedAt: new Date().toISOString() };
  }

  async search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const deadline = startedAt + context.timeoutMs;
    const maxAttempts = context.timeoutMs >= 2_000 ? 2 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || context.signal?.aborted) break;
      const attemptsLeft = maxAttempts - attempt;
      const attemptTimeoutMs =
        attemptsLeft > 1 ? Math.max(1_000, Math.floor(remainingMs * 0.6)) : remainingMs;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
      const abort = () => controller.abort();
      context.signal?.addEventListener("abort", abort, { once: true });

      try {
        const url = attempt === 0 ? buildArxivUrl(request) : buildArxivUrl(request, { relaxDateRange: true });
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml" },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status >= 500 && attempt + 1 < maxAttempts) {
            continue;
          }
          return {
            providerId: this.id,
            items: [],
            status: response.status === 429 ? "rate_limited" : "failed",
            latencyMs: Date.now() - startedAt,
            warning: `arXiv returned HTTP ${response.status}`,
          };
        }
        const xml = await response.text();
        const items = parseArxivFeed(xml).slice(0, request.limit);
        if (items.length === 0 && attempt === 0 && request.dateRange?.start) {
          // Strict AND + date-range query may yield 0 results.  Retry once
          // without the date filter so the user still gets topical material.
          continue;
        }
        return {
          providerId: this.id,
          items,
          status: "success",
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastError = error;
        if (context.signal?.aborted || attempt + 1 >= maxAttempts) break;
      } finally {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", abort);
      }
    }

    const timedOut =
      context.signal?.aborted ||
      Date.now() >= deadline ||
      (lastError instanceof Error && lastError.name === "AbortError");
    return {
      providerId: this.id,
      items: [],
      status: timedOut ? "timeout" : "failed",
      latencyMs: Date.now() - startedAt,
      warning: timedOut ? "arXiv request timed out after retry" : "arXiv request failed after retry",
    };
  }
}

export const arxivWebSearchProvider = new ArxivWebSearchProvider();

export function buildArxivUrl(
  request: ProviderSearchRequest,
  options?: { relaxDateRange?: boolean },
): string {
  const arxivId = extractArxivId(request.query);
  let searchQuery = arxivId ? `id:${arxivId}` : quoteArxivQuery(request.query);
  if (!options?.relaxDateRange) {
    const start = normalizeArxivDate(request.dateRange?.start, "0000");
    const end = normalizeArxivDate(request.dateRange?.end, "2359");
    if (start || end) {
      searchQuery += ` AND submittedDate:[${start ?? "000000000000"} TO ${end ?? "999912312359"}]`;
    }
  }
  // Build the query string by hand. URLSearchParams encodes spaces as "+", but
  // the arXiv Atom API treats "+" as a literal character inside quoted phrases
  // (e.g. all:"synthetic+data") and inside submittedDate ranges, which makes
  // phrase + date-range queries silently return zero results. Using
  // encodeURIComponent preserves spaces as %20 so the query is parsed correctly.
  const startParam = request.cursor ?? "0";
  const maxResults = String(Math.min(Math.max(request.limit, 1), 100));
  const queryString = [
    `search_query=${encodeURIComponent(searchQuery)}`,
    `start=${encodeURIComponent(startParam)}`,
    `max_results=${encodeURIComponent(maxResults)}`,
    `sortBy=relevance`,
    `sortOrder=descending`,
  ].join("&");
  return `${ARXIV_API_URL}?${queryString}`;
}

export function parseArxivFeed(xml: string): ProviderSearchItem[] {
  return xml
    .split("<entry>")
    .slice(1)
    .map((entry, index) => parseEntry(`<entry>${entry}`, index + 1))
    .filter((entry): entry is ProviderSearchItem => entry !== null);
}

function parseEntry(xml: string, rank: number): ProviderSearchItem | null {
  const idUrl = decodeXml(extractTag(xml, "id"));
  const arxivId = idUrl.match(/\/abs\/([^?#]+)/)?.[1]?.replace(/v\d+$/i, "");
  const title = decodeXml(extractTag(xml, "title")).replace(/\s+/g, " ").trim();
  if (!idUrl || !title) return null;
  const authors = extractBlocks(xml, "author")
    .map((block) => decodeXml(extractTag(block, "name")))
    .filter(Boolean);
  const pdfUrl =
    extractLink(xml, "related") || idUrl.replace("http://", "https://").replace("/abs/", "/pdf/");
  const canonicalUrl = idUrl.replace("http://", "https://").replace(/v\d+$/i, "");

  return {
    providerResultId: arxivId,
    title,
    url: canonicalUrl,
    canonicalUrl,
    authors,
    publishedAt: extractTag(xml, "published") || undefined,
    language: "en",
    contentType: "paper",
    abstract: decodeXml(extractTag(xml, "summary")).replace(/\s+/g, " ").trim(),
    identifiers: { arxivId },
    origin: { domain: "arxiv.org", publisher: "arXiv", sourceName: "arXiv" },
    providerRank: rank,
    metadata: {
      pdfUrl,
      updatedAt: extractTag(xml, "updated") || undefined,
      categories: extractAttributes(xml, "category", "term"),
    },
  };
}

function quoteArxivQuery(query: string): string {
  let remaining = query.replace(/[^\p{L}\p{N}\s._-]+/gu, " ").trim();
  const phrases: string[] = [];
  for (const phrase of [...ARXIV_ACADEMIC_PHRASES].sort((a, b) => b.length - a.length)) {
    if (!remaining.toLowerCase().includes(phrase)) continue;
    phrases.push(phrase);
    remaining = remaining.replace(new RegExp(escapeRegExp(phrase), "giu"), " ");
  }
  const terms = remaining
    .split(/\s+/u)
    .filter(Boolean)
    .filter((term) => !ARXIV_STOP_WORDS.has(term.toLowerCase()));
  return [...phrases.map((phrase) => `all:"${phrase}"`), ...terms.map((term) => `all:${term}`)].join(" AND ");
}

const ARXIV_ACADEMIC_PHRASES = [
  "synthetic data",
  "large language model",
  "large language models",
  "question generation",
  "error correction",
  "self correction",
  "process supervision",
  "reinforcement learning",
  "retrieval augmented generation",
];

const ARXIV_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeArxivDate(value: string | undefined, time: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toISOString().slice(0, 10).replace(/-/g, "")}${time}`;
}

function extractTag(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() ?? "";
}

function extractBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => match[0]);
}

function extractAttributes(xml: string, tag: string, attribute: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*${attribute}="([^"]+)"[^>]*/?>`, "gi"))].map((match) =>
    decodeXml(match[1] ?? ""),
  );
}

function extractLink(xml: string, rel: string): string {
  const tags = [...xml.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const tag = tags.find((value) => new RegExp(`rel="${rel}"`, "i").test(value));
  return tag?.match(/href="([^"]+)"/i)?.[1] ?? "";
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}
