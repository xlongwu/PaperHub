import { getDocumentById } from "@/db/documents";
import { getWebSearchResult, getWebSearchSession } from "@/db/web-search";
import { hybridSearch } from "@/search";
import { saveWebSearchResult } from "@/services/web-save-service";
import {
  createWebSearchSession,
  executeWebSearchSession,
} from "@/services/web-search-service";
import {
  generateWebResultSummary,
  generateWebSearchSynthesis,
} from "@/services/web-search-summary";
import type {
  WebSaveMode,
  WebSearchBudgetPreset,
  WebSearchRequest,
  WebSearchScope,
} from "@/web-search/types";

const MCP_PROVIDER_WHITELIST = new Set([
  "arxiv",
  "openalex",
  "tavily",
  "brave",
  "mcp",
]);
const MCP_CONTENT_TYPE_WHITELIST = new Set([
  "paper",
  "official_blog",
  "technical_article",
  "documentation",
  "repository",
]);

export async function searchWebTool(input: Record<string, unknown>) {
  const request = parseMcpWebSearchRequest(input);
  const session = createWebSearchSession(request);
  return executeWebSearchSession(session.id);
}

export function getWebSearchSessionTool(input: Record<string, unknown>) {
  const sessionId = requiredString(input.sessionId, "sessionId", 128);
  const session = getWebSearchSession(sessionId);
  if (!session) throw new Error("Web Search session not found.");
  return session;
}

export function getWebResultTool(input: Record<string, unknown>) {
  const sessionId = requiredString(input.sessionId, "sessionId", 128);
  const resultId = requiredString(input.resultId, "resultId", 128);
  const result = getWebSearchResult(sessionId, resultId);
  if (!result) throw new Error("Web Search result not found.");
  return result;
}

export async function summarizeWebResultsTool(input: Record<string, unknown>) {
  const sessionId = requiredString(input.sessionId, "sessionId", 128);
  if (!getWebSearchSession(sessionId)) throw new Error("Web Search session not found.");
  return generateWebSearchSynthesis(sessionId);
}

export async function summarizeWebResultTool(input: Record<string, unknown>) {
  const sessionId = requiredString(input.sessionId, "sessionId", 128);
  const resultId = requiredString(input.resultId, "resultId", 128);
  if (!getWebSearchResult(sessionId, resultId)) {
    throw new Error("Web Search result not found.");
  }
  return generateWebResultSummary(sessionId, resultId);
}

export async function saveWebResultTool(input: Record<string, unknown>) {
  const sessionId = requiredString(input.sessionId, "sessionId", 128);
  const resultId = requiredString(input.resultId, "resultId", 128);
  const mode = input.mode;
  if (
    mode !== "metadata_only" &&
    mode !== "save_content" &&
    mode !== "download_pdf"
  ) {
    throw new Error(
      "mode must be metadata_only, save_content, or download_pdf.",
    );
  }
  return saveWebSearchResult(sessionId, resultId, {
    mode: mode as WebSaveMode,
    favorite: input.favorite === true,
    generateSummary: input.generateSummary === true,
  });
}

export async function searchLocalLibraryTool(input: Record<string, unknown>) {
  const query = requiredString(input.query, "query", 500);
  const limit = boundedInteger(input.limit, 10, 1, 50);
  return hybridSearch({
    query,
    mode:
      input.mode === "keyword" || input.mode === "semantic"
        ? input.mode
        : "hybrid",
    limit,
    sources: optionalStringArray(input.sources, "sources", 20),
    tags: optionalStringArray(input.tags, "tags", 20),
    dateRange: parseLocalDateRange(input.dateRange),
  });
}

export function getLocalDocumentTool(input: Record<string, unknown>) {
  const documentId = requiredString(input.documentId, "documentId", 256);
  const document = getDocumentById(documentId);
  if (!document) throw new Error("Local document not found.");
  return document;
}

export function parseMcpWebSearchRequest(
  input: Record<string, unknown>,
): WebSearchRequest {
  const query = requiredString(input.query, "query", 500);
  const scope =
    input.scope === "technical" || input.scope === "mixed"
      ? input.scope
      : "academic";
  const searchBudget = parseSearchBudget(input.searchBudget);
  if (
    searchBudget === "broad" &&
    process.env["PAPERHUB_MCP_ALLOW_BROAD_SEARCH"] !== "1"
  ) {
    throw new Error(
      "Broad Search is disabled for MCP. Set PAPERHUB_MCP_ALLOW_BROAD_SEARCH=1 to opt in.",
    );
  }
  const providers = optionalStringArray(input.providers, "providers", 10);
  if (providers?.some((provider) => !MCP_PROVIDER_WHITELIST.has(provider))) {
    throw new Error("providers contains a provider outside the MCP whitelist.");
  }
  const contentTypes = optionalStringArray(
    input.contentTypes,
    "contentTypes",
    5,
  );
  if (
    contentTypes?.some(
      (contentType) => !MCP_CONTENT_TYPE_WHITELIST.has(contentType),
    )
  ) {
    throw new Error("contentTypes contains an unsupported value.");
  }
  return {
    query,
    scope: scope as WebSearchScope,
    contentTypes: contentTypes as WebSearchRequest["contentTypes"],
    dateRange: parseOptionalDateRange(input.dateRange),
    languages: optionalStringArray(input.languages, "languages", 5),
    providers,
    includeDomains: optionalStringArray(
      input.includeDomains,
      "includeDomains",
      20,
    ),
    excludeDomains: optionalStringArray(
      input.excludeDomains,
      "excludeDomains",
      20,
    ),
    sort: input.sort === "recent" ? "recent" : "relevance",
    maxResults: boundedInteger(input.maxResults, 20, 1, 50),
    searchBudget,
    autoSummarize: input.autoSummarize === true,
    allowQueryRewrite: input.allowQueryRewrite === true,
  };
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} must contain 1 to ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== "string" || item.length > 500)
  ) {
    throw new Error(`${field} must be a bounded array of strings.`);
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Numeric value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseSearchBudget(value: unknown): WebSearchBudgetPreset {
  if (value === "low_cost" || value === "broad") return value;
  return "balanced";
}

function parseOptionalDateRange(
  value: unknown,
): WebSearchRequest["dateRange"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dateRange must be an object.");
  }
  const input = value as Record<string, unknown>;
  const start = optionalDate(input.start, "dateRange.start");
  const end = optionalDate(input.end, "dateRange.end");
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
    throw new Error("dateRange.start must not be after dateRange.end.");
  }
  return start || end ? { start, end } : undefined;
}

function parseLocalDateRange(
  value: unknown,
): { start: string; end: string } | undefined {
  const parsed = parseOptionalDateRange(value);
  if (!parsed) return undefined;
  return { start: parsed.start ?? "", end: parsed.end ?? "" };
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${field} must be a valid date.`);
  }
  return value;
}
