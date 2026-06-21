/**
 * Local embedding provider configuration.
 *
 * Settings saved here take priority over environment variables.
 * API keys are never returned through the API — only a hasApiKey flag is exposed.
 */

import { getDb } from "./index";
import { getSecretStore } from "@/security/secret-store";

export type EmbeddingProviderSetting = "openai" | "ollama";

export interface StoredEmbeddingSettings {
  provider: EmbeddingProviderSetting;
  model: string | null;
  baseUrl: string | null;
  /** API key is stored but never returned to the frontend. Use hasApiKey instead. */
  apiKey: string | null;
}

export interface EmbeddingSettingsUpdate {
  provider: EmbeddingProviderSetting;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** When true, clears the stored API key without requiring a new one. */
  clearApiKey?: boolean;
}

/**
 * Returns the current active embedding provider settings row, or null if none saved.
 * Only one active configuration is kept — the most recently saved provider.
 */
export function getStoredEmbeddingSettings(): StoredEmbeddingSettings | null {
  const row = getDb()
    .prepare(
      `SELECT provider, model, base_url, api_key, secret_ref
       FROM embedding_provider_settings
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get() as
    | {
        provider: string;
        model: string | null;
        base_url: string | null;
        api_key: string | null;
        secret_ref: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    provider: row.provider as EmbeddingProviderSetting,
    model: row.model,
    baseUrl: row.base_url,
    apiKey:
      (row.secret_ref ? getSecretStore().get(row.secret_ref) : undefined) ??
      row.api_key,
  };
}

/**
 * Upserts the embedding provider configuration in the database.
 * Returns the saved settings (apiKey is included internally but
 * callers should NOT forward it to frontend responses).
 */
export function saveStoredEmbeddingSettings(
  update: EmbeddingSettingsUpdate,
): StoredEmbeddingSettings {
  const existing = getStoredEmbeddingSettings();

  const model = update.model === undefined ? (existing?.model ?? null) : normalize(update.model);
  const baseUrl =
    update.baseUrl === undefined ? (existing?.baseUrl ?? null) : normalize(update.baseUrl);

  const secretStore = getSecretStore();
  const secretReference = `embedding-provider:${update.provider}`;
  let apiKey: string | null;
  if (update.clearApiKey) {
    apiKey = null;
  } else if (update.apiKey === undefined) {
    apiKey = existing?.apiKey ?? null;
  } else {
    apiKey = normalize(update.apiKey);
  }
  if (update.clearApiKey || apiKey === null) {
    secretStore.delete(secretReference);
  } else if (update.apiKey !== undefined) {
    secretStore.set(secretReference, apiKey);
  }
  const storedApiKey = secretStore.get(secretReference) ?? null;

  getDb()
    .prepare(
      `INSERT INTO embedding_provider_settings(
         provider, model, base_url, api_key, secret_ref, updated_at
       ) VALUES (?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider) DO UPDATE SET
         model = excluded.model,
         base_url = excluded.base_url,
         api_key = NULL,
         secret_ref = excluded.secret_ref,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(
      update.provider,
      model,
      baseUrl,
      storedApiKey ? secretReference : null,
    );

  return { provider: update.provider, model, baseUrl, apiKey: storedApiKey };
}

function normalize(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
