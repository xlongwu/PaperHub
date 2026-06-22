import { getActiveLlmConnection, getLlmConnection } from "@/db/llm-connections";
import { getStoredLlmProviderSettings } from "@/db/llm-settings";
import { getLlmProviderPreset } from "./catalog";
import { extractJsonPath, renderJsonTemplate, renderTemplateString } from "./template";
import type { JsonTemplate, LlmConnectionConfig, LlmProvider } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const LONG_REQUEST_TIMEOUT_MS = 60_000;
const DEEP_REPORT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONNECTION_TEST_PROMPT = "Reply with exactly: PaperHub connection OK";
const CONNECTION_TEST_MAX_TOKENS = 256;

const LEGACY_ENV: Record<string, { apiKey: string; model: string; baseUrl?: string }> = {
  anthropic: {
    apiKey: "ANTHROPIC_API_KEY",
    model: "ANTHROPIC_MODEL",
    baseUrl: "ANTHROPIC_BASE_URL",
  },
  openai: {
    apiKey: "OPENAI_API_KEY",
    model: "OPENAI_MODEL",
    baseUrl: "OPENAI_BASE_URL",
  },
  "github-copilot": {
    apiKey: "GITHUB_TOKEN",
    model: "GITHUB_COPILOT_MODEL",
  },
  openrouter: {
    apiKey: "OPENROUTER_API_KEY",
    model: "OPENROUTER_MODEL",
  },
  deepseek: {
    apiKey: "DEEPSEEK_API_KEY",
    model: "DEEPSEEK_MODEL",
  },
};

export type LlmRuntimeSource = "environment_connection" | "environment_provider" | "stored" | "default";

export interface ResolvedLlmRuntime {
  connection: LlmConnectionConfig;
  source: LlmRuntimeSource;
  apiKeySource: "stored" | "environment" | "missing";
}

export class DeclarativeLlmProvider implements LlmProvider {
  readonly name: string;

  constructor(private readonly connection: LlmConnectionConfig) {
    this.name = connection.presetId ?? connection.name;
  }

  async call(prompt: string, maxTokens: number): Promise<string> {
    return callLlmConnection(this.connection, prompt, maxTokens);
  }
}

export function resolveLlmRuntime(): ResolvedLlmRuntime {
  const connectionId = process.env["LLM_CONNECTION_ID"]?.trim();
  if (connectionId) {
    const connection = safeGetConnection(connectionId);
    if (!connection) {
      throw new Error(`LLM_CONNECTION_ID "${connectionId}" does not exist.`);
    }
    return {
      connection,
      source: "environment_connection",
      apiKeySource: connection.apiKey ? "stored" : "missing",
    };
  }

  const legacyProvider = process.env["LLM_PROVIDER"]?.trim();
  if (legacyProvider) {
    return resolveLegacyProvider(legacyProvider, "environment_provider");
  }

  const active = safeGetActiveConnection();
  if (active) {
    return {
      connection: active,
      source: "stored",
      apiKeySource: active.apiKey ? "stored" : "missing",
    };
  }

  return resolveLegacyProvider("deepseek", "default");
}

export function resolveLegacyProvider(
  providerName: string,
  source: Extract<LlmRuntimeSource, "environment_provider" | "default"> = "default",
): ResolvedLlmRuntime {
  const preset = getLlmProviderPreset(providerName);
  const env = LEGACY_ENV[providerName];
  if (!preset || !env) {
    throw new Error(
      `Invalid LLM provider: "${providerName}". Valid providers are: ${Object.keys(LEGACY_ENV).join(", ")}.`,
    );
  }
  const stored = safeGetLegacySettings(providerName);
  const environmentApiKey = process.env[env.apiKey]?.trim();
  const apiKey = environmentApiKey || stored?.apiKey?.trim() || undefined;
  return {
    connection: {
      id: `env-${providerName}`,
      name: preset.label,
      presetId: preset.id,
      protocol: preset.protocol,
      baseUrl: process.env[env.baseUrl ?? ""]?.trim() || stored?.baseUrl?.trim() || preset.baseUrl,
      model: process.env[env.model]?.trim() || stored?.model?.trim() || preset.defaultModel,
      apiKey,
      auth: structuredClone(preset.auth),
      request: structuredClone(preset.request),
      models: preset.models ? structuredClone(preset.models) : null,
    },
    source,
    apiKeySource: environmentApiKey ? "environment" : apiKey ? "stored" : "missing",
  };
}

export async function callLlmConnection(
  connection: LlmConnectionConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const variables = { prompt, model: connection.model, maxTokens };
  const url = buildRequestUrl(
    connection.baseUrl,
    renderTemplateString(connection.request.path, variables),
    connection,
  );
  const body = renderJsonTemplate(connection.request.body, variables);
  const payload = await requestJson(url, {
    method: connection.request.method,
    headers: buildHeaders(connection, connection.request.headers),
    body,
    apiKey: connection.apiKey,
    timeoutMs:
      maxTokens > 8_192
        ? DEEP_REPORT_TIMEOUT_MS
        : maxTokens > 4_096
          ? LONG_REQUEST_TIMEOUT_MS
          : REQUEST_TIMEOUT_MS,
  });
  const text = extractJsonPath(payload, connection.request.responsePath);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(describeMissingResponseText(payload, connection.request.responsePath));
  }
  return text;
}

export async function probeLlmConnection(connection: LlmConnectionConfig): Promise<string> {
  return callLlmConnection(connection, CONNECTION_TEST_PROMPT, CONNECTION_TEST_MAX_TOKENS);
}

export async function discoverLlmModels(connection: LlmConnectionConfig): Promise<string[]> {
  if (!connection.models) {
    throw new Error("This connection does not define a model discovery request.");
  }
  const template = connection.models;
  const variables = { prompt: "", model: connection.model, maxTokens: 1 };
  const url = buildRequestUrl(connection.baseUrl, renderTemplateString(template.path, variables), connection);
  const payload = await requestJson(url, {
    method: template.method,
    headers: buildHeaders(connection, template.headers),
    body: template.method === "GET" ? undefined : renderJsonTemplate(template.body ?? {}, variables),
    apiKey: connection.apiKey,
  });
  const list = extractJsonPath(payload, template.listPath);
  if (!Array.isArray(list)) {
    throw new Error(`Model discovery path ${template.listPath} did not return an array.`);
  }
  const models = list
    .map((item) => extractJsonPath(item, template.idPath))
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.replace(/^models\//, "").trim());
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

interface RequestJsonOptions {
  method: "GET" | "POST" | "PUT";
  headers: Record<string, string>;
  body?: JsonTemplate;
  apiKey?: string;
  timeoutMs?: number;
}

async function requestJson(url: URL, options: RequestJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.method === "GET" || options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Redirect responses are not followed for authenticated LLM requests.");
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error("LLM response exceeded the 2 MB safety limit.");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("LLM response exceeded the 2 MB safety limit.");
    }
    if (!response.ok) {
      const error = new Error(
        redactSecrets(
          `LLM request failed with HTTP ${response.status}: ${raw.slice(0, 500)}`,
          options.apiKey,
        ),
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("LLM endpoint returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs / 1000} seconds.`);
    }
    throw normalizeLlmRequestError(error, options.apiKey);
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeLlmRequestError(error: unknown, apiKey?: string): Error {
  if (error instanceof Error && !isFetchFailure(error)) {
    error.message = redactSecrets(error.message, apiKey);
    return error;
  }

  const code = collectErrorCodes(error)[0];
  const suffix = code ? ` (${code})` : "";
  return new Error(
    redactSecrets(`LLM network request failed${suffix}: ${networkErrorGuidance(code)}`, apiKey),
  );
}

function buildRequestUrl(baseUrl: string, requestPath: string, connection: LlmConnectionConfig): URL {
  const base = validateHttpUrl(baseUrl);
  const url = /^https?:\/\//i.test(requestPath)
    ? validateHttpUrl(requestPath)
    : new URL(
        `${base.pathname.replace(/\/+$/, "")}/${requestPath.replace(/^\/+/, "")}${base.search}`,
        `${base.protocol}//${base.host}`,
      );
  if (connection.auth.type === "query" && connection.apiKey) {
    url.searchParams.set(connection.auth.queryParam ?? "key", connection.apiKey);
  }
  return url;
}

function buildHeaders(
  connection: LlmConnectionConfig,
  templateHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...templateHeaders,
  };
  if (connection.apiKey) {
    if (connection.auth.type === "bearer") {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    } else if (connection.auth.type === "header") {
      headers[connection.auth.headerName ?? "x-api-key"] = connection.apiKey;
    }
  }
  return headers;
}

export function validateHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain embedded credentials.");
  }
  return url;
}

export function redactSecrets(message: string, apiKey?: string): string {
  let redacted = message.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})\b/gi,
    "[REDACTED]",
  );
  if (apiKey) redacted = redacted.split(apiKey).join("[REDACTED]");
  return redacted;
}

function isFetchFailure(error: Error): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

function collectErrorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const value = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const codes = typeof value.code === "string" && value.code.trim() ? [value.code.trim().toUpperCase()] : [];
  codes.push(...collectErrorCodes(value.cause, seen));
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) {
      codes.push(...collectErrorCodes(nested, seen));
    }
  }
  return [...new Set(codes)];
}

function networkErrorGuidance(code?: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "DNS lookup failed. Check the API Base URL, DNS, proxy, and internet connection.";
  }
  if (code === "ECONNREFUSED") {
    return "The endpoint refused the connection. Check the API Base URL and whether the service is reachable.";
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "The endpoint timed out. Check the internet connection, proxy, firewall, and API service status.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Network access was blocked by Windows, a firewall, security software, or a proxy policy.";
  }
  if (code?.includes("CERT") || code?.includes("TLS")) {
    return "TLS certificate validation failed. Check the system clock, proxy certificate, and HTTPS inspection settings.";
  }
  return "The endpoint could not be reached. Check the API Base URL, internet connection, proxy, and firewall.";
}

function describeMissingResponseText(payload: unknown, responsePath: string): string {
  const finishReason =
    extractJsonPath(payload, "$.choices[0].finish_reason") ??
    extractJsonPath(payload, "$.candidates[0].finishReason");
  if (
    typeof finishReason === "string" &&
    ["length", "max_tokens", "max_output_tokens"].includes(finishReason.toLowerCase())
  ) {
    return (
      `The response did not contain text at ${responsePath}. ` +
      "The model reached its output token limit before producing final text; increase max tokens."
    );
  }
  return `The response did not contain text at ${responsePath}.`;
}

function safeGetConnection(id: string): LlmConnectionConfig | null {
  try {
    return getLlmConnection(id);
  } catch {
    return null;
  }
}

function safeGetActiveConnection(): LlmConnectionConfig | null {
  try {
    return getActiveLlmConnection();
  } catch {
    return null;
  }
}

function safeGetLegacySettings(provider: string) {
  try {
    return getStoredLlmProviderSettings(provider);
  } catch {
    return null;
  }
}
