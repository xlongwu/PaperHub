/**
 * Provider barrel — re-exports and factory.
 *
 * Usage:
 *   import { createProvider, type LlmProvider } from "./providers/index";
 */

export type {
  JsonTemplate,
  LlmAuthConfig,
  LlmAuthType,
  LlmConnectionConfig,
  LlmConnectionPublic,
  LlmModelDiscoveryTemplate,
  LlmProtocol,
  LlmProvider,
  LlmProviderPreset,
  LlmRequestMethod,
  LlmRequestTemplate,
  ProviderFactory,
  ProviderOptions,
} from "./types";
export { OpenAICompatibleProvider } from "./openai-compatible";
export { AnthropicProvider } from "./anthropic";
export { OpenAIProvider } from "./openai";
export { GitHubCopilotProvider } from "./github-copilot";
export { OpenRouterProvider } from "./openrouter";
export { DeepSeekProvider } from "./deepseek";
export { LLM_PROVIDER_CATALOG, getLlmProviderPreset } from "./catalog";
export {
  DeclarativeLlmProvider,
  callLlmConnection,
  discoverLlmModels,
  probeLlmConnection,
  redactSecrets,
  resolveLlmRuntime,
  validateHttpUrl,
} from "./runtime";
export {
  createLlmConnectionInputFromPreset,
  parseLlmConnectionInput,
  toTestableConnection,
  type LlmConnectionInput,
} from "./connections";

import type { LlmProvider, ProviderFactory, ProviderOptions } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { GitHubCopilotProvider } from "./github-copilot";
import { OpenRouterProvider } from "./openrouter";
import { DeepSeekProvider } from "./deepseek";
import { getStoredLlmProviderSettings, saveStoredLlmProviderSettings } from "@/db/llm-settings";
import { getUserPreference, setUserPreference } from "@/db/user";
import { activateLlmConnection, getLlmConnection, saveLlmConnection } from "@/db/llm-connections";
import { getLlmProviderPreset } from "./catalog";
import { DeclarativeLlmProvider, resolveLegacyProvider, resolveLlmRuntime } from "./runtime";

// ---------------------------------------------------------------------------
// Single source of truth — add new providers here only.
// ---------------------------------------------------------------------------

const PROVIDERS = {
  anthropic: (options?: ProviderOptions) => new AnthropicProvider(options),
  openai: (options?: ProviderOptions) => new OpenAIProvider(options),
  "github-copilot": (options?: ProviderOptions) => new GitHubCopilotProvider(options),
  openrouter: (options?: ProviderOptions) => new OpenRouterProvider(options),
  deepseek: (options?: ProviderOptions) => new DeepSeekProvider(options),
} satisfies Record<string, ProviderFactory>;

/** Supported provider name — derived from the PROVIDERS registry. */
export type ProviderName = keyof typeof PROVIDERS;

/** All valid provider names — derived from the registry. */
export const VALID_PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

const PROVIDER_ENV: Record<
  ProviderName,
  { apiKey: string; model: string; baseURL?: string; defaultModel: string; defaultBaseURL?: string }
> = {
  anthropic: {
    apiKey: "ANTHROPIC_API_KEY",
    model: "ANTHROPIC_MODEL",
    baseURL: "ANTHROPIC_BASE_URL",
    defaultModel: "claude-sonnet-4-6",
  },
  openai: {
    apiKey: "OPENAI_API_KEY",
    model: "OPENAI_MODEL",
    baseURL: "OPENAI_BASE_URL",
    defaultModel: "gpt-4o",
  },
  "github-copilot": {
    apiKey: "GITHUB_TOKEN",
    model: "GITHUB_COPILOT_MODEL",
    defaultModel: "gpt-4o",
    defaultBaseURL: "https://models.github.ai/inference",
  },
  openrouter: {
    apiKey: "OPENROUTER_API_KEY",
    model: "OPENROUTER_MODEL",
    defaultModel: "anthropic/claude-sonnet-4",
    defaultBaseURL: "https://openrouter.ai/api/v1",
  },
  deepseek: {
    apiKey: "DEEPSEEK_API_KEY",
    model: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-chat",
    defaultBaseURL: "https://api.deepseek.com",
  },
};

export interface LlmSettingsState {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "stored" | "environment" | "missing";
  supportedProviders: ProviderName[];
}

export interface LlmSettingsUpdate {
  provider: ProviderName;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  baseUrl?: string;
}

/**
 * Create an LLM provider by name.
 *
 * Reads `LLM_PROVIDER` env var when no explicit name is given.
 * Throws a descriptive error if the provider name is invalid.
 *
 * Log safety: only the provider *name* is logged — never API keys or
 * endpoint URLs.
 */
export function createProvider(name?: ProviderName): LlmProvider {
  if (!name) {
    const runtime = resolveLlmRuntime();
    if (runtime.source === "stored" || runtime.source === "environment_connection") {
      console.log(`[providers] Using LLM connection: ${runtime.connection.id}`);
      return new DeclarativeLlmProvider(runtime.connection);
    }
    name = runtime.connection.presetId as ProviderName;
  }
  const runtime = resolveRuntimeSettings(name);
  const providerName = runtime.provider;

  const factory = (PROVIDERS as Record<string, ProviderFactory | undefined>)[providerName];
  if (!factory) {
    throw new Error(
      `Invalid LLM provider: "${providerName}". ` +
        `Valid providers are: ${VALID_PROVIDER_NAMES.join(", ")}. ` +
        `Set the LLM_PROVIDER env var to one of these values.`,
    );
  }

  console.log(`[providers] Using LLM provider: ${providerName}`);
  return factory({
    apiKey: runtime.apiKey,
    model: runtime.model,
    baseURL: runtime.baseUrl,
  });
}

export function getLlmSettingsState(provider?: ProviderName): LlmSettingsState {
  const resolved = provider ? resolveLegacyProvider(provider) : resolveLlmRuntime();
  const providerName = toLegacyProviderName(resolved.connection.presetId);
  return {
    provider: providerName,
    model: resolved.connection.model,
    baseUrl: resolved.connection.baseUrl,
    hasApiKey: Boolean(resolved.connection.apiKey),
    apiKeySource: resolved.apiKeySource,
    supportedProviders: [...VALID_PROVIDER_NAMES],
  };
}

export function saveLlmSettings(update: LlmSettingsUpdate): LlmSettingsState {
  assertProviderName(update.provider);
  setUserPreference("llm_provider", update.provider);

  saveStoredLlmProviderSettings(update.provider, {
    apiKey: update.clearApiKey ? null : update.apiKey,
    model: update.model,
    baseUrl: update.baseUrl,
  });

  const preset = getLlmProviderPreset(update.provider);
  if (preset) {
    const id = `legacy-${update.provider}`;
    const existing = safeReadConnection(id);
    saveLlmConnection({
      id,
      name: preset.label,
      presetId: preset.id,
      protocol: preset.protocol,
      baseUrl: update.baseUrl ?? existing?.baseUrl ?? preset.baseUrl,
      model: update.model ?? existing?.model ?? preset.defaultModel,
      apiKey: update.apiKey,
      clearApiKey: update.clearApiKey,
      auth: existing?.auth ?? structuredClone(preset.auth),
      request: existing?.request ?? structuredClone(preset.request),
      models: existing?.models ?? (preset.models ? structuredClone(preset.models) : null),
    });
    activateLlmConnection(id);
  }

  return getLlmSettingsState(update.provider);
}

function resolveRuntimeSettings(requestedProvider?: ProviderName): {
  provider: ProviderName;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  apiKeySource: LlmSettingsState["apiKeySource"];
} {
  const provider = requestedProvider ?? resolveSelectedProvider();
  assertProviderName(provider);

  const env = PROVIDER_ENV[provider];
  const stored = readStoredSettings(provider);
  const storedApiKey = stored?.apiKey?.trim();
  const environmentApiKey = process.env[env.apiKey]?.trim();
  const apiKey = storedApiKey || environmentApiKey || undefined;
  const apiKeySource = storedApiKey ? "stored" : environmentApiKey ? "environment" : "missing";

  return {
    provider,
    apiKey,
    model: stored?.model?.trim() || process.env[env.model]?.trim() || env.defaultModel,
    baseUrl:
      stored?.baseUrl?.trim() ||
      (env.baseURL ? process.env[env.baseURL]?.trim() : undefined) ||
      env.defaultBaseURL,
    apiKeySource,
  };
}

function resolveSelectedProvider(): ProviderName {
  const stored = readSelectedProvider();
  const environment = process.env["LLM_PROVIDER"]?.trim();
  const candidate = environment || stored || "deepseek";
  assertProviderName(candidate);
  return candidate;
}

function assertProviderName(value: string): asserts value is ProviderName {
  if (!VALID_PROVIDER_NAMES.includes(value as ProviderName)) {
    throw new Error(
      `Invalid LLM provider: "${value}". ` +
        `Valid providers are: ${VALID_PROVIDER_NAMES.join(", ")}. ` +
        `Set the LLM_PROVIDER env var to one of these values.`,
    );
  }
}

function readSelectedProvider(): string | null {
  try {
    return getUserPreference("llm_provider");
  } catch {
    return null;
  }
}

function readStoredSettings(provider: ProviderName) {
  try {
    return getStoredLlmProviderSettings(provider);
  } catch {
    return null;
  }
}

function safeReadConnection(id: string) {
  try {
    return getLlmConnection(id);
  } catch {
    return null;
  }
}

function toLegacyProviderName(presetId: string | null): ProviderName {
  const candidate = presetId === "github-models" ? "github-copilot" : presetId;
  return VALID_PROVIDER_NAMES.includes(candidate as ProviderName) ? (candidate as ProviderName) : "deepseek";
}
