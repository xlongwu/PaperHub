import { createHash, randomUUID } from "node:crypto";
import {
  appendWebSearchEvent,
  cancelWebSearchSession,
  createWebSearchSessionRecord,
  getWebSearchSession,
  insertWebSearchResults,
  updateWebSearchSession,
  upsertWebSearchProviderRun,
} from "@/db/web-search";
import { recordWebSearchUsageEvent } from "@/db/web-search-metrics";
import { createWebSearchPlan } from "@/web-search/query-planner";
import { arxivWebSearchProvider } from "@/web-search/providers/arxiv";
import { openAlexWebSearchProvider } from "@/web-search/providers/openalex";
import { braveWebSearchProvider } from "@/web-search/providers/brave";
import { tavilyWebSearchProvider } from "@/web-search/providers/tavily";
import { mcpWebSearchProvider } from "@/web-search/providers/mcp";
import { generateWebSearchSynthesis } from "./web-search-summary";
import type {
  ProviderSearchItem,
  ProviderSearchResponse,
  WebSearchPlan,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSession,
} from "@/web-search/types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const activeControllers = new Map<string, AbortController>();
const providers = new Map<string, WebSearchProvider>([
  [arxivWebSearchProvider.id, arxivWebSearchProvider],
  [openAlexWebSearchProvider.id, openAlexWebSearchProvider],
  [tavilyWebSearchProvider.id, tavilyWebSearchProvider],
  [braveWebSearchProvider.id, braveWebSearchProvider],
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
    const results = aggregateResults(
      sessionId,
      plan,
      session.request,
      usable,
      latestSession.expiresAt,
    ).slice(
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

    const partial = responses.some(
      (response) => !["success", "not_configured"].includes(response.status),
    );
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
      call.providerId !== "mcp",
  );
  const webCalls = plan.providerCalls.filter(
    (call) =>
      call.providerId === "tavily" ||
      call.providerId === "brave" ||
      call.providerId === "mcp",
  );
  const responses = await Promise.all(
    academicCalls.map((call) =>
      executeProviderCall(
        sessionId,
        call.providerId,
        plan,
        request,
        signal,
        providerRegistry,
      ),
    ),
  );
  if (webCalls.length === 0) return responses;

  if (request.searchBudget === "broad") {
    responses.push(
      ...(await Promise.all(
        webCalls.map((call) =>
          executeProviderCall(
            sessionId,
            call.providerId,
            plan,
            request,
            signal,
            providerRegistry,
          ),
        ),
      )),
    );
    return responses;
  }

  const tavilyCall = webCalls.find((call) => call.providerId === "tavily");
  const braveCall = webCalls.find((call) => call.providerId === "brave");
  const mcpCall = webCalls.find((call) => call.providerId === "mcp");
  if (mcpCall) {
    responses.push(
      await executeProviderCall(
        sessionId,
        mcpCall.providerId,
        plan,
        request,
        signal,
        providerRegistry,
      ),
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
      await executeProviderCall(
        sessionId,
        braveCall.providerId,
        plan,
        request,
        signal,
        providerRegistry,
      ),
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
  const response = await provider.search(
    {
      query: plan.normalizedQuery,
      intent: plan.intent,
      dateRange: request.dateRange,
      language: request.languages?.[0],
      includeDomains: request.includeDomains,
      excludeDomains: request.excludeDomains,
      limit: plan.budget.maxResultsPerProvider,
    },
    { sessionId, signal, timeoutMs: plan.budget.maxTotalLatencyMs },
  );
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

  return merged
    .map(({ item, evidence }) => {
      const searchable = `${item.title} ${item.abstract ?? ""} ${item.snippet ?? ""}`.toLowerCase();
      const matchedConcepts = plan.concepts.must.filter((concept) =>
        searchable.includes(concept.toLowerCase()),
      );
      const missingMustConcepts = plan.concepts.must.filter((concept) => !matchedConcepts.includes(concept));
      const providerRrfScore =
        evidence.reduce(
          (sum, entry) => sum + providerWeight(entry.providerId) / (60 + entry.providerRank),
          0,
        ) * (evidence.length > 1 ? 1.1 : 1);
      const conceptCoverageScore =
        plan.concepts.must.length === 0 ? 1 : matchedConcepts.length / plan.concepts.must.length;
      const freshnessScore = scoreFreshness(item.publishedAt);
      const metadataQualityScore = scoreMetadata(item);
      const queryIntentScore = scoreQueryIntent(request.query, item, plan.concepts.must);
      const citationImpactScore = scoreCitationImpact(item);
      const sourceQualityScore =
        item.origin.domain === "arxiv.org" || item.identifiers.doi || item.identifiers.openAlexId ? 1 : 0.5;
      const aggregateScore =
        providerRrfScore * 3 +
        conceptCoverageScore * 1.5 +
        queryIntentScore * 3 +
        freshnessScore * 0.75 +
        citationImpactScore * 1.25 +
        sourceQualityScore +
        metadataQualityScore;
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
        },
        match: {
          matchedConcepts,
          matchedFields: matchedConcepts.length > 0 ? ["title_or_abstract"] : [],
          missingMustConcepts,
        },
        localState: { status: "not_saved" as const },
        createdAt: now,
        expiresAt,
      };
    })
    .sort((a, b) => b.ranking.aggregateScore - a.ranking.aggregateScore);
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
      ...(arxiv?.metadata ?? {}),
      ...(openAlex?.metadata ?? {}),
    },
  };
}

function providerWeight(providerId: string): number {
  if (providerId === "openalex") return 1.15;
  if (providerId === "tavily") return 1.05;
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

function scoreQueryIntent(
  query: string,
  item: ProviderSearchItem,
  concepts: string[],
): number {
  const title = normalizeText(item.title);
  const body = normalizeText(`${item.abstract ?? ""} ${item.snippet ?? ""}`);
  const normalizedConcepts = concepts.map(normalizeText).filter(Boolean);
  const titleCoverage = ratioMatched(normalizedConcepts, title);
  const bodyCoverage = ratioMatched(normalizedConcepts, body);
  const phrases = extractQueryPhrases(query);
  const phraseCoverage =
    phrases.length === 0
      ? 0
      : phrases.filter((phrase) => title.includes(phrase) || body.includes(phrase)).length /
        phrases.length;
  const directional = query.match(/(.+?)\s+for\s+(.+)/i);
  let directionScore = 0;
  let directionPenalty = 0;
  if (directional?.[1] && directional[2]) {
    const left = normalizeText(directional[1]);
    const right = normalizeText(directional[2]);
    const combined = `${title} ${body}`;
    if (combined.includes(`${left} for ${right}`)) directionScore = 1;
    if (
      title.includes(`${right} generated ${left}`) ||
      title.includes(`${right} based ${left}`)
    ) {
      directionPenalty = 0.25;
    }
  }
  return Math.max(
    0,
    titleCoverage * 0.5 +
      bodyCoverage * 0.2 +
      phraseCoverage * 0.2 +
      directionScore * 0.1 -
      directionPenalty,
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

function sanitizeProviderResponse(response: ProviderSearchResponse): Record<string, unknown> {
  return {
    providerId: response.providerId,
    status: response.status,
    resultCount: response.items.length,
    latencyMs: response.latencyMs,
    warning: response.warning,
  };
}

function failSession(sessionId: string, message: string): WebSearchSession {
  updateWebSearchSession({ id: sessionId, status: "failed", error: message });
  appendWebSearchEvent(sessionId, "session.failed", { status: "failed", error: message });
  return getWebSearchSession(sessionId)!;
}
