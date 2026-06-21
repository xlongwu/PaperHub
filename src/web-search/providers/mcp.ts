import { getActiveWebSearchConnection } from "@/db/web-search-connections";
import { readToolText, withMcpClient } from "@/web-search/mcp-client";
import type {
  McpSearchInputAdapter,
  McpSearchOutputAdapter,
  ProviderHealth,
  ProviderSearchItem,
  ProviderSearchRequest,
  ProviderSearchResponse,
  WebSearchConnectionConfig,
  WebSearchContentType,
  WebSearchProvider,
} from "@/web-search/types";

const DEFAULT_INPUT: Required<McpSearchInputAdapter> = {
  query: "query",
  limit: "limit",
  intent: "intent",
  startDate: "dateRange.start",
  endDate: "dateRange.end",
  language: "language",
  includeDomains: "includeDomains",
  excludeDomains: "excludeDomains",
};

const DEFAULT_FIELDS: Required<NonNullable<McpSearchOutputAdapter["fields"]>> = {
  id: "id",
  title: "title",
  url: "url",
  canonicalUrl: "canonicalUrl",
  authors: "authors",
  publishedAt: "publishedAt",
  language: "language",
  contentType: "contentType",
  abstract: "abstract",
  snippet: "snippet",
  doi: "identifiers.doi",
  arxivId: "identifiers.arxivId",
  openAlexId: "identifiers.openAlexId",
  pmid: "identifiers.pmid",
  publisher: "origin.publisher",
  venue: "origin.venue",
  sourceName: "origin.sourceName",
  score: "score",
};

const CONTENT_TYPES = new Set<WebSearchContentType>([
  "paper",
  "official_blog",
  "technical_article",
  "documentation",
  "repository",
]);

export class McpWebSearchProvider implements WebSearchProvider {
  readonly id = "mcp";
  readonly displayName = "Search MCP";
  readonly kind = "mcp" as const;
  readonly capabilities = {
    supportsDateRange: true,
    supportsLanguage: true,
    supportsDomainFilter: true,
    supportsExactLookup: true,
    supportsSemanticSearch: false,
    supportsPagination: false,
  };

  constructor(
    private readonly resolveConnection: () => WebSearchConnectionConfig | null = () =>
      getActiveWebSearchConnection("mcp"),
  ) {}

  async isConfigured(): Promise<boolean> {
    const connection = this.resolveConnection();
    return Boolean(
      connection?.enabled &&
        connection.settings.mcpTransport === "stdio" &&
        connection.settings.mcpCommand &&
        connection.settings.mcpToolName,
    );
  }

  async healthCheck(): Promise<ProviderHealth> {
    const connection = this.resolveConnection();
    if (!connection) {
      return {
        status: "unavailable",
        message: "Search MCP is not configured.",
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      await discoverConfiguredMcpTool(connection);
      return { status: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: "unavailable",
        message: safeError(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async search(
    request: ProviderSearchRequest,
    context: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<ProviderSearchResponse> {
    const startedAt = Date.now();
    const connection = this.resolveConnection();
    if (!connection) {
      return {
        providerId: this.id,
        items: [],
        status: "not_configured",
        latencyMs: 0,
        warning: "Search MCP is not configured.",
      };
    }
    try {
      const raw = await withMcpClient(connection, context.timeoutMs, context.signal, async (client) => {
        const tools = await client.listTools();
        const toolName = connection.settings.mcpToolName!;
        if (!tools.some((tool) => tool.name === toolName)) {
          throw new Error(`Configured MCP tool "${toolName}" was not discovered.`);
        }
        return client.callTool(toolName, buildMcpToolArguments(request, connection));
      });
      const payload = raw.structuredContent ?? parseToolText(readToolText(raw));
      const items = adaptMcpSearchOutput(payload, connection, request.limit);
      return {
        providerId: this.id,
        items,
        status: "success",
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        providerId: this.id,
        items: [],
        status: context.signal?.aborted ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt,
        warning: safeError(error),
      };
    }
  }
}

export const mcpWebSearchProvider = new McpWebSearchProvider();

export async function discoverConfiguredMcpTool(
  connection: WebSearchConnectionConfig,
  timeoutMs = 5_000,
): Promise<void> {
  await withMcpClient(connection, timeoutMs, undefined, async (client) => {
    const tools = await client.listTools();
    const toolName = connection.settings.mcpToolName;
    if (!toolName || !tools.some((tool) => tool.name === toolName)) {
      throw new Error(`Configured MCP tool "${toolName ?? ""}" was not discovered.`);
    }
  });
}

export function buildMcpToolArguments(
  request: ProviderSearchRequest,
  connection: WebSearchConnectionConfig,
): Record<string, unknown> {
  const names = { ...DEFAULT_INPUT, ...connection.settings.mcpInputAdapter };
  const output: Record<string, unknown> = {};
  setPath(output, names.query, request.query);
  setPath(output, names.limit, request.limit);
  setPath(output, names.intent, request.intent);
  if (request.dateRange?.start) setPath(output, names.startDate, request.dateRange.start);
  if (request.dateRange?.end) setPath(output, names.endDate, request.dateRange.end);
  if (request.language) setPath(output, names.language, request.language);
  if (request.includeDomains?.length) setPath(output, names.includeDomains, request.includeDomains);
  if (request.excludeDomains?.length) setPath(output, names.excludeDomains, request.excludeDomains);
  return output;
}

export function adaptMcpSearchOutput(
  payload: unknown,
  connection: WebSearchConnectionConfig,
  limit: number,
): ProviderSearchItem[] {
  const adapter = connection.settings.mcpOutputAdapter;
  const rawItems = getPath(payload, adapter?.itemsPath ?? "items");
  if (!Array.isArray(rawItems)) {
    throw new Error("Search MCP output was rejected: configured items path is not an array.");
  }
  const fields = { ...DEFAULT_FIELDS, ...adapter?.fields };
  return rawItems.slice(0, limit).map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Search MCP output item ${index + 1} is not an object.`);
    }
    const title = readString(raw, fields.title);
    const url = readString(raw, fields.url);
    if (!title || !url || !isHttpUrl(url)) {
      throw new Error(`Search MCP output item ${index + 1} requires a title and HTTP(S) URL.`);
    }
    const publishedAt = optionalString(raw, fields.publishedAt);
    if (publishedAt && Number.isNaN(new Date(publishedAt).getTime())) {
      throw new Error(`Search MCP output item ${index + 1} has an invalid publishedAt value.`);
    }
    const contentTypeValue = optionalString(raw, fields.contentType);
    const contentType = CONTENT_TYPES.has(contentTypeValue as WebSearchContentType)
      ? (contentTypeValue as WebSearchContentType)
      : "technical_article";
    const authorsValue = getPath(raw, fields.authors);
    const authors = Array.isArray(authorsValue)
      ? authorsValue.filter((value): value is string => typeof value === "string").slice(0, 100)
      : typeof authorsValue === "string"
        ? authorsValue.split(/[,;]/).map((value) => value.trim()).filter(Boolean)
        : [];
    return {
      providerResultId: optionalString(raw, fields.id),
      title,
      url,
      canonicalUrl: optionalString(raw, fields.canonicalUrl),
      authors,
      publishedAt,
      language: optionalString(raw, fields.language),
      contentType,
      abstract: optionalString(raw, fields.abstract),
      snippet: optionalString(raw, fields.snippet),
      identifiers: {
        doi: optionalString(raw, fields.doi),
        arxivId: optionalString(raw, fields.arxivId),
        openAlexId: optionalString(raw, fields.openAlexId),
        pmid: optionalString(raw, fields.pmid),
      },
      origin: {
        domain: new URL(url).hostname.toLowerCase(),
        publisher: optionalString(raw, fields.publisher),
        venue: optionalString(raw, fields.venue),
        sourceName: optionalString(raw, fields.sourceName) ?? connection.name,
      },
      providerRank: index + 1,
      providerRawScore: optionalNumber(raw, fields.score),
      metadata: { mcpConnectionId: connection.id },
    };
  });
}

function parseToolText(text: string): unknown {
  if (!text) throw new Error("Search MCP tool returned no structured content.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Search MCP text output must contain valid JSON.");
  }
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".").filter(Boolean);
  let current = target;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      current[key] = value;
      return;
    }
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  });
}

function readString(value: unknown, path: string): string {
  const result = getPath(value, path);
  return typeof result === "string" ? result.trim() : "";
}

function optionalString(value: unknown, path: string): string | undefined {
  return readString(value, path) || undefined;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  const result = getPath(value, path);
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Search MCP failed.").slice(0, 500);
}
