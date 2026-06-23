import { createHash, randomUUID } from "node:crypto";
import {
  appendWebSearchEvent,
  cancelWebSearchSession,
  createWebSearchSessionRecord,
  getCachedWebSearchProviderResponse,
  getWebSearchSession,
  insertWebSearchResults,
  replaceWebSearchResults,
  updateWebSearchSession,
  upsertCachedWebSearchProviderResponse,
  upsertWebSearchProviderRun,
} from "@/db/web-search";
import { recordWebSearchUsageEvent } from "@/db/web-search-metrics";
import { createWebSearchPlan } from "@/web-search/query-planner";
import { arxivWebSearchProvider } from "@/web-search/providers/arxiv";
import { openAlexWebSearchProvider } from "@/web-search/providers/openalex";
import { crossrefWebSearchProvider } from "@/web-search/providers/crossref";
import { braveWebSearchProvider } from "@/web-search/providers/brave";
import { tavilyWebSearchProvider } from "@/web-search/providers/tavily";
import { githubRepositorySearchProvider } from "@/web-search/providers/github";
import { mcpWebSearchProvider } from "@/web-search/providers/mcp";
import { generateWebSearchSynthesis } from "./web-search-summary";
import type {
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchPlan,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSession,
} from "@/web-search/types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CACHE_OPTIONS_VERSION = 1;
const activeControllers = new Map<string, AbortController>();
const providers = new Map<string, WebSearchProvider>([
  [arxivWebSearchProvider.id, arxivWebSearchProvider],
  [openAlexWebSearchProvider.id, openAlexWebSearchProvider],
  [crossrefWebSearchProvider.id, crossrefWebSearchProvider],
  [tavilyWebSearchProvider.id, tavilyWebSearchProvider],
  [braveWebSearchProvider.id, braveWebSearchProvider],
  [githubRepositorySearchProvider.id, githubRepositorySearchProvider],
  [mcpWebSearchProvider.id, mcpWebSearchProvider],
]);

export function createWebSearchSession(request: WebSearchRequest): WebSearchSession {
  const id = `ws_${randomUUID().replace(/-/g, "")}`;
  const session = createWebSearchSessionRecord({
    id,
    request,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  recordWebSearchUsageEvent({ sessionId: id, eventType: "search" });
  return session;
}

export async function executeWebSearchSession(
  sessionId: string,
  providerRegistry: ReadonlyMap<string, WebSearchProvider> = providers,
): Promise<WebSearchSession> {
  const session = getWebSearchSession(sessionId);
  if (!session) throw new Error(`Web search session "${sessionId}" was not found.`);
  if (session.status === "cancelled" || session.status === "expired") return session;

  const controller = new AbortController();
  activeControllers.set(sessionId, controller);
  try {
    updateWebSearchSession({ id: sessionId, status: "planning", error: null });
    const plan = createWebSearchPlan(session.request);
    updateWebSearchSession({ id: sessionId, status: "searching", plan });
    appendWebSearchEvent(sessionId, "plan.completed", { plan });
    if (plan.rewrite?.applied) {
      appendWebSearchEvent(sessionId, "query.rewritten", {
        originalQuery: plan.originalQuery,
        rewrittenQuery: plan.rewrite.rewrittenQuery,
        reason: plan.rewrite.reason,
      });
    }

    if (plan.providerCalls.length === 0) {
      return failSession(
        sessionId,
        "No provider is available for this scope in the current Web Search phase.",
      );
    }

    const responses = await executeProviderPlan(
      sessionId,
      plan,
      session.request,
      controller.signal,
      providerRegistry,
    );
    if (getWebSearchSession(sessionId)?.status === "cancelled") {
      return getWebSearchSession(sessionId)!;
    }

    const usable = responses.filter(
      (response) => response.status === "success" || response.status === "partial",
    );
    if (usable.length === 0) {
      return failSession(sessionId, responses[0]?.warning ?? "All Web Search providers failed.");
    }

    updateWebSearchSession({ id: sessionId, status: "aggregating" });
    appendWebSearchEvent(sessionId, "aggregation.started", {
      providerCount: usable.length,
    });
    const latestSession = getWebSearchSession(sessionId)!;
    const results = aggregateResults(sessionId, plan, session.request, usable, latestSession.expiresAt).slice(
      0,
      plan.budget.maxTotalResults,
    );
    insertWebSearchResults(results);
    const rawResults = usable.reduce((sum, response) => sum + response.items.length, 0);
    recordWebSearchUsageEvent({
      sessionId,
      eventType: "aggregation",
      metadata: {
        rawResults,
        deduplicatedResults: results.length,
        multiProviderResults: results.filter((result) => result.providerEvidence.length > 1).length,
      },
    });
    appendWebSearchEvent(sessionId, "aggregation.completed", {
      resultCount: results.length,
    });

    const partial = responses.some((response) => !["success", "not_configured"].includes(response.status));
    if (session.request.autoSummarize && results.length > 0) {
      updateWebSearchSession({ id: sessionId, status: "summarizing" });
      await generateWebSearchSynthesis(sessionId);
    } else if (session.request.autoSummarize) {
      appendWebSearchEvent(sessionId, "summary.skipped", {
        kind: "synthesis",
        reason: "no_results",
      });
    }
    const status = partial ? "partial" : "completed";
    updateWebSearchSession({ id: sessionId, status });
    appendWebSearchEvent(sessionId, partial ? "session.partial" : "session.completed", {
      status,
      resultCount: results.length,
    });
    return getWebSearchSession(sessionId)!;
  } catch (error) {
    if (getWebSearchSession(sessionId)?.status === "cancelled") {
      return getWebSearchSession(sessionId)!;
    }
    return failSession(sessionId, error instanceof Error ? error.message : "Web search failed.");
  } finally {
    activeControllers.delete(sessionId);
  }
}

export async function retryWebSearchProviders(
  sessionId: string,
  providerIds?: string[],
  providerRegistry: ReadonlyMap<string, WebSearchProvider> = providers,
): Promise<WebSearchSession> {
  const session = getWebSearchSession(sessionId);
  if (!session) throw new Error(`Web search session "${sessionId}" was not found.`);
  if (session.status !== "failed" && session.status !== "partial") {
    throw new Error("Only failed or partial Web Search sessions can be retried.");
  }

  const plan = session.plan ?? createWebSearchPlan(session.request);
  const plannedProviders = new Set(plan.providerCalls.map((call) => call.providerId));
  const requested = new Set((providerIds ?? []).map((providerId) => providerId.toLowerCase()));
  const failedProviders = session.providerRuns
    .filter((run) => !["success", "partial", "not_configured"].includes(run.status))
    .map((run) => run.providerId);
  const retryProviders = (requested.size > 0 ? [...requested] : failedProviders).filter((providerId) =>
    plannedProviders.has(providerId),
  );
  if (retryProviders.length === 0) {
    throw new Error("No failed planned providers were selected for retry.");
  }

  const controller = new AbortController();
  activeControllers.set(sessionId, controller);
  try {
    updateWebSearchSession({ id: sessionId, status: "searching", plan, error: null });
    appendWebSearchEvent(sessionId, "retry.started", { providerIds: retryProviders });
    const retryCalls = new Set(retryProviders);
    const responses = await Promise.all(
      plan.providerCalls
        .filter((call) => retryCalls.has(call.providerId))
        .map((call) =>
          executeProviderCall(
            sessionId,
            call.providerId,
            plan,
            session.request,
            controller.signal,
            providerRegistry,
          ),
        ),
    );
    if (getWebSearchSession(sessionId)?.status === "cancelled") {
      return getWebSearchSession(sessionId)!;
    }

    const retainedResponses = retainedResultResponses(session, retryCalls);
    const usable = [...retainedResponses, ...responses].filter(
      (response) => response.status === "success" || response.status === "partial",
    );
    if (usable.length === 0) {
      return failSession(
        sessionId,
        responses[0]?.warning ?? "Retried Web Search providers returned no usable results.",
      );
    }

    updateWebSearchSession({ id: sessionId, status: "aggregating" });
    appendWebSearchEvent(sessionId, "aggregation.started", {
      providerCount: usable.length,
      retry: true,
    });
    const latestSession = getWebSearchSession(sessionId)!;
    const previousLocalState = new Map(session.results.map((result) => [result.id, result.localState]));
    const results = aggregateResults(sessionId, plan, session.request, usable, latestSession.expiresAt)
      .map((result) => ({
        ...result,
        localState: previousLocalState.get(result.id) ?? result.localState,
      }))
      .slice(0, plan.budget.maxTotalResults);
    replaceWebSearchResults(sessionId, results);
    appendWebSearchEvent(sessionId, "aggregation.completed", {
      resultCount: results.length,
      retry: true,
    });
    const refreshed = getWebSearchSession(sessionId)!;
    const partial = refreshed.providerRuns.some(
      (run) => !["success", "partial", "not_configured"].includes(run.status),
    );
    const status = partial ? "partial" : "completed";
    updateWebSearchSession({ id: sessionId, status });
    appendWebSearchEvent(sessionId, "retry.completed", {
      status,
      providerIds: retryProviders,
      resultCount: results.length,
    });
    return getWebSearchSession(sessionId)!;
  } catch (error) {
    if (getWebSearchSession(sessionId)?.status === "cancelled") {
      return getWebSearchSession(sessionId)!;
    }
    return failSession(sessionId, error instanceof Error ? error.message : "Web search retry failed.");
  } finally {
    activeControllers.delete(sessionId);
  }
}

async function executeProviderPlan(
  sessionId: string,
  plan: WebSearchPlan,
  request: WebSearchRequest,
  signal: AbortSignal,
  providerRegistry: ReadonlyMap<string, WebSearchProvider>,
): Promise<ProviderSearchResponse[]> {
  const academicCalls = plan.providerCalls.filter(
    (call) =>
      call.providerId !== "tavily" &&
      call.providerId !== "brave" &&
      call.providerId !== "github" &&
      call.providerId !== "mcp",
  );
  const webCalls = plan.providerCalls.filter(
    (call) =>
      call.providerId === "tavily" ||
      call.providerId === "brave" ||
      call.providerId === "github" ||
      call.providerId === "mcp",
  );
  const responses = await Promise.all(
    academicCalls.map((call) =>
      executeProviderCall(sessionId, call.providerId, plan, request, signal, providerRegistry),
    ),
  );
  if (webCalls.length === 0) return responses;

  if (request.searchBudget === "broad") {
    responses.push(
      ...(await Promise.all(
        webCalls.map((call) =>
          executeProviderCall(sessionId, call.providerId, plan, request, signal, providerRegistry),
        ),
      )),
    );
    return responses;
  }

  const tavilyCall = webCalls.find((call) => call.providerId === "tavily");
  const braveCall = webCalls.find((call) => call.providerId === "brave");
  const githubCall = webCalls.find((call) => call.providerId === "github");
  const mcpCall = webCalls.find((call) => call.providerId === "mcp");
  if (mcpCall) {
    responses.push(
      await executeProviderCall(sessionId, mcpCall.providerId, plan, request, signal, providerRegistry),
    );
  }
  if (githubCall) {
    responses.push(
      await executeProviderCall(sessionId, githubCall.providerId, plan, request, signal, providerRegistry),
    );
  }
  const primary = tavilyCall ?? braveCall;
  if (!primary) return responses;
  const primaryResponse = await executeProviderCall(
    sessionId,
    primary.providerId,
    plan,
    request,
    signal,
    providerRegistry,
  );
  responses.push(primaryResponse);
  if (
    primary.providerId === "tavily" &&
    braveCall &&
    !["success", "partial"].includes(primaryResponse.status)
  ) {
    appendWebSearchEvent(sessionId, "provider.failover", {
      fromProviderId: "tavily",
      toProviderId: "brave",
      reason: primaryResponse.status,
    });
    responses.push(
      await executeProviderCall(sessionId, braveCall.providerId, plan, request, signal, providerRegistry),
    );
  }
  return responses;
}

export function cancelActiveWebSearch(sessionId: string): boolean {
  activeControllers.get(sessionId)?.abort();
  return cancelWebSearchSession(sessionId);
}

async function executeProviderCall(
  sessionId: string,
  providerId: string,
  plan: WebSearchPlan,
  request: WebSearchRequest,
  signal: AbortSignal,
  providerRegistry: ReadonlyMap<string, WebSearchProvider>,
): Promise<ProviderSearchResponse> {
  const provider = providerRegistry.get(providerId);
  const providerRequest = {
    query: plan.normalizedQuery,
    intent: plan.intent,
    dateRange: request.dateRange,
    language: request.languages?.[0],
    contentTypes: request.contentTypes,
    includeDomains: request.includeDomains,
    excludeDomains: request.excludeDomains,
    sort: request.sort,
    limit: plan.budget.maxResultsPerProvider,
  };
  const cacheKey = createProviderCacheKey(providerId, providerRequest);
  const cached = provider ? getCachedWebSearchProviderResponse(cacheKey) : null;
  if (cached) {
    const response: ProviderSearchResponse = {
      ...cached.response,
      latencyMs: 0,
      requestId: `cache:${cacheKey.slice(0, 16)}`,
      estimatedCredits: 0,
      cache: { hit: true, key: cacheKey, cachedAt: cached.cachedAt },
    };
    upsertWebSearchProviderRun({
      sessionId,
      providerId,
      status: response.status,
      resultCount: response.items.length,
      latencyMs: 0,
      warning: response.warning,
      estimatedCredits: 0,
      requestId: response.requestId,
    });
    appendWebSearchEvent(sessionId, "provider.cache_hit", {
      providerId,
      resultCount: response.items.length,
      cachedAt: cached.cachedAt,
    });
    appendWebSearchEvent(sessionId, "provider.completed", sanitizeProviderResponse(response));
    return response;
  }

  if (!provider || !(await provider.isConfigured())) {
    const response: ProviderSearchResponse = {
      providerId,
      items: [],
      status: "not_configured",
      latencyMs: 0,
      warning: `${providerId} is not configured`,
    };
    upsertWebSearchProviderRun({
      sessionId,
      providerId,
      status: "not_configured",
      warning: response.warning,
    });
    appendWebSearchEvent(sessionId, "provider.failed", sanitizeProviderResponse(response));
    return response;
  }

  upsertWebSearchProviderRun({ sessionId, providerId, status: "running" });
  appendWebSearchEvent(sessionId, "provider.started", { providerId });
  const response = await provider.search(providerRequest, {
    sessionId,
    signal,
    timeoutMs: plan.budget.maxTotalLatencyMs,
  });
  if (response.status === "success" || response.status === "partial") {
    upsertCachedWebSearchProviderResponse({
      cacheKey,
      providerId,
      normalizedQuery: plan.normalizedQuery,
      filters: providerRequest,
      response: { ...response, cache: undefined },
      expiresAt: new Date(Date.now() + PROVIDER_CACHE_TTL_MS).toISOString(),
    });
  }
  upsertWebSearchProviderRun({
    sessionId,
    providerId,
    status: response.status,
    resultCount: response.items.length,
    latencyMs: response.latencyMs,
    warning: response.warning,
    estimatedCredits: response.estimatedCredits,
    requestId: response.requestId,
  });
  appendWebSearchEvent(
    sessionId,
    response.status === "success" ? "provider.completed" : `provider.${response.status}`,
    sanitizeProviderResponse(response),
  );
  return response;
}

function aggregateResults(
  sessionId: string,
  plan: WebSearchPlan,
  request: WebSearchRequest,
  responses: ProviderSearchResponse[],
  expiresAt: string,
): WebSearchResult[] {
  const now = new Date().toISOString();
  const merged: Array<{
    item: ProviderSearchItem;
    evidence: WebSearchResult["providerEvidence"];
    aliases: Set<string>;
  }> = [];
  const aliasIndex = new Map<string, number>();

  for (const response of responses) {
    for (const item of response.items) {
      if (
        request.contentTypes?.length &&
        (item.contentType === "other" || !request.contentTypes.includes(item.contentType))
      ) {
        continue;
      }
      const aliases = entityAliases(item);
      const evidence = {
        providerId: response.providerId,
        providerResultId: item.providerResultId,
        originalUrl: item.url,
        providerRank: item.providerRank,
        providerRawScore: item.providerRawScore,
        retrievedAt: now,
      };
      const existingIndex = [...aliases]
        .map((alias) => aliasIndex.get(alias))
        .find((index): index is number => index !== undefined);
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]!;
        existing.item = mergeProviderItems(existing.item, item);
        existing.evidence.push(evidence);
        for (const alias of aliases) {
          existing.aliases.add(alias);
          aliasIndex.set(alias, existingIndex);
        }
      } else {
        const index = merged.length;
        merged.push({ item, evidence: [evidence], aliases });
        for (const alias of aliases) aliasIndex.set(alias, index);
      }
    }
  }

  const results = attachRepositoryAssociations(
    merged
      .map(({ item, evidence }) => {
        const searchable = `${item.title} ${item.abstract ?? ""} ${item.snippet ?? ""}`.toLowerCase();
        const matchedConcepts = plan.concepts.must.filter((concept) =>
          searchable.includes(concept.toLowerCase()),
        );
        const missingMustConcepts = plan.concepts.must.filter(
          (concept) => !matchedConcepts.includes(concept),
        );
        const matchedShouldConcepts = plan.concepts.should.filter((concept) =>
          searchable.includes(concept.toLowerCase()),
        );
        const excludedConcepts = plan.concepts.exclude.filter((concept) =>
          searchable.includes(concept.toLowerCase()),
        );
        const providerRrfScore =
          evidence.reduce(
            (sum, entry) => sum + providerWeight(entry.providerId) / (60 + entry.providerRank),
            0,
          ) * (evidence.length > 1 ? 1.1 : 1);
        const mustCoverageScore =
          plan.concepts.must.length === 0 ? 1 : matchedConcepts.length / plan.concepts.must.length;
        const shouldCoverageScore =
          plan.concepts.should.length === 0 ? 0 : matchedShouldConcepts.length / plan.concepts.should.length;
        const freshnessScore = scoreFreshness(item.publishedAt);
        const metadataQualityScore = scoreMetadata(item);
        const queryIntentScore = scoreQueryIntent(request.query, item, plan.concepts.must);
        const citationImpactScore = scoreCitationImpact(item);
        const sourceQualityTier = sourceQualityTierFor(item);
        const sourceQualityScore = sourceQualityScoreForTier(sourceQualityTier);
        const conceptCoverageScore = Math.min(1, mustCoverageScore * 0.85 + shouldCoverageScore * 0.15);
        const hardPenalty =
          excludedConcepts.length > 0
            ? -2
            : missingMustConcepts.length === 0
              ? 0.15
              : -Math.min(0.6, missingMustConcepts.length * 0.2);
        const aggregateScore =
          providerRrfScore * 3 +
          conceptCoverageScore * 1.5 +
          shouldCoverageScore * 0.4 +
          queryIntentScore * 3 +
          freshnessScore * 0.75 +
          citationImpactScore * 1.25 +
          sourceQualityScore +
          metadataQualityScore +
          hardPenalty;
        const sortExplanation = [
          `source:${sourceQualityTier}`,
          `must:${matchedConcepts.length}/${Math.max(1, plan.concepts.must.length)}`,
          `should:${matchedShouldConcepts.length}/${Math.max(1, plan.concepts.should.length)}`,
          excludedConcepts.length > 0 ? `excluded:${excludedConcepts.join(", ")}` : undefined,
          missingMustConcepts.length > 0 ? `degraded:${missingMustConcepts.join(", ")}` : undefined,
        ].filter((item): item is string => Boolean(item));
        return {
          id: createResultId(sessionId, item),
          sessionId,
          title: item.title,
          url: item.url,
          canonicalUrl: item.canonicalUrl,
          authors: item.authors,
          publishedAt: item.publishedAt,
          language: item.language,
          contentType: item.contentType,
          abstract: item.abstract,
          snippet: item.snippet,
          metadata: item.metadata,
          identifiers: item.identifiers,
          origin: item.origin,
          providerEvidence: evidence,
          ranking: {
            aggregateScore,
            providerRrfScore,
            conceptCoverageScore,
            freshnessScore,
            sourceQualityScore,
            metadataQualityScore,
            queryIntentScore,
            citationImpactScore,
            shouldCoverageScore,
            sourceQualityTier,
            sortExplanation,
          },
          match: {
            matchedConcepts,
            matchedShouldConcepts,
            matchedFields: matchedConcepts.length > 0 ? ["title_or_abstract"] : [],
            missingMustConcepts,
            excludedConcepts,
          },
          localState: { status: "not_saved" as const },
          createdAt: now,
          expiresAt,
        };
      })
      .filter((result) => {
        if ((result.match.excludedConcepts?.length ?? 0) > 0) return false;
        if (request.concepts?.requireMustMatch === true && result.match.missingMustConcepts.length > 0) {
          return false;
        }
        return true;
      }),
  );
  return sortAggregatedResults(results, request.sort, request.scope);
}

function attachRepositoryAssociations(results: WebSearchResult[]): WebSearchResult[] {
  const papers = results.filter((result) => result.contentType === "paper");
  const repositories = results.filter((result) => result.contentType === "repository");
  if (papers.length === 0 || repositories.length === 0) return results;

  const repositoryLinks = new Map<string, Array<Record<string, unknown>>>();
  const paperLinks = new Map<string, Array<Record<string, unknown>>>();
  for (const paper of papers) {
    for (const repository of repositories) {
      const association = scoreRepositoryPaperAssociation(paper, repository);
      if (association.score < 0.45) continue;
      repositoryLinks.set(paper.id, [
        ...(repositoryLinks.get(paper.id) ?? []),
        {
          resultId: repository.id,
          title: repository.title,
          url: repository.url,
          owner: stringMetadata(repository.metadata, "owner"),
          language: repository.language,
          stars: numberMetadata(repository.metadata, "stars"),
          forks: numberMetadata(repository.metadata, "forks"),
          score: association.score,
          matchedBy: association.matchedBy,
        },
      ]);
      paperLinks.set(repository.id, [
        ...(paperLinks.get(repository.id) ?? []),
        {
          resultId: paper.id,
          title: paper.title,
          url: paper.url,
          doi: paper.identifiers.doi,
          arxivId: paper.identifiers.arxivId,
          score: association.score,
          matchedBy: association.matchedBy,
        },
      ]);
    }
  }

  if (repositoryLinks.size === 0 && paperLinks.size === 0) return results;
  return results.map((result) => {
    const linkedRepositories = repositoryLinks.get(result.id);
    if (linkedRepositories) {
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          linkedRepositories: linkedRepositories.sort(compareAssociationScore),
        },
      };
    }
    const linkedPapers = paperLinks.get(result.id);
    if (linkedPapers) {
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          linkedPapers: linkedPapers.sort(compareAssociationScore),
        },
      };
    }
    return result;
  });
}

function scoreRepositoryPaperAssociation(
  paper: WebSearchResult,
  repository: WebSearchResult,
): { score: number; matchedBy: string[] } {
  const matchedBy = new Set<string>();
  let score = 0;
  const repositoryText = normalizeText(
    [
      repository.title,
      repository.url,
      repository.snippet,
      repository.abstract,
      stringMetadata(repository.metadata, "owner"),
      ...(arrayMetadata(repository.metadata, "topics") ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const rawRepositoryText = [
    repository.title,
    repository.url,
    repository.snippet,
    repository.abstract,
    ...(arrayMetadata(repository.metadata, "topics") ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  if (paper.identifiers.doi) {
    const doi = normalizeDoi(paper.identifiers.doi);
    if (rawRepositoryText.toLowerCase().includes(doi)) {
      score += 1;
      matchedBy.add("doi");
    }
  }
  if (paper.identifiers.arxivId) {
    const arxivId = paper.identifiers.arxivId.toLowerCase();
    if (rawRepositoryText.toLowerCase().includes(arxivId)) {
      score += 1;
      matchedBy.add("arxivId");
    }
  }

  const titleTokens = meaningfulTokens(paper.title);
  const repositoryTokenCoverage = ratioMatched(titleTokens, repositoryText);
  if (titleTokens.length >= 2 && repositoryTokenCoverage >= 0.5) {
    score += repositoryTokenCoverage * 0.55;
    matchedBy.add("title");
  }
  const phrase = normalizeText(paper.title);
  if (phrase.length >= 12 && repositoryText.includes(phrase)) {
    score += 0.35;
    matchedBy.add("title_phrase");
  }
  if (
    /\b(implementation|code|repository|paper)\b/i.test(rawRepositoryText) &&
    repositoryTokenCoverage >= 0.35
  ) {
    score += 0.15;
    matchedBy.add("implementation_context");
  }

  return { score: Math.min(1, score), matchedBy: [...matchedBy] };
}

function compareAssociationScore(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return Number(b.score ?? 0) - Number(a.score ?? 0);
}

function sortAggregatedResults(
  results: WebSearchResult[],
  sort: WebSearchRequest["sort"],
  scope: WebSearchRequest["scope"],
): WebSearchResult[] {
  return [...results].sort((a, b) => {
    if (scope === "mixed") {
      const groupDelta = contentGroupRank(a.contentType) - contentGroupRank(b.contentType);
      if (groupDelta !== 0) return groupDelta;
    }
    if (sort === "recent") {
      const dateDelta = new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime();
      if (dateDelta !== 0) return dateDelta;
    }
    return b.ranking.aggregateScore - a.ranking.aggregateScore;
  });
}

function contentGroupRank(contentType: WebSearchResult["contentType"]): number {
  if (contentType === "paper") return 0;
  if (contentType === "official_blog") return 1;
  if (contentType === "documentation" || contentType === "repository") return 2;
  return 3;
}

function retainedResultResponses(
  session: WebSearchSession,
  retryProviders: ReadonlySet<string>,
): ProviderSearchResponse[] {
  const grouped = new Map<string, ProviderSearchItem[]>();
  for (const result of session.results) {
    const retainedEvidence = result.providerEvidence.filter(
      (evidence) => !retryProviders.has(evidence.providerId),
    );
    for (const evidence of retainedEvidence) {
      const items = grouped.get(evidence.providerId) ?? [];
      items.push(webResultToProviderItem(result, evidence.providerId));
      grouped.set(evidence.providerId, items);
    }
  }
  return [...grouped.entries()].map(([providerId, items]) => ({
    providerId,
    items,
    status: "success",
    latencyMs: 0,
    requestId: "retained:retry",
  }));
}

function webResultToProviderItem(result: WebSearchResult, providerId: string): ProviderSearchItem {
  const evidence = result.providerEvidence.find((entry) => entry.providerId === providerId);
  return {
    providerResultId: evidence?.providerResultId,
    title: result.title,
    url: result.url,
    canonicalUrl: result.canonicalUrl,
    authors: result.authors,
    publishedAt: result.publishedAt,
    language: result.language,
    contentType: result.contentType,
    abstract: result.abstract,
    snippet: result.snippet,
    identifiers: result.identifiers,
    origin: result.origin,
    providerRank: evidence?.providerRank ?? 1,
    providerRawScore: evidence?.providerRawScore,
    metadata: result.metadata,
  };
}

function entityAliases(item: ProviderSearchItem): Set<string> {
  const aliases = new Set<string>();
  if (item.identifiers.doi) aliases.add(`doi:${normalizeDoi(item.identifiers.doi)}`);
  if (item.identifiers.arxivId) aliases.add(`arxiv:${item.identifiers.arxivId.toLowerCase()}`);
  if (item.identifiers.openAlexId) {
    aliases.add(`openalex:${item.identifiers.openAlexId.toLowerCase()}`);
  }
  const normalizedTitle = normalizeText(item.title);
  if (normalizedTitle.length >= 20) {
    aliases.add(`title:${normalizedTitle}:${item.publishedAt?.slice(0, 4) ?? ""}`);
  }
  const canonicalUrl = normalizeEntityUrl(item.canonicalUrl ?? item.url);
  if (canonicalUrl) aliases.add(`url:${canonicalUrl}`);
  if (aliases.size === 0) {
    const firstAuthor = normalizeText(item.authors[0] ?? "");
    const year = item.publishedAt?.slice(0, 4) ?? "";
    if (firstAuthor && year) aliases.add(`weak:${normalizeText(item.title)}:${firstAuthor}:${year}`);
  }
  return aliases;
}

function mergeProviderItems(existing: ProviderSearchItem, incoming: ProviderSearchItem): ProviderSearchItem {
  const openAlex = existing.identifiers.openAlexId
    ? existing
    : incoming.identifiers.openAlexId
      ? incoming
      : undefined;
  const arxiv = existing.identifiers.arxivId ? existing : incoming.identifiers.arxivId ? incoming : undefined;
  const preferred = openAlex ?? (scoreMetadata(existing) >= scoreMetadata(incoming) ? existing : incoming);
  const doi = existing.identifiers.doi ?? incoming.identifiers.doi;
  const canonicalUrl = doi
    ? `https://doi.org/${normalizeDoi(doi)}`
    : (arxiv?.canonicalUrl ?? preferred.canonicalUrl ?? preferred.url);
  return {
    ...preferred,
    title: existing.title.length >= incoming.title.length ? existing.title : incoming.title,
    url: canonicalUrl,
    canonicalUrl,
    authors: incoming.authors.length > existing.authors.length ? incoming.authors : existing.authors,
    publishedAt: openAlex?.publishedAt ?? existing.publishedAt ?? incoming.publishedAt,
    abstract: longer(existing.abstract, incoming.abstract),
    snippet: longer(existing.snippet, incoming.snippet),
    identifiers: { ...existing.identifiers, ...incoming.identifiers },
    origin: openAlex?.origin ?? preferred.origin,
    providerRank: Math.min(existing.providerRank, incoming.providerRank),
    metadata: {
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
      ...(arxiv?.metadata ?? {}),
      ...(openAlex?.metadata ?? {}),
    },
  };
}

function providerWeight(providerId: string): number {
  if (providerId === "openalex") return 1.15;
  if (providerId === "crossref") return 1.1;
  if (providerId === "tavily") return 1.05;
  if (providerId === "github") return 1.05;
  return 1;
}

function normalizeDoi(value: string): string {
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

function normalizeEntityUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function longer(a: string | undefined, b: string | undefined): string | undefined {
  return (a?.length ?? 0) >= (b?.length ?? 0) ? a : b;
}

function scoreFreshness(publishedAt: string | undefined): number {
  if (!publishedAt) return 0;
  const ageDays = Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / 86_400_000);
  return Number.isFinite(ageDays) ? Math.exp(-ageDays / 365) : 0;
}

function scoreMetadata(item: ProviderSearchItem): number {
  const fields = [
    item.title,
    item.abstract,
    item.publishedAt,
    item.authors.length > 0 ? "authors" : "",
    item.identifiers.arxivId ?? item.identifiers.doi,
  ];
  return fields.filter(Boolean).length / fields.length;
}

function sourceQualityTierFor(item: ProviderSearchItem): "official" | "trusted" | "standard" | "low" {
  const domain = item.origin.domain.toLowerCase();
  if (
    domain === "arxiv.org" ||
    domain === "openai.com" ||
    domain.endsWith(".openai.com") ||
    domain === "anthropic.com" ||
    domain.endsWith(".anthropic.com") ||
    domain.endsWith(".edu")
  ) {
    return "official";
  }
  if (
    domain === "github.com" ||
    domain === "docs.github.com" ||
    item.identifiers.doi ||
    item.identifiers.openAlexId
  ) {
    return "trusted";
  }
  if (domain.includes("blog") || domain.includes("docs") || domain.includes("developer")) return "standard";
  return "low";
}

function sourceQualityScoreForTier(tier: "official" | "trusted" | "standard" | "low"): number {
  switch (tier) {
    case "official":
      return 1;
    case "trusted":
      return 0.9;
    case "standard":
      return 0.7;
    case "low":
      return 0.45;
  }
}

function scoreQueryIntent(query: string, item: ProviderSearchItem, concepts: string[]): number {
  const title = normalizeText(item.title);
  const body = normalizeText(`${item.abstract ?? ""} ${item.snippet ?? ""}`);
  const normalizedConcepts = concepts.map(normalizeText).filter(Boolean);
  const titleCoverage = ratioMatched(normalizedConcepts, title);
  const bodyCoverage = ratioMatched(normalizedConcepts, body);
  const phrases = extractQueryPhrases(query);
  const phraseCoverage =
    phrases.length === 0
      ? 0
      : phrases.filter((phrase) => title.includes(phrase) || body.includes(phrase)).length / phrases.length;
  const directional = query.match(/(.+?)\s+for\s+(.+)/i);
  let directionScore = 0;
  let directionPenalty = 0;
  if (directional?.[1] && directional[2]) {
    const left = normalizeText(directional[1]);
    const right = normalizeText(directional[2]);
    const combined = `${title} ${body}`;
    if (combined.includes(`${left} for ${right}`)) directionScore = 1;
    if (title.includes(`${right} generated ${left}`) || title.includes(`${right} based ${left}`)) {
      directionPenalty = 0.25;
    }
  }
  return Math.max(
    0,
    titleCoverage * 0.5 + bodyCoverage * 0.2 + phraseCoverage * 0.2 + directionScore * 0.1 - directionPenalty,
  );
}

function extractQueryPhrases(query: string): string[] {
  const normalized = normalizeText(query);
  const phrases = [
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
  return phrases.filter((phrase) => normalized.includes(phrase));
}

function ratioMatched(concepts: string[], text: string): number {
  if (concepts.length === 0) return 1;
  return concepts.filter((concept) => text.includes(concept)).length / concepts.length;
}

function meaningfulTokens(value: string): string[] {
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "paper", "the", "to", "with"]);
  return [
    ...new Set(
      normalizeText(value)
        .split(/\s+/)
        .filter((token) => token.length > 2 && !stopWords.has(token)),
    ),
  ];
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayMetadata(metadata: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function scoreCitationImpact(item: ProviderSearchItem): number {
  const citedByCount = Number(item.metadata?.citedByCount);
  if (!Number.isFinite(citedByCount) || citedByCount <= 0) return 0;
  return Math.min(1, Math.log10(citedByCount + 1) / 3);
}

function createResultId(sessionId: string, item: ProviderSearchItem): string {
  return `wr_${createHash("sha256")
    .update(
      `${sessionId}:${item.identifiers.doi ?? item.identifiers.arxivId ?? item.canonicalUrl ?? item.url}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function createProviderCacheKey(providerId: string, request: ProviderSearchRequest): string {
  return createHash("sha256")
    .update(
      stableStringify({
        providerId,
        providerOptionsVersion: PROVIDER_CACHE_OPTIONS_VERSION,
        normalizedQuery: request.query,
        intent: request.intent,
        dateRange: request.dateRange ?? null,
        language: request.language ?? null,
        contentTypes: [...(request.contentTypes ?? [])].sort(),
        includeDomains: [...(request.includeDomains ?? [])].sort(),
        excludeDomains: [...(request.excludeDomains ?? [])].sort(),
        sort: request.sort ?? "relevance",
        limit: request.limit,
      }),
    )
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeProviderResponse(response: ProviderSearchResponse): Record<string, unknown> {
  return {
    providerId: response.providerId,
    status: response.status,
    resultCount: response.items.length,
    latencyMs: response.latencyMs,
    warning: response.warning,
    cacheHit: response.cache?.hit === true,
  };
}

function failSession(sessionId: string, message: string): WebSearchSession {
  updateWebSearchSession({ id: sessionId, status: "failed", error: message });
  appendWebSearchEvent(sessionId, "session.failed", { status: "failed", error: message });
  return getWebSearchSession(sessionId)!;
}
