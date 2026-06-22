export type WebSearchScope = "academic" | "technical" | "mixed";
export type WebSearchContentType =
  | "paper"
  | "official_blog"
  | "technical_article"
  | "documentation"
  | "repository";
export type WebSearchBudgetPreset = "low_cost" | "balanced" | "broad";
export type WebSearchIntent =
  | "topic_discovery"
  | "exact_identifier"
  | "paper_lookup"
  | "author_lookup"
  | "recent_updates"
  | "code_lookup"
  | "general_research";
export type WebSearchSessionStatus =
  | "created"
  | "planning"
  | "searching"
  | "aggregating"
  | "summarizing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";
export type ProviderRunStatus =
  | "queued"
  | "running"
  | "success"
  | "partial"
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "failed"
  | "cancelled";
export type WebSearchConnectionProvider = "openalex" | "tavily" | "brave" | "mcp";
export type WebSaveMode = "metadata_only" | "save_content" | "download_pdf";

export interface WebSearchRequest {
  query: string;
  scope: WebSearchScope;
  concepts?: {
    must?: string[];
    should?: string[];
    exclude?: string[];
    requireMustMatch?: boolean;
  };
  contentTypes?: WebSearchContentType[];
  dateRange?: { start?: string; end?: string };
  languages?: string[];
  providers?: string[];
  includeDomains?: string[];
  excludeDomains?: string[];
  sort?: "relevance" | "recent";
  maxResults?: number;
  searchBudget?: WebSearchBudgetPreset;
  autoSummarize?: boolean;
  allowQueryRewrite?: boolean;
}

export interface ProviderSearchCall {
  providerId: string;
  query: string;
  reason: string;
}

export interface WebSearchPlan {
  originalQuery: string;
  normalizedQuery: string;
  intent: WebSearchIntent;
  scope: WebSearchScope;
  concepts: { must: string[]; should: string[]; exclude: string[] };
  providerCalls: ProviderSearchCall[];
  budget: {
    maxProviderCalls: number;
    maxResultsPerProvider: number;
    maxTotalResults: number;
    maxTotalLatencyMs: number;
    maxEstimatedCredits?: number;
  };
  rewrite?: { applied: boolean; rewrittenQuery?: string; reason?: string };
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable";
  message?: string;
  checkedAt: string;
}

export type WebSearchConnectionDiagnosticStage =
  | "configuration"
  | "network"
  | "authentication"
  | "schema"
  | "tool"
  | "security"
  | "unknown";

export interface WebSearchConnectionTestDiagnostic {
  stage: WebSearchConnectionDiagnosticStage;
  code: string;
  retryable: boolean;
  message: string;
  provider?: WebSearchConnectionProvider;
  transport?: WebSearchConnection["settings"]["mcpTransport"];
}

export interface ProviderSearchRequest {
  query: string;
  intent: WebSearchIntent;
  dateRange?: { start?: string; end?: string };
  language?: string;
  contentTypes?: WebSearchContentType[];
  includeDomains?: string[];
  excludeDomains?: string[];
  sort?: "relevance" | "recent";
  limit: number;
  cursor?: string;
}

export interface ProviderSearchContext {
  sessionId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ProviderSearchItem {
  providerResultId?: string;
  title: string;
  url: string;
  canonicalUrl?: string;
  authors: string[];
  publishedAt?: string;
  language?: string;
  contentType: WebSearchContentType | "other";
  abstract?: string;
  snippet?: string;
  identifiers: {
    doi?: string;
    arxivId?: string;
    openAlexId?: string;
    pmid?: string;
  };
  origin: {
    domain: string;
    publisher?: string;
    venue?: string;
    sourceName?: string;
  };
  providerRank: number;
  providerRawScore?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderSearchResponse {
  providerId: string;
  items: ProviderSearchItem[];
  nextCursor?: string;
  status: "success" | "partial" | "not_configured" | "rate_limited" | "timeout" | "failed";
  latencyMs: number;
  requestId?: string;
  estimatedCredits?: number;
  warning?: string;
  cache?: {
    hit: boolean;
    key: string;
    cachedAt?: string;
  };
}

export interface WebSearchProvider {
  id: string;
  displayName: string;
  kind: "academic" | "web" | "mcp";
  capabilities: {
    supportsDateRange: boolean;
    supportsLanguage: boolean;
    supportsDomainFilter: boolean;
    supportsExactLookup: boolean;
    supportsSemanticSearch: boolean;
    supportsPagination: boolean;
  };
  isConfigured(): Promise<boolean>;
  healthCheck(): Promise<ProviderHealth>;
  search(request: ProviderSearchRequest, context: ProviderSearchContext): Promise<ProviderSearchResponse>;
}

export interface ProviderEvidence {
  providerId: string;
  providerResultId?: string;
  originalUrl: string;
  providerRank: number;
  providerRawScore?: number;
  retrievedAt: string;
}

export interface WebSearchResult {
  id: string;
  sessionId: string;
  title: string;
  url: string;
  canonicalUrl?: string;
  authors: string[];
  publishedAt?: string;
  language?: string;
  contentType: WebSearchContentType | "other";
  abstract?: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
  identifiers: ProviderSearchItem["identifiers"];
  origin: ProviderSearchItem["origin"];
  providerEvidence: ProviderEvidence[];
  ranking: {
    aggregateScore: number;
    providerRrfScore: number;
    conceptCoverageScore: number;
    freshnessScore: number;
    sourceQualityScore: number;
    metadataQualityScore: number;
    queryIntentScore?: number;
    citationImpactScore?: number;
    shouldCoverageScore?: number;
    sourceQualityTier?: "official" | "trusted" | "standard" | "low";
    sortExplanation?: string[];
  };
  match: {
    matchedConcepts: string[];
    matchedShouldConcepts?: string[];
    matchedFields: string[];
    missingMustConcepts: string[];
    excludedConcepts?: string[];
  };
  localState: {
    status: "not_saved" | "saving" | "saved" | "save_failed";
    documentId?: string;
    isFavorite?: boolean;
    hasDownloadedFile?: boolean;
  };
  createdAt: string;
  expiresAt: string;
}

export interface WebSaveRequest {
  mode: WebSaveMode;
  favorite?: boolean;
  generateSummary?: boolean;
}

export interface WebSaveResponse {
  sessionId: string;
  resultId: string;
  documentId: string;
  status: "inserted" | "duplicate" | "updated";
  mode: WebSaveMode;
  favorite: boolean;
  hasDownloadedFile: boolean;
  summaryQueued: boolean;
}

export interface WebSearchProviderRun {
  providerId: string;
  status: ProviderRunStatus;
  resultCount: number;
  latencyMs?: number;
  estimatedCredits?: number;
  requestId?: string;
  warning?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WebSearchConnection {
  id: string;
  provider: WebSearchConnectionProvider;
  name: string;
  enabled: boolean;
  isPrimary: boolean;
  settings: {
    baseUrl?: string;
    mcpTransport?: "stdio" | "streamable_http";
    mcpToolName?: string;
    mcpCommand?: string;
    mcpArgs?: string[];
    mcpEndpoint?: string;
    mcpInputAdapter?: McpSearchInputAdapter;
    mcpOutputAdapter?: McpSearchOutputAdapter;
  };
  hasApiKey: boolean;
  lastTestStatus?: "success" | "failed";
  lastTestMessage?: string;
  lastTestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpSearchInputAdapter {
  query?: string;
  limit?: string;
  intent?: string;
  startDate?: string;
  endDate?: string;
  language?: string;
  includeDomains?: string;
  excludeDomains?: string;
}

export interface McpSearchOutputAdapter {
  itemsPath?: string;
  fields?: Partial<
    Record<
      | "id"
      | "title"
      | "url"
      | "canonicalUrl"
      | "authors"
      | "publishedAt"
      | "language"
      | "contentType"
      | "abstract"
      | "snippet"
      | "doi"
      | "arxivId"
      | "openAlexId"
      | "pmid"
      | "publisher"
      | "venue"
      | "sourceName"
      | "score",
      string
    >
  >;
}

export interface WebSearchConnectionConfig extends WebSearchConnection {
  apiKey?: string;
}

export interface WebSearchSession {
  id: string;
  request: WebSearchRequest;
  plan?: WebSearchPlan;
  status: WebSearchSessionStatus;
  providerRuns: WebSearchProviderRun[];
  results: WebSearchResult[];
  summary?: WebSearchSummary;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type EvidenceType =
  | "abstract"
  | "provider_snippet"
  | "page_excerpt"
  | "metadata";

export interface EvidenceChunk {
  id: string;
  resultId: string;
  title: string;
  url: string;
  text: string;
  providerId: string;
  evidenceType: EvidenceType;
  fetchedAt: string;
  contentHash: string;
}

export interface WebSearchCitation {
  number: number;
  resultId: string;
  title: string;
  url: string;
}

export interface WebSearchSynthesis {
  reportTitle?: string;
  researchQuestion?: string;
  overview: string;
  keyFindings: Array<{
    claim: string;
    citations: string[];
  }>;
  resultGroups: Array<{
    title: string;
    resultIds: string[];
    summary: string;
  }>;
  methodSections?: Array<{
    title: string;
    summary: string;
    designLogic?: string;
    methodology?: string;
    whyEffective?: string;
    implementation?: string;
    boundaries?: string;
    resultIds: string[];
  }>;
  comparison?: string;
  recommendations?: string[];
  conclusion?: string;
  limitations: string[];
}

export interface WebSearchSummary {
  id: string;
  sessionId: string;
  resultId?: string;
  kind: "synthesis" | "result";
  status: "completed" | "failed";
  synthesis?: WebSearchSynthesis;
  citations: WebSearchCitation[];
  evidenceCount: number;
  latencyMs?: number;
  estimatedTokens?: number;
  citedClaims?: number;
  uncitedClaims?: number;
  evidenceInsufficient?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface WebSearchEvent {
  eventId: number;
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}
