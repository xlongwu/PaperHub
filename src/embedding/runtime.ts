import { getStoredLlmProviderSettings } from "@/db/llm-settings";
import { getStoredEmbeddingSettings } from "@/db/embedding-settings";
import crypto from "node:crypto";
import { MockEmbeddingProvider } from "./providers/mock";
import { OllamaEmbeddingProvider, normalizeOllamaBaseUrl } from "./providers/ollama";
import { OpenAIEmbeddingProvider } from "./providers/openai";
import {
  EmbeddingError,
  type EmbeddingConfiguration,
  type EmbeddingProvider,
  type EmbeddingProviderName,
  type EmbeddingRuntime,
} from "./types";
import { validateEmbeddingDimensions } from "./validate";

export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_TEXT_PROFILE_VERSION = "document-v2";

let cachedRuntime: { key: string; runtime: EmbeddingRuntime } | null = null;

export type EmbeddingConfigurationSource = "environment" | "stored" | "default";

/**
 * Returns where the active embedding configuration comes from:
 * - "environment" — at least one key env var (EMBEDDING_PROVIDER, OPENAI_EMBEDDING_MODEL, etc.) is set
 * - "stored"      — configuration loaded from the embedding_provider_settings DB table
 * - "default"     — no env vars and no DB settings; using built-in defaults
 */
export function getEmbeddingConfigurationSource(): EmbeddingConfigurationSource {
  if (process.env["EMBEDDING_MOCK"] === "1") return "environment";
  if (
    process.env["EMBEDDING_PROVIDER"] ??
    process.env["OPENAI_EMBEDDING_MODEL"] ??
    process.env["OLLAMA_EMBEDDING_MODEL"] ??
    process.env["OPENAI_EMBEDDING_BASE_URL"] ??
    process.env["OLLAMA_BASE_URL"] ??
    process.env["EMBEDDING_API_KEY"] ??
    process.env["OPENAI_API_KEY"]
  ) {
    return "environment";
  }
  try {
    if (getStoredEmbeddingSettings()) return "stored";
  } catch {
    // DB not available yet
  }
  return "default";
}

export function getEmbeddingConfiguration(): EmbeddingConfiguration {
  if (process.env["EMBEDDING_MOCK"] === "1") {
    return {
      provider: "mock",
      model: "feature-hash-test-vector-v3",
      expectedDimensions: parseDimensions(process.env["EMBEDDING_EXPECTED_DIMENSIONS"]) ?? 1536,
      truncate: true,
      timeoutMs: parseInteger(process.env["EMBEDDING_TIMEOUT_MS"], 30_000, 100, 300_000),
      batchSize: parseInteger(process.env["EMBEDDING_BATCH_SIZE"], 8, 1, 32),
      maxInputChars: parseInteger(process.env["EMBEDDING_MAX_INPUT_CHARS"], 24_000, 1_000, 200_000),
    };
  }

  // Determine config source: env vars override DB settings
  const hasEnvProvider =
    !!process.env["EMBEDDING_PROVIDER"] ||
    !!process.env["OPENAI_EMBEDDING_MODEL"] ||
    !!process.env["OLLAMA_EMBEDDING_MODEL"] ||
    !!process.env["OPENAI_EMBEDDING_BASE_URL"] ||
    !!process.env["OLLAMA_BASE_URL"] ||
    !!process.env["EMBEDDING_API_KEY"] ||
    !!process.env["OPENAI_API_KEY"];

  // Load DB settings (may be null if not configured via UI)
  let storedSettings: ReturnType<typeof getStoredEmbeddingSettings> = null;
  if (!hasEnvProvider) {
    try {
      storedSettings = getStoredEmbeddingSettings();
    } catch {
      // DB may not be initialised yet during startup probe
    }
  }

  const common = {
    truncate: parseBoolean(process.env["EMBEDDING_TRUNCATE"], true),
    timeoutMs: parseInteger(process.env["EMBEDDING_TIMEOUT_MS"], 30_000, 100, 300_000),
    batchSize: parseInteger(process.env["EMBEDDING_BATCH_SIZE"], 8, 1, 32),
    maxInputChars: parseInteger(process.env["EMBEDDING_MAX_INPUT_CHARS"], 24_000, 1_000, 200_000),
  };
  const expectedDimensions = parseDimensions(process.env["EMBEDDING_EXPECTED_DIMENSIONS"]);

  // Resolve provider: env > DB > default (openai)
  const envProvider = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase();
  const dbProvider = storedSettings?.provider;
  const provider = parseProvider(envProvider ?? dbProvider);

  if (provider === "ollama") {
    const envBaseUrl = process.env["OLLAMA_BASE_URL"]?.trim();
    const dbBaseUrl = storedSettings?.baseUrl ?? undefined;
    const rawBaseUrl = envBaseUrl ?? dbBaseUrl ?? "http://127.0.0.1:11434";
    const baseUrl = normalizeOllamaBaseUrl(rawBaseUrl).toString().replace(/\/+$/, "");

    const envModel = process.env["OLLAMA_EMBEDDING_MODEL"]?.trim();
    const dbModel = storedSettings?.model ?? undefined;
    const model = envModel ?? dbModel ?? "qwen3-embedding:0.6b";

    return {
      ...common,
      provider,
      baseUrl,
      model,
      keepAlive: process.env["EMBEDDING_KEEP_ALIVE"]?.trim() || "5m",
      expectedDimensions,
    };
  }

  // OpenAI path
  const envModel = process.env["OPENAI_EMBEDDING_MODEL"]?.trim();
  const dbModel = storedSettings?.model ?? undefined;
  const model = envModel ?? dbModel ?? "text-embedding-3-small";

  const envBaseUrl = process.env["OPENAI_EMBEDDING_BASE_URL"]?.trim();
  const dbBaseUrl = storedSettings?.baseUrl ?? undefined;
  const baseUrl = envBaseUrl ?? dbBaseUrl ?? "https://api.openai.com/v1";

  const apiKey = getEmbeddingApiKey(storedSettings?.apiKey ?? null);

  return {
    ...common,
    provider,
    model,
    baseUrl,
    apiKey,
    expectedDimensions: expectedDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
  };
}

export function getEmbeddingRuntime(): EmbeddingRuntime {
  const configuration = getEmbeddingConfiguration();
  const key = configurationKey(configuration);
  if (cachedRuntime?.key === key) return cachedRuntime.runtime;

  if (configuration.provider === "ollama") {
    throw new EmbeddingError(
      "EMBEDDING_RUNTIME_UNRESOLVED",
      "The Ollama embedding runtime has not been probed yet.",
    );
  }

  const dimensions = validateEmbeddingDimensions(
    configuration.expectedDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
  );
  const runtime = buildRuntime(configuration, dimensions);
  cachedRuntime = { key, runtime };
  return runtime;
}

export async function resolveEmbeddingRuntime(options?: { probe?: boolean }): Promise<EmbeddingRuntime> {
  const configuration = getEmbeddingConfiguration();
  const key = configurationKey(configuration);
  if (cachedRuntime?.key === key && !options?.probe) return cachedRuntime.runtime;

  if (configuration.provider !== "ollama" && !options?.probe) {
    return getEmbeddingRuntime();
  }

  const provider = createEmbeddingProvider(configuration);
  const result = await provider.probe();
  const dimensions = validateEmbeddingDimensions(result.dimensions);
  const runtime = buildRuntime(configuration, dimensions);
  cachedRuntime = { key, runtime };
  return runtime;
}

export async function probeEmbeddingConfiguration(
  configuration: EmbeddingConfiguration = getEmbeddingConfiguration(),
): Promise<EmbeddingRuntime> {
  const provider = createEmbeddingProvider(configuration);
  const result = await provider.probe();
  return buildRuntime(configuration, validateEmbeddingDimensions(result.dimensions));
}

export function createEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  runtimeDimensions?: number,
): EmbeddingProvider {
  const expectedDimensions = runtimeDimensions ?? configuration.expectedDimensions;
  if (configuration.provider === "mock") {
    return new MockEmbeddingProvider(
      configuration.model,
      validateEmbeddingDimensions(expectedDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS),
    );
  }
  if (configuration.provider === "ollama") {
    return new OllamaEmbeddingProvider({
      baseUrl: configuration.baseUrl ?? "http://127.0.0.1:11434",
      model: configuration.model,
      timeoutMs: configuration.timeoutMs,
      truncate: configuration.truncate,
      keepAlive: configuration.keepAlive,
      expectedDimensions,
    });
  }
  return new OpenAIEmbeddingProvider({
    apiKey: configuration.apiKey,
    model: configuration.model,
    baseUrl: configuration.baseUrl,
    timeoutMs: configuration.timeoutMs,
    expectedDimensions,
  });
}

export function resetEmbeddingRuntime(): void {
  cachedRuntime = null;
}

function buildRuntime(configuration: EmbeddingConfiguration, dimensions: number): EmbeddingRuntime {
  const endpointFingerprint = fingerprintEndpoint(configuration);
  const signature = [
    configuration.provider,
    encodeURIComponent(configuration.model),
    dimensions,
    EMBEDDING_TEXT_PROFILE_VERSION,
    endpointFingerprint,
  ].join(":");

  return {
    provider: configuration.provider,
    model: configuration.model,
    baseUrl: configuration.baseUrl,
    dimensions,
    signature,
    truncate: configuration.truncate,
    keepAlive: configuration.keepAlive,
    timeoutMs: configuration.timeoutMs,
    batchSize: configuration.batchSize,
    maxInputChars: configuration.maxInputChars,
  };
}

function fingerprintEndpoint(configuration: EmbeddingConfiguration): string {
  if (configuration.provider === "mock") return "local";
  const url = new URL(
    configuration.baseUrl ??
      (configuration.provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"),
  );
  const endpoint = `${url.protocol}//${url.hostname}:${url.port || defaultPort(url.protocol)}${url.pathname}`;
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function configurationKey(configuration: EmbeddingConfiguration): string {
  return JSON.stringify({
    provider: configuration.provider,
    model: configuration.model,
    baseUrl: configuration.baseUrl,
    expectedDimensions: configuration.expectedDimensions,
    truncate: configuration.truncate,
    keepAlive: configuration.keepAlive,
    timeoutMs: configuration.timeoutMs,
    batchSize: configuration.batchSize,
    maxInputChars: configuration.maxInputChars,
    hasApiKey: Boolean(configuration.apiKey),
  });
}

function getEmbeddingApiKey(storedApiKey: string | null = null): string | undefined {
  const environmentKey = process.env["EMBEDDING_API_KEY"] || process.env["OPENAI_API_KEY"];
  if (environmentKey) return environmentKey;

  // Use DB-stored key passed in from caller
  if (storedApiKey) return storedApiKey;

  try {
    return getStoredLlmProviderSettings("openai")?.apiKey ?? undefined;
  } catch {
    return undefined;
  }
}

function parseProvider(value: string | undefined): Exclude<EmbeddingProviderName, "mock"> {
  const normalized = value?.trim().toLowerCase() || "openai";
  if (normalized === "openai" || normalized === "ollama") return normalized;
  if (normalized === "local") {
    throw new EmbeddingError(
      "EMBEDDING_UNCONFIGURED",
      'EMBEDDING_PROVIDER="local" is not supported; use "ollama".',
    );
  }
  throw new EmbeddingError(
    "EMBEDDING_UNCONFIGURED",
    `Invalid EMBEDDING_PROVIDER "${normalized}". Use "openai" or "ollama".`,
  );
}

function parseDimensions(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  return validateEmbeddingDimensions(Number(value));
}

function parseInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new EmbeddingError(
      "EMBEDDING_UNCONFIGURED",
      `Embedding setting must be an integer between ${minimum} and ${maximum}; received ${value}.`,
    );
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new EmbeddingError(
    "EMBEDDING_UNCONFIGURED",
    `Embedding boolean setting must be true or false; received ${value}.`,
  );
}
