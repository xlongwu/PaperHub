import type { WebSearchBudgetPreset, WebSearchIntent, WebSearchPlan, WebSearchRequest } from "./types";

const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+\b/i;
const ARXIV_PATTERN = /\b(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/i;
const OPENALEX_PATTERN = /\b(?:https?:\/\/openalex\.org\/)?(W\d{5,})\b/i;

const BUDGETS: Record<WebSearchBudgetPreset, WebSearchPlan["budget"]> = {
  low_cost: {
    maxProviderCalls: 3,
    maxResultsPerProvider: 5,
    maxTotalResults: 10,
    maxTotalLatencyMs: 12_000,
  },
  balanced: {
    maxProviderCalls: 4,
    maxResultsPerProvider: 10,
    maxTotalResults: 30,
    maxTotalLatencyMs: 25_000,
  },
  broad: {
    maxProviderCalls: 5,
    maxResultsPerProvider: 20,
    maxTotalResults: 80,
    maxTotalLatencyMs: 35_000,
  },
};

export function createWebSearchPlan(request: WebSearchRequest): WebSearchPlan {
  const normalizedQuery = normalizeQuery(request.query);
  const intent = detectIntent(normalizedQuery);
  const requestedProviders = new Set(request.providers?.map((value) => value.toLowerCase()));
  const providerAllowed = (providerId: string) =>
    requestedProviders.size === 0 || requestedProviders.has(providerId);
  const providerCalls: WebSearchPlan["providerCalls"] = [];
  if (request.scope !== "technical") {
    const doi = extractDoi(normalizedQuery);
    if (!doi && providerAllowed("arxiv")) {
      providerCalls.push({
        providerId: "arxiv",
        query: normalizedQuery,
        reason: intent === "exact_identifier" ? "Exact arXiv identifier lookup" : "Academic paper discovery",
      });
    }
    if (providerAllowed("openalex")) {
      providerCalls.push({
        providerId: "openalex",
        query: normalizedQuery,
        reason:
          doi || extractOpenAlexId(normalizedQuery)
            ? "Exact scholarly identifier lookup"
            : "Scholarly metadata and publication discovery",
      });
    }
  }
  if (request.scope !== "academic") {
    if (providerAllowed("tavily")) {
      providerCalls.push({
        providerId: "tavily",
        query: normalizedQuery,
        reason: "Primary technical Web discovery",
      });
    }
    if (providerAllowed("brave")) {
      providerCalls.push({
        providerId: "brave",
        query: normalizedQuery,
        reason:
          request.searchBudget === "broad"
            ? "Broad technical Web discovery"
            : "Fallback technical Web discovery",
      });
    }
  }
  if (requestedProviders.has("mcp")) {
    providerCalls.push({
      providerId: "mcp",
      query: normalizedQuery,
      reason: "User-enabled Search MCP provider",
    });
  }
  const concepts = extractConcepts(normalizedQuery);
  const budgetPreset = request.searchBudget ?? "balanced";
  const baseBudget = {
    ...BUDGETS[budgetPreset],
    maxTotalResults: Math.min(
      request.maxResults ?? BUDGETS[budgetPreset].maxTotalResults,
      100,
    ),
  };
  const selectedCalls =
    request.scope === "mixed" && budgetPreset === "low_cost"
      ? selectLowCostMixedCalls(providerCalls)
      : providerCalls;
  const requestedPerProvider = request.maxResults
    ? Math.ceil((request.maxResults * 1.5) / Math.max(1, selectedCalls.length))
    : baseBudget.maxResultsPerProvider;
  const budget = {
    ...baseBudget,
    maxResultsPerProvider: Math.min(
      100,
      Math.max(baseBudget.maxResultsPerProvider, requestedPerProvider),
    ),
  };

  return {
    originalQuery: request.query,
    normalizedQuery,
    intent,
    scope: request.scope,
    concepts,
    providerCalls: selectedCalls.slice(0, budget.maxProviderCalls),
    budget,
    rewrite: { applied: false },
  };
}

function selectLowCostMixedCalls(
  calls: WebSearchPlan["providerCalls"],
): WebSearchPlan["providerCalls"] {
  const academic =
    calls.find((call) => call.providerId === "openalex" && call.reason.includes("Exact")) ??
    calls.find((call) => call.providerId === "arxiv") ??
    calls.find((call) => call.providerId === "openalex");
  return [
    ...(academic ? [academic] : []),
    ...calls.filter((call) => call.providerId === "tavily" || call.providerId === "brave"),
  ];
}

export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function detectIntent(query: string): WebSearchIntent {
  if (DOI_PATTERN.test(query) || ARXIV_PATTERN.test(query) || OPENALEX_PATTERN.test(query)) {
    return "exact_identifier";
  }
  if (/\b(github|repository|repo|implementation|code)\b/i.test(query)) return "code_lookup";
  if (/\b(author|by\s+[A-Z][\p{L}'-]+)\b/iu.test(query)) return "author_lookup";
  if (/\b(latest|recent|new|this week|this month|最新|近期|本周|本月)\b/iu.test(query)) {
    return "recent_updates";
  }
  if (/\b(paper|arxiv|doi|论文|文章)\b/iu.test(query)) return "paper_lookup";
  if (query.split(/\s+/).length <= 6) return "topic_discovery";
  return "general_research";
}

function extractConcepts(query: string): WebSearchPlan["concepts"] {
  const exact =
    query.match(DOI_PATTERN)?.[0] ?? query.match(ARXIV_PATTERN)?.[1] ?? query.match(OPENALEX_PATTERN)?.[1];
  if (exact) return { must: [exact], should: [], exclude: [] };

  const tokens = query
    .split(/[\s,;:()[\]{}"']+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !/^(the|a|an|for|of|to|in|on|and|or|with)$/i.test(token));
  return { must: [...new Set(tokens)].slice(0, 8), should: [], exclude: [] };
}

export function extractArxivId(query: string): string | undefined {
  return query.match(ARXIV_PATTERN)?.[1];
}

export function extractDoi(query: string): string | undefined {
  return query.match(DOI_PATTERN)?.[0];
}

export function extractOpenAlexId(query: string): string | undefined {
  return query.match(OPENALEX_PATTERN)?.[1]?.toUpperCase();
}

export function extractAuthorQuery(query: string): string {
  return query.replace(/^\s*(?:author|papers?\s+by|works?\s+by|by|作者)\s*[:：]?\s*/iu, "").trim();
}
