import { Router, type Response } from "express";
import {
  appendWebSearchEvent,
  cleanupExpiredWebSearchData,
  recoverInterruptedWebSearchState,
  getWebSearchSession,
  listWebSearchEvents,
} from "@/db/web-search";
import { recordWebSearchUsageEvent } from "@/db/web-search-metrics";
import {
  activateWebSearchConnection,
  deleteWebSearchConnection,
  getWebSearchConnection,
  listWebSearchConnections,
  saveWebSearchConnection,
  updateWebSearchConnectionTest,
  type WebSearchConnectionWrite,
} from "@/db/web-search-connections";
import {
  cancelActiveWebSearch,
  createWebSearchSession,
  executeWebSearchSession,
  retryWebSearchProviders,
} from "@/services/web-search-service";
import type {
  McpSearchOutputAdapter,
  WebSearchContentType,
  WebSearchConnectionProvider,
  WebSearchConnectionTestDiagnostic,
  WebSearchRequest,
  WebSearchScope,
} from "@/web-search/types";
import { OpenAlexWebSearchProvider } from "@/web-search/providers/openalex";
import { BraveWebSearchProvider } from "@/web-search/providers/brave";
import { TavilyWebSearchProvider } from "@/web-search/providers/tavily";
import { discoverConfiguredMcpTool } from "@/web-search/providers/mcp";
import { generateWebResultSummary, generateWebSearchSynthesis } from "@/services/web-search-summary";
import { cleanupTemporaryPdfFiles, saveWebSearchResult, WebSaveError } from "@/services/web-save-service";
import type { WebSaveMode } from "@/web-search/types";
import { createRateLimiter } from "@/api/security";
import { getWebSearchHealth, getWebSearchMetricsForRange } from "@/services/web-search-observability";
import { redactSensitiveText } from "@/security/redaction";

export const webSearchRouter = Router();

const VALID_SCOPES = new Set<WebSearchScope>(["academic", "technical", "mixed"]);
const VALID_CONTENT_TYPES = new Set<WebSearchContentType>([
  "paper",
  "official_blog",
  "technical_article",
  "documentation",
  "repository",
]);
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled", "expired"]);
const saveLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

webSearchRouter.get("/providers/catalog", (_req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: "openalex",
        displayName: "OpenAlex",
        kind: "academic",
        requiresApiKey: true,
        defaultBaseUrl: "https://api.openalex.org",
        capabilities: {
          supportsDateRange: true,
          supportsExactLookup: true,
          supportsPagination: true,
        },
      },
      {
        id: "crossref",
        displayName: "Crossref",
        kind: "academic",
        requiresApiKey: false,
        defaultBaseUrl: "https://api.crossref.org",
        capabilities: {
          supportsDateRange: true,
          supportsExactLookup: true,
          supportsPagination: true,
        },
      },
      {
        id: "tavily",
        displayName: "Tavily",
        kind: "web",
        requiresApiKey: true,
        defaultBaseUrl: "https://api.tavily.com",
        capabilities: {
          supportsDateRange: true,
          supportsDomainFilter: true,
          supportsSemanticSearch: true,
        },
      },
      {
        id: "brave",
        displayName: "Brave Search",
        kind: "web",
        requiresApiKey: true,
        defaultBaseUrl: "https://api.search.brave.com/res/v1",
        capabilities: {
          supportsDateRange: true,
          supportsLanguage: true,
          supportsDomainFilter: true,
          supportsPagination: true,
        },
      },
      {
        id: "github",
        displayName: "GitHub Repositories",
        kind: "web",
        requiresApiKey: false,
        defaultBaseUrl: "https://api.github.com",
        capabilities: {
          supportsDateRange: true,
          supportsLanguage: true,
          supportsPagination: true,
        },
      },
      {
        id: "mcp",
        displayName: "Search MCP",
        kind: "mcp",
        requiresApiKey: false,
        capabilities: {
          supportsDateRange: true,
          supportsLanguage: true,
          supportsDomainFilter: true,
          supportsExactLookup: true,
        },
      },
    ],
  });
});

webSearchRouter.get("/connections", (_req, res) => {
  res.json({ success: true, data: listWebSearchConnections() });
});

webSearchRouter.get("/metrics", (req, res) => {
  try {
    res.json({
      success: true,
      data: getWebSearchMetricsForRange(
        typeof req.query.from === "string" ? req.query.from : undefined,
        typeof req.query.to === "string" ? req.query.to : undefined,
      ),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid metrics range.",
    });
  }
});

webSearchRouter.get("/health", (_req, res) => {
  res.json({ success: true, data: getWebSearchHealth() });
});

webSearchRouter.post("/connections", async (req, res) => {
  try {
    const input = parseConnectionInput(req.body);
    if (input.provider === "mcp") {
      await discoverConfiguredMcpTool(toDiscoveryConnection(input));
    }
    res.status(201).json({
      success: true,
      data: saveWebSearchConnection(input),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid Web Search connection.",
    });
  }
});

webSearchRouter.put("/connections/:id", async (req, res) => {
  try {
    const input = parseConnectionInput(req.body, req.params.id);
    if (input.provider === "mcp") {
      await discoverConfiguredMcpTool(toDiscoveryConnection(input));
    }
    res.json({
      success: true,
      data: saveWebSearchConnection(input),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid Web Search connection.",
    });
  }
});

webSearchRouter.delete("/connections/:id", (req, res) => {
  const deleted = deleteWebSearchConnection(req.params.id);
  res.status(deleted ? 200 : 404).json({
    success: deleted,
    data: deleted ? { deleted: true } : undefined,
    error: deleted ? undefined : "Web Search connection not found.",
  });
});

webSearchRouter.post("/connections/:id/activate", (req, res) => {
  try {
    res.json({ success: true, data: activateWebSearchConnection(req.params.id) });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : "Web Search connection not found.",
    });
  }
});

webSearchRouter.post("/connections/:id/test", async (req, res) => {
  const connection = getWebSearchConnection(req.params.id);
  if (!connection) {
    res.status(404).json({ success: false, error: "Web Search connection not found." });
    return;
  }
  if (connection.provider === "mcp") {
    try {
      const discovery = await discoverConfiguredMcpTool(connection);
      const message = `Discovered ${discovery.tools.length} MCP tool(s).`;
      const diagnostic = {
        stage: "tool",
        code: "MCP_DISCOVERY_OK",
        retryable: true,
        message,
        provider: connection.provider,
        transport: connection.settings.mcpTransport,
      } satisfies WebSearchConnectionTestDiagnostic;
      updateWebSearchConnectionTest(connection.id, "success", message);
      res.json({
        success: true,
        data: {
          status: "healthy",
          checkedAt: new Date().toISOString(),
          message,
          diagnostic,
          discoveredTools: discovery.tools,
          selectedTool: discovery.tool,
        },
      });
    } catch (error) {
      const diagnostic = buildConnectionDiagnostic(error, connection);
      const message = redactConnectionMessage(diagnostic.message, connection.apiKey);
      updateWebSearchConnectionTest(connection.id, "failed", message);
      res.status(503).json({
        success: false,
        error: message,
        details: { diagnostic },
      });
    }
    return;
  }
  const provider =
    connection.provider === "openalex"
      ? new OpenAlexWebSearchProvider(fetch, () => connection)
      : connection.provider === "tavily"
        ? new TavilyWebSearchProvider(fetch, () => connection)
        : connection.provider === "brave"
          ? new BraveWebSearchProvider(fetch, () => connection)
          : null;
  if (!provider) {
    res.status(400).json({ success: false, error: "Provider test is not implemented." });
    return;
  }
  try {
    const health = await provider.healthCheck();
    const status = health.status === "healthy" ? "success" : "failed";
    const diagnostic: WebSearchConnectionTestDiagnostic = {
      stage: health.status === "healthy" ? "unknown" : "network",
      code: `PROVIDER_${health.status.toUpperCase()}`,
      retryable: health.status !== "unavailable",
      message: health.message ?? health.status,
      provider: connection.provider,
    };
    const message = redactConnectionMessage(diagnostic.message, connection.apiKey);
    updateWebSearchConnectionTest(connection.id, status, message);
    res.status(status === "success" ? 200 : 503).json({
      success: status === "success",
      data: { ...health, message, diagnostic },
      error: status === "success" ? undefined : message,
      details: status === "success" ? undefined : { diagnostic },
    });
  } catch (error) {
    const diagnostic = buildConnectionDiagnostic(error, connection);
    const message = redactConnectionMessage(diagnostic.message, connection.apiKey);
    updateWebSearchConnectionTest(connection.id, "failed", message);
    res.status(503).json({
      success: false,
      error: message,
      details: { diagnostic },
    });
  }
});

webSearchRouter.post("/", (req, res) => {
  try {
    const request = parseWebSearchRequest(req.body);
    const session = createWebSearchSession(request);
    queueMicrotask(() => void executeWebSearchSession(session.id));
    res.status(202).json({
      success: true,
      data: {
        sessionId: session.id,
        status: session.status,
        eventsUrl: `/api/web-search/${session.id}/events`,
        expiresAt: session.expiresAt,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid Web Search request.",
      errorCode: "INVALID_WEB_SEARCH_REQUEST",
    });
  }
});

webSearchRouter.post("/:sessionId/summarize", async (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }
  const summary = await generateWebSearchSynthesis(session.id);
  res.json({ success: true, data: summary });
});

webSearchRouter.post("/:sessionId/results/:resultId/summarize", async (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }
  if (!session.results.some((result) => result.id === req.params.resultId)) {
    res.status(404).json({ success: false, error: "Web Search result not found." });
    return;
  }
  const summary = await generateWebResultSummary(session.id, req.params.resultId);
  res.json({ success: true, data: summary });
});

webSearchRouter.post("/:sessionId/results/:resultId/open", (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session || !session.results.some((result) => result.id === req.params.resultId)) {
    res.status(404).json({ success: false, error: "Web Search result not found." });
    return;
  }
  recordWebSearchUsageEvent({
    sessionId: session.id,
    eventType: "result_open",
  });
  res.json({ success: true, data: { recorded: true } });
});

webSearchRouter.post("/:sessionId/results/:resultId/save", saveLimiter, async (req, res) => {
  try {
    const input = parseWebSaveRequest(req.body);
    const saved = await saveWebSearchResult(String(req.params.sessionId), String(req.params.resultId), input);
    res.status(saved.status === "inserted" ? 201 : 200).json({
      success: true,
      data: saved,
    });
  } catch (error) {
    const status =
      error instanceof WebSaveError && (error.stage === "session" || error.stage === "result") ? 404 : 422;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : "Web result save failed.",
      errorCode: "WEB_RESULT_SAVE_FAILED",
      details: error instanceof WebSaveError ? { stage: error.stage } : undefined,
    });
  }
});

webSearchRouter.get("/:sessionId", (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }
  res.json({ success: true, data: session });
});

webSearchRouter.get("/:sessionId/events", (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastEventId = parseEventId(req.headers["last-event-id"] ?? req.query.after);
  const sendPending = () => {
    for (const event of listWebSearchEvents(session.id, lastEventId)) {
      writeSse(res, event.eventId, event.type, event.data);
      lastEventId = event.eventId;
    }
    const latest = getWebSearchSession(session.id);
    return Boolean(latest && TERMINAL_STATUSES.has(latest.status));
  };
  if (sendPending()) {
    res.end();
    return;
  }

  const poll = setInterval(() => {
    if (sendPending()) {
      clearInterval(poll);
      clearInterval(heartbeat);
      res.end();
    }
  }, 500);
  const heartbeat = setInterval(() => {
    const event = appendHeartbeat(session.id);
    writeSse(res, event.eventId, event.type, event.data);
    lastEventId = event.eventId;
  }, 20_000);
  req.on("close", () => {
    clearInterval(poll);
    clearInterval(heartbeat);
  });
});

webSearchRouter.post("/:sessionId/cancel", (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }
  const cancelled = cancelActiveWebSearch(session.id);
  res.status(cancelled ? 200 : 409).json({
    success: cancelled,
    data: getWebSearchSession(session.id),
    error: cancelled ? undefined : "Web Search session is already terminal.",
  });
});

webSearchRouter.post("/:sessionId/retry", (req, res) => {
  const session = getWebSearchSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: "Web Search session not found." });
    return;
  }
  if (session.status !== "failed" && session.status !== "partial") {
    res.status(409).json({ success: false, error: "Only failed or partial sessions can be retried." });
    return;
  }
  try {
    const providerIds = parseRetryProviderIds(req.body);
    queueMicrotask(() => void retryWebSearchProviders(session.id, providerIds));
    res.status(202).json({
      success: true,
      data: { sessionId: session.id, status: "searching", providerIds },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid retry request.",
    });
  }
});

export function startWebSearchCleanup(): () => void {
  try {
    const recovery = recoverInterruptedWebSearchState();
    if (recovery.sessions || recovery.savingResults) {
      console.warn("[web-search] Recovered interrupted state:", recovery);
    }
    cleanupExpiredWebSearchData();
    cleanupTemporaryPdfFiles();
  } catch (error) {
    console.error("[web-search] Startup maintenance failed:", error);
  }
  const timer = setInterval(
    () => {
      try {
        cleanupExpiredWebSearchData();
      } catch (error) {
        console.error("[web-search] Scheduled cleanup failed:", error);
      }
    },
    60 * 60 * 1000,
  );
  timer.unref();
  return () => clearInterval(timer);
}

export function parseWebSearchRequest(value: unknown): WebSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }
  const input = value as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 500) throw new Error("query must contain 1 to 500 characters.");
  const scope = input.scope ?? "academic";
  if (typeof scope !== "string" || !VALID_SCOPES.has(scope as WebSearchScope)) {
    throw new Error("scope must be academic, technical, or mixed.");
  }
  const contentTypes = parseStringArray(input.contentTypes, 5);
  if (contentTypes.some((type) => !VALID_CONTENT_TYPES.has(type as WebSearchContentType))) {
    throw new Error("contentTypes contains an unsupported value.");
  }
  const maxResults = input.maxResults === undefined ? undefined : Number(input.maxResults);
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)) {
    throw new Error("maxResults must be an integer between 1 and 100.");
  }

  return {
    query,
    scope: scope as WebSearchScope,
    concepts: parseConcepts(input.concepts),
    contentTypes: contentTypes.length > 0 ? (contentTypes as WebSearchContentType[]) : undefined,
    dateRange: parseDateRange(input.dateRange),
    languages: parseStringArray(input.languages, 5),
    providers: parseStringArray(input.providers, 10),
    includeDomains: parseStringArray(input.includeDomains, 20),
    excludeDomains: parseStringArray(input.excludeDomains, 20),
    sort: input.sort === "recent" ? "recent" : "relevance",
    maxResults,
    searchBudget:
      input.searchBudget === "low_cost" || input.searchBudget === "broad" ? input.searchBudget : "balanced",
    autoSummarize: input.autoSummarize === true,
    allowQueryRewrite: input.allowQueryRewrite === true,
  };
}

function parseConcepts(value: unknown): WebSearchRequest["concepts"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("concepts must be an object.");
  }
  const input = value as Record<string, unknown>;
  const concepts = {
    must: parseConceptList(input.must, "concepts.must"),
    should: parseConceptList(input.should, "concepts.should"),
    exclude: parseConceptList(input.exclude, "concepts.exclude"),
    requireMustMatch: input.requireMustMatch === true,
  };
  if (
    concepts.must.length === 0 &&
    concepts.should.length === 0 &&
    concepts.exclude.length === 0 &&
    !concepts.requireMustMatch
  ) {
    return undefined;
  }
  return concepts;
}

function parseConceptList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12 || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of up to 12 strings.`);
  }
  const concepts = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (concepts.some((concept) => concept.length > 80)) {
    throw new Error(`${field} items must contain at most 80 characters.`);
  }
  return concepts;
}

function parseStringArray(value: unknown, limit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string")) {
    throw new Error("List filters must be bounded arrays of strings.");
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function parseDateRange(value: unknown): WebSearchRequest["dateRange"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dateRange must be an object.");
  }
  const input = value as Record<string, unknown>;
  const start = parseDate(input.start, "dateRange.start");
  const end = parseDate(input.end, "dateRange.end");
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
    throw new Error("dateRange.start must not be after dateRange.end.");
  }
  return start || end ? { start, end } : undefined;
}

function parseDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${field} must be a valid date.`);
  }
  return value;
}

function parseEventId(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseWebSaveRequest(value: unknown): {
  mode: WebSaveMode;
  favorite: boolean;
  generateSummary: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Save request must be an object.");
  }
  const input = value as Record<string, unknown>;
  const mode = input.mode ?? "metadata_only";
  if (mode !== "metadata_only" && mode !== "save_content" && mode !== "download_pdf") {
    throw new Error("mode must be metadata_only, save_content, or download_pdf.");
  }
  return {
    mode,
    favorite: input.favorite === true,
    generateSummary: input.generateSummary === true,
  };
}

function parseRetryProviderIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Retry request must be an object.");
  }
  const input = value as Record<string, unknown>;
  const providerIds = parseStringArray(input.providerIds ?? input.providers, 10).map((providerId) =>
    providerId.toLowerCase(),
  );
  const allowed = new Set(["arxiv", "openalex", "crossref", "tavily", "brave", "github", "mcp"]);
  if (providerIds.some((providerId) => !allowed.has(providerId))) {
    throw new Error("Retry providers contain an unsupported value.");
  }
  return providerIds.length > 0 ? providerIds : undefined;
}

function writeSse(res: Response, eventId: number, type: string, data: Record<string, unknown>): void {
  res.write(`id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function appendHeartbeat(sessionId: string) {
  return appendWebSearchEvent(sessionId, "heartbeat", {
    timestamp: new Date().toISOString(),
  });
}

function parseConnectionInput(value: unknown, id?: string): WebSearchConnectionWrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connection must be an object.");
  }
  const input = value as Record<string, unknown>;
  const existing = id ? getWebSearchConnection(id) : null;
  const provider = input.provider ?? existing?.provider;
  if (provider !== "openalex" && provider !== "tavily" && provider !== "brave" && provider !== "mcp") {
    throw new Error("provider must be openalex, tavily, brave, or mcp.");
  }
  const name = typeof input.name === "string" ? input.name.trim() : (existing?.name ?? "");
  if (!name || name.length > 100) throw new Error("name must contain 1 to 100 characters.");
  const settingsInput =
    input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
      ? (input.settings as Record<string, unknown>)
      : {};
  if (provider === "mcp") {
    const transport = settingsInput.mcpTransport ?? existing?.settings.mcpTransport ?? "stdio";
    if (transport !== "stdio" && transport !== "streamable_http") {
      throw new Error("settings.mcpTransport must be stdio or streamable_http.");
    }
    const apiKey =
      typeof input.apiKey === "string" && input.apiKey.trim()
        ? input.apiKey.trim()
        : input.clearApiKey === true
          ? undefined
          : existing?.apiKey;
    const toolName = readBoundedString(
      settingsInput.mcpToolName ?? existing?.settings.mcpToolName,
      "settings.mcpToolName",
      200,
    );
    if (transport === "streamable_http") {
      const endpoint = readBoundedString(
        settingsInput.mcpEndpoint ?? existing?.settings.mcpEndpoint,
        "settings.mcpEndpoint",
        2048,
      );
      if (!apiKey) {
        throw new Error("HTTP Search MCP connections require a local authentication token.");
      }
      return {
        id,
        provider,
        name,
        enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
        isPrimary: input.isPrimary === undefined ? (existing?.isPrimary ?? false) : input.isPrimary === true,
        settings: {
          mcpTransport: "streamable_http",
          mcpEndpoint: endpoint,
          mcpToolName: toolName,
          mcpInputAdapter: parseStringMap(
            settingsInput.mcpInputAdapter ?? existing?.settings.mcpInputAdapter,
            "settings.mcpInputAdapter",
            8,
          ),
          mcpOutputAdapter: parseOutputAdapter(
            settingsInput.mcpOutputAdapter ?? existing?.settings.mcpOutputAdapter,
          ),
        },
        apiKey,
        clearApiKey: input.clearApiKey === true,
      };
    }
    const command = readBoundedString(
      settingsInput.mcpCommand ?? existing?.settings.mcpCommand,
      "settings.mcpCommand",
      2048,
    );
    const args = parseBoundedStringArray(
      settingsInput.mcpArgs ?? existing?.settings.mcpArgs ?? [],
      "settings.mcpArgs",
      32,
      4096,
    );
    return {
      id,
      provider,
      name,
      enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
      isPrimary: input.isPrimary === undefined ? (existing?.isPrimary ?? false) : input.isPrimary === true,
      settings: {
        mcpTransport: "stdio",
        mcpCommand: command,
        mcpArgs: args,
        mcpToolName: toolName,
        mcpInputAdapter: parseStringMap(
          settingsInput.mcpInputAdapter ?? existing?.settings.mcpInputAdapter,
          "settings.mcpInputAdapter",
          8,
        ),
        mcpOutputAdapter: parseOutputAdapter(
          settingsInput.mcpOutputAdapter ?? existing?.settings.mcpOutputAdapter,
        ),
      },
      apiKey,
      clearApiKey: input.clearApiKey === true,
    };
  }
  const baseUrl =
    typeof settingsInput.baseUrl === "string"
      ? settingsInput.baseUrl.trim()
      : (existing?.settings.baseUrl ?? defaultBaseUrl(provider));
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "https:") throw new Error(`${provider} baseUrl must use HTTPS.`);
  return {
    id,
    provider,
    name,
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
    isPrimary: input.isPrimary === undefined ? (existing?.isPrimary ?? false) : input.isPrimary === true,
    settings: { baseUrl: parsedUrl.toString().replace(/\/$/, "") },
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() || undefined : undefined,
    clearApiKey: input.clearApiKey === true,
  };
}

function defaultBaseUrl(provider: "openalex" | "tavily" | "brave"): string {
  if (provider === "tavily") return "https://api.tavily.com";
  if (provider === "brave") return "https://api.search.brave.com/res/v1";
  return "https://api.openalex.org";
}

function toDiscoveryConnection(input: WebSearchConnectionWrite) {
  const now = new Date().toISOString();
  return {
    id: input.id ?? "mcp-discovery",
    provider: "mcp" as const,
    name: input.name,
    enabled: input.enabled ?? true,
    isPrimary: input.isPrimary ?? false,
    settings: input.settings ?? {},
    hasApiKey: false,
    createdAt: now,
    updatedAt: now,
  };
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} must contain 1 to ${maxLength} characters.`);
  }
  return value.trim();
}

function parseBoundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== "string" || item.length > maxItemLength || item.includes("\0"))
  ) {
    throw new Error(`${field} must be a bounded array of strings.`);
  }
  return value;
}

function parseStringMap(
  value: unknown,
  field: string,
  maxEntries: number,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length > maxEntries ||
    entries.some(
      ([key, item]) => key.length > 100 || typeof item !== "string" || !item.trim() || item.length > 200,
    )
  ) {
    throw new Error(`${field} contains an invalid mapping.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseOutputAdapter(value: unknown): McpSearchOutputAdapter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings.mcpOutputAdapter must be an object.");
  }
  const input = value as Record<string, unknown>;
  const itemsPath =
    input.itemsPath === undefined
      ? undefined
      : readBoundedString(input.itemsPath, "settings.mcpOutputAdapter.itemsPath", 200);
  const fields = parseStringMap(input.fields, "settings.mcpOutputAdapter.fields", 24);
  return { itemsPath, fields };
}

function redactConnectionMessage(message: string, apiKey: string | undefined): string {
  return redactSensitiveText(message, apiKey ? [apiKey] : []);
}

function buildConnectionDiagnostic(
  error: unknown,
  connection: {
    provider: WebSearchConnectionProvider;
    settings: { mcpTransport?: "stdio" | "streamable_http" };
    apiKey?: string;
  },
): WebSearchConnectionTestDiagnostic {
  const message = error instanceof Error ? error.message : "Web Search connection test failed.";
  const normalized = message.toLowerCase();
  const diagnostic: WebSearchConnectionTestDiagnostic = {
    stage: "unknown",
    code: "UNKNOWN_ERROR",
    retryable: true,
    message,
    provider: connection.provider,
    transport: connection.settings.mcpTransport,
  };
  if (
    /not configured|missing|must contain|must be|invalid json|invalid schema|unsupported value|must use https|loopback|trusted/.test(
      normalized,
    )
  ) {
    diagnostic.stage =
      normalized.includes("trusted") || normalized.includes("loopback") ? "security" : "configuration";
    diagnostic.code = "INVALID_CONFIGURATION";
    diagnostic.retryable = false;
    return diagnostic;
  }
  if (/401|403|unauthor|auth|token/.test(normalized)) {
    diagnostic.stage = "authentication";
    diagnostic.code = "AUTHENTICATION_FAILED";
    diagnostic.retryable = false;
    return diagnostic;
  }
  if (
    /timeout|timed out|fetch failed|network|dns|econn|enotfound|econnrefused|socket|connection closed/.test(
      normalized,
    )
  ) {
    diagnostic.stage = "network";
    diagnostic.code = "NETWORK_UNAVAILABLE";
    diagnostic.retryable = true;
    return diagnostic;
  }
  if (/schema|items path|structured content|malformed json|invalid response/.test(normalized)) {
    diagnostic.stage = "schema";
    diagnostic.code = "SCHEMA_MISMATCH";
    diagnostic.retryable = false;
    return diagnostic;
  }
  if (/tool .*not discovered|unknown tool|tools\/list|tools\/call|discovery/.test(normalized)) {
    diagnostic.stage = "tool";
    diagnostic.code = "TOOL_DISCOVERY_FAILED";
    diagnostic.retryable = true;
    return diagnostic;
  }
  return diagnostic;
}
