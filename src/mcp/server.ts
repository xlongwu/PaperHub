import {
  getLocalDocumentTool,
  getWebResultTool,
  getWebSearchSessionTool,
  saveWebResultTool,
  searchLocalLibraryTool,
  searchWebTool,
  summarizeWebResultTool,
  summarizeWebResultsTool,
} from "./tool-service";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

const TOOLS = [
  tool(
    "search_web",
    "Search current Web sources through PaperHub's query planner, provider budgets, normalization, deduplication, and ranking.",
    {
      query: stringSchema("Research query"),
      scope: enumSchema(["academic", "technical", "mixed"]),
      contentTypes: arraySchema(
        enumSchema([
          "paper",
          "official_blog",
          "technical_article",
          "documentation",
          "repository",
        ]),
      ),
      dateRange: dateRangeSchema(),
      languages: arraySchema(stringSchema("Language code")),
      providers: arraySchema(
        enumSchema(["arxiv", "openalex", "crossref", "tavily", "brave", "github", "mcp"]),
      ),
      includeDomains: arraySchema(stringSchema("Domain")),
      excludeDomains: arraySchema(stringSchema("Domain")),
      sort: enumSchema(["relevance", "recent"]),
      maxResults: numberSchema(1, 50),
      searchBudget: enumSchema(["low_cost", "balanced", "broad"]),
      autoSummarize: booleanSchema(),
      allowQueryRewrite: booleanSchema(),
    },
    ["query"],
    true,
  ),
  tool(
    "get_web_search_session",
    "Read a Web Search session, provider statuses, normalized results, and synthesis.",
    { sessionId: stringSchema("Web Search session ID") },
    ["sessionId"],
    true,
  ),
  tool(
    "get_web_result",
    "Read one result from an existing Web Search session.",
    {
      sessionId: stringSchema("Web Search session ID"),
      resultId: stringSchema("Web result ID"),
    },
    ["sessionId", "resultId"],
    true,
  ),
  tool(
    "summarize_web_results",
    "Generate or retrieve a citation-validated synthesis for one Web Search session.",
    { sessionId: stringSchema("Web Search session ID") },
    ["sessionId"],
    true,
  ),
  tool(
    "summarize_web_result",
    "Generate or retrieve a citation-validated deep summary for one Web result.",
    {
      sessionId: stringSchema("Web Search session ID"),
      resultId: stringSchema("Web result ID"),
    },
    ["sessionId", "resultId"],
    true,
  ),
  tool(
    "save_web_result",
    "Write one result from a valid Web Search session into the local PaperHub library. Call only after explicit user confirmation.",
    {
      sessionId: stringSchema("Web Search session ID"),
      resultId: stringSchema("Web result ID"),
      mode: enumSchema(["metadata_only", "save_content", "download_pdf"]),
      favorite: booleanSchema(),
      generateSummary: booleanSchema(),
    },
    ["sessionId", "resultId", "mode"],
    false,
  ),
  tool(
    "search_local_library",
    "Search only the persisted local PaperHub library using its keyword, semantic, or hybrid engine.",
    {
      query: stringSchema("Local library query"),
      mode: enumSchema(["keyword", "semantic", "hybrid"]),
      limit: numberSchema(1, 50),
      sources: arraySchema(stringSchema("Document source")),
      tags: arraySchema(stringSchema("Canonical or alias tag")),
      dateRange: dateRangeSchema(),
    },
    ["query"],
    true,
  ),
  tool(
    "get_local_document",
    "Read one persisted local PaperHub document by document ID.",
    { documentId: stringSchema("Local document ID") },
    ["documentId"],
    true,
  ),
];

const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  search_web: searchWebTool,
  get_web_search_session: getWebSearchSessionTool,
  get_web_result: getWebResultTool,
  summarize_web_results: summarizeWebResultsTool,
  summarize_web_result: summarizeWebResultTool,
  save_web_result: saveWebResultTool,
  search_local_library: searchLocalLibraryTool,
  get_local_document: getLocalDocumentTool,
};

export async function handlePaperHubMcpRequest(
  value: unknown,
): Promise<Record<string, unknown> | null> {
  const request = value as JsonRpcRequest;
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const id = request.id ?? null;
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "paperhub-local", version: "0.1.1" },
    });
  }
  if (request.method === "ping") return rpcResult(id, {});
  if (request.method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (request.method !== "tools/call") {
    return rpcError(id, -32601, `Method not found: ${request.method ?? ""}`);
  }
  const params =
    request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  const name = typeof params.name === "string" ? params.name : "";
  const handler = TOOL_HANDLERS[name];
  if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args =
    params.arguments &&
    typeof params.arguments === "object" &&
    !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
  try {
    const result = await handler(args);
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const message = safeToolError(error);
    return rpcResult(id, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

export function listPaperHubMcpTools() {
  return TOOLS;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  readOnly: boolean,
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: name.startsWith("search_web") || name.startsWith("summarize_web"),
    },
  };
}

function stringSchema(description: string) {
  return { type: "string", description };
}

function enumSchema(values: string[]) {
  return { type: "string", enum: values };
}

function arraySchema(items: unknown) {
  return { type: "array", items };
}

function numberSchema(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum };
}

function booleanSchema() {
  return { type: "boolean" };
}

function dateRangeSchema() {
  return {
    type: "object",
    properties: {
      start: { type: "string", format: "date-time" },
      end: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : "PaperHub tool failed.";
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]").slice(0, 1000);
}
