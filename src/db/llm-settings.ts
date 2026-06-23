/**
 * Local LLM provider configuration.
 *
 * API keys are kept out of the general user-preferences table so they can
 * never be returned by the preferences endpoint accidentally.
 */

import { getDb } from "./index";
import { getSecretStore } from "@/security/secret-store";

export interface StoredLlmProviderSettings {
  provider: string;
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
}

export interface LlmProviderSettingsUpdate {
  apiKey?: string | null;
  model?: string | null;
  baseUrl?: string | null;
}

export function getStoredLlmProviderSettings(provider: string): StoredLlmProviderSettings | null {
  const row = getDb()
    .prepare(
      `SELECT provider, api_key, secret_ref, model, base_url
       FROM llm_provider_settings
       WHERE provider = ?`,
    )
    .get(provider) as
    | {
        provider: string;
        api_key: string | null;
        secret_ref: string | null;
        model: string | null;
        base_url: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    provider: row.provider,
    apiKey: (row.secret_ref ? getSecretStore().get(row.secret_ref) : undefined) ?? row.api_key,
    model: row.model,
    baseUrl: row.base_url,
  };
}

export function saveStoredLlmProviderSettings(
  provider: string,
  update: LlmProviderSettingsUpdate,
): StoredLlmProviderSettings {
  const existing = getStoredLlmProviderSettings(provider);
  const apiKey = update.apiKey === undefined ? (existing?.apiKey ?? null) : normalize(update.apiKey);
  const model = update.model === undefined ? (existing?.model ?? null) : normalize(update.model);
  const baseUrl = update.baseUrl === undefined ? (existing?.baseUrl ?? null) : normalize(update.baseUrl);

  const secretStore = getSecretStore();
  const secretReference = `llm-provider:${provider}`;
  if (update.apiKey !== undefined) {
    if (apiKey) secretStore.set(secretReference, apiKey);
    else secretStore.delete(secretReference);
  }
  const storedApiKey = secretStore.get(secretReference) ?? null;

  getDb()
    .prepare(
      `INSERT INTO llm_provider_settings(
         provider, api_key, secret_ref, model, base_url, updated_at
       ) VALUES (?, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider) DO UPDATE SET
         api_key = NULL,
         secret_ref = excluded.secret_ref,
         model = excluded.model,
         base_url = excluded.base_url,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(provider, storedApiKey ? secretReference : null, model, baseUrl);

  return { provider, apiKey: storedApiKey, model, baseUrl };
}

function normalize(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
