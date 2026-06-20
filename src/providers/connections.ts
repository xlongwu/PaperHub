import { getLlmConnection } from "@/db/llm-connections";
import { clonePreset, getLlmProviderPreset } from "./catalog";
import { validateHttpUrl } from "./runtime";
import { validateJsonPath } from "./template";
import type {
  JsonTemplate,
  LlmAuthConfig,
  LlmConnectionConfig,
  LlmModelDiscoveryTemplate,
  LlmProtocol,
  LlmRequestMethod,
  LlmRequestTemplate,
} from "./types";

const PROTOCOLS: LlmProtocol[] = [
  "openai_chat",
  "anthropic_messages",
  "gemini_generate_content",
  "custom_json",
];
const AUTH_TYPES = ["bearer", "header", "query", "none"] as const;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);

export interface LlmConnectionInput {
  id?: string;
  name: string;
  presetId: string | null;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
}

export function createLlmConnectionInputFromPreset(
  presetId: string,
  name?: string,
): LlmConnectionInput {
  const preset = getLlmProviderPreset(presetId);
  if (!preset) throw new Error(`Unknown LLM preset "${presetId}".`);
  const cloned = clonePreset(preset);
  return {
    name: normalizeString(name ?? cloned.label, "name", 100, true),
    presetId: cloned.id === "custom" ? null : cloned.id,
    protocol: cloned.protocol,
    baseUrl: cloned.baseUrl,
    model: cloned.defaultModel,
    auth: cloned.auth,
    request: cloned.request,
    models: cloned.models,
  };
}

export function parseLlmConnectionInput(body: unknown): LlmConnectionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("LLM connection must be an object.");
  }
  const input = body as Record<string, unknown>;
  const id =
    input.id === undefined
      ? undefined
      : normalizeString(input.id, "id", 100, true);
  const existing = id ? safeGetConnection(id) : null;
  const presetId =
    input.presetId === null || input.presetId === ""
      ? null
      : input.presetId === undefined
        ? existing?.presetId ?? null
        : normalizeString(input.presetId, "presetId", 100, true);
  const preset = presetId ? getLlmProviderPreset(presetId) : undefined;

  const protocol = (input.protocol ?? existing?.protocol ?? preset?.protocol) as LlmProtocol;
  if (!PROTOCOLS.includes(protocol)) {
    throw new Error(`Unsupported LLM protocol "${String(protocol)}".`);
  }

  const baseUrl = normalizeString(
    input.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl,
    "baseUrl",
    2048,
    true,
  );
  validateHttpUrl(baseUrl);
  const model = normalizeString(
    input.model ?? existing?.model ?? preset?.defaultModel,
    "model",
    256,
    true,
  );

  const auth = parseAuth(input.auth ?? existing?.auth ?? preset?.auth);
  const request = parseRequestTemplate(
    input.request ?? existing?.request ?? preset?.request,
  );
  const models = parseModelTemplate(
    input.models === undefined ? existing?.models ?? preset?.models ?? null : input.models,
  );

  const apiKey =
    input.apiKey === undefined
      ? undefined
      : normalizeString(input.apiKey, "apiKey", 4096, false) || undefined;
  const clearApiKey =
    input.clearApiKey === undefined
      ? undefined
      : parseBoolean(input.clearApiKey, "clearApiKey");

  return {
    id,
    name: normalizeString(
      input.name ?? existing?.name ?? preset?.label,
      "name",
      100,
      true,
    ),
    presetId,
    protocol,
    baseUrl,
    model,
    apiKey,
    clearApiKey,
    auth,
    request,
    models,
  };
}

export function toTestableConnection(input: LlmConnectionInput): LlmConnectionConfig {
  const existing = input.id ? safeGetConnection(input.id) : null;
  return {
    id: input.id ?? "draft",
    name: input.name,
    presetId: input.presetId,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.clearApiKey ? undefined : input.apiKey ?? existing?.apiKey,
    auth: input.auth,
    request: input.request,
    models: input.models,
  };
}

function parseAuth(value: unknown): LlmAuthConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("auth must be an object.");
  }
  const input = value as Record<string, unknown>;
  const type = normalizeString(input.type, "auth.type", 32, true);
  if (!AUTH_TYPES.includes(type as (typeof AUTH_TYPES)[number])) {
    throw new Error(`Unsupported auth type "${type}".`);
  }
  if (type === "header") {
    return {
      type,
      headerName: parseHeaderName(input.headerName, "auth.headerName"),
    };
  }
  if (type === "query") {
    return {
      type,
      queryParam: normalizeIdentifier(input.queryParam, "auth.queryParam"),
    };
  }
  return { type: type as "bearer" | "none" };
}

function parseRequestTemplate(value: unknown): LlmRequestTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object.");
  }
  const input = value as Record<string, unknown>;
  const method = normalizeString(input.method, "request.method", 8, true).toUpperCase();
  if (method !== "POST" && method !== "PUT") {
    throw new Error("Generation requests must use POST or PUT.");
  }
  const path = parseRelativePath(input.path, "request.path");
  const headers = parseHeaders(input.headers, "request.headers");
  const body = parseJsonTemplate(input.body, "request.body");
  const responsePath = normalizeString(
    input.responsePath,
    "request.responsePath",
    512,
    true,
  );
  validateJsonPath(responsePath);
  return { method, path, headers, body, responsePath };
}

function parseModelTemplate(value: unknown): LlmModelDiscoveryTemplate | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("models must be an object or null.");
  }
  const input = value as Record<string, unknown>;
  const method = normalizeString(input.method, "models.method", 8, true).toUpperCase();
  if (!["GET", "POST", "PUT"].includes(method)) {
    throw new Error("Model discovery must use GET, POST, or PUT.");
  }
  const listPath = normalizeString(input.listPath, "models.listPath", 512, true);
  const idPath = normalizeString(input.idPath, "models.idPath", 512, true);
  validateJsonPath(listPath);
  validateJsonPath(idPath);
  return {
    method: method as LlmRequestMethod,
    path: parseRelativePath(input.path, "models.path"),
    headers: parseHeaders(input.headers, "models.headers"),
    body:
      input.body === undefined
        ? undefined
        : parseJsonTemplate(input.body, "models.body"),
    listPath,
    idPath,
  };
}

function parseHeaders(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedName = parseHeaderName(name, `${field}.${name}`);
    if (SENSITIVE_HEADER_NAMES.has(normalizedName.toLowerCase())) {
      throw new Error(
        `${field} must not contain credential headers; configure them through auth instead.`,
      );
    }
    result[normalizedName] = normalizeString(
      headerValue,
      `${field}.${name}`,
      2048,
      false,
    );
  }
  return result;
}

function parseJsonTemplate(value: unknown, field: string): JsonTemplate {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    assertAllowedPlaceholders(value, field);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonTemplate(item, `${field}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        assertAllowedPlaceholders(key, `${field} key`);
        return [key, parseJsonTemplate(item, `${field}.${key}`)];
      }),
    );
  }
  throw new Error(`${field} must contain valid JSON values.`);
}

function assertAllowedPlaceholders(value: string, field: string): void {
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (!["prompt", "model", "maxTokens"].includes(match[1]!)) {
      throw new Error(`${field} contains unsupported placeholder "{{${match[1]}}}".`);
    }
  }
  if (/api[_-]?key|authorization/i.test(value)) {
    throw new Error(`${field} must not reference API keys or authorization values.`);
  }
}

function parseRelativePath(value: unknown, field: string): string {
  const path = normalizeString(value, field, 2048, true);
  if (!path.startsWith("/") || /^\/\//.test(path) || /^https?:/i.test(path)) {
    throw new Error(`${field} must be a relative path beginning with "/".`);
  }
  assertAllowedPlaceholders(path, field);
  return path;
}

function parseHeaderName(value: unknown, field: string): string {
  const name = normalizeString(value, field, 128, true);
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error(`${field} is not a valid HTTP header name.`);
  }
  return name;
}

function normalizeIdentifier(value: unknown, field: string): string {
  const result = normalizeString(value, field, 128, true);
  if (!/^[A-Za-z0-9_.~-]+$/.test(result)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return result;
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long.`);
  return normalized;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function safeGetConnection(id: string): LlmConnectionConfig | null {
  try {
    return getLlmConnection(id);
  } catch {
    return null;
  }
}
