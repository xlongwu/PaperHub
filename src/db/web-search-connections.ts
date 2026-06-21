import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { getSecretStore } from "@/security/secret-store";
import type {
  WebSearchConnection,
  WebSearchConnectionConfig,
  WebSearchConnectionProvider,
} from "@/web-search/types";

interface ConnectionRow {
  id: string;
  provider: WebSearchConnectionProvider;
  name: string;
  enabled: number;
  is_primary: number;
  settings_json: string;
  api_key: string | null;
  secret_ref: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebSearchConnectionWrite {
  id?: string;
  provider: WebSearchConnectionProvider;
  name: string;
  enabled?: boolean;
  isPrimary?: boolean;
  settings?: WebSearchConnection["settings"];
  apiKey?: string;
  clearApiKey?: boolean;
}

export function listWebSearchConnections(): WebSearchConnection[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM web_search_connections
         ORDER BY provider, is_primary DESC, updated_at DESC, name COLLATE NOCASE`,
      )
      .all() as ConnectionRow[]
  ).map(toPublicConnection);
}

export function getWebSearchConnection(id: string): WebSearchConnectionConfig | null {
  const row = getDb().prepare("SELECT * FROM web_search_connections WHERE id = ?").get(id) as
    | ConnectionRow
    | undefined;
  return row ? toPrivateConnection(row) : null;
}

export function getActiveWebSearchConnection(
  provider: WebSearchConnectionProvider,
): WebSearchConnectionConfig | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM web_search_connections
       WHERE provider = ? AND enabled = 1
       ORDER BY is_primary DESC, updated_at DESC LIMIT 1`,
    )
    .get(provider) as ConnectionRow | undefined;
  return row ? toPrivateConnection(row) : null;
}

export function saveWebSearchConnection(input: WebSearchConnectionWrite): WebSearchConnection {
  const id = input.id?.trim() || randomUUID();
  const existing = getWebSearchConnection(id);
  const secretStore = getSecretStore();
  const secretReference = `web-search-connection:${id}`;
  if (input.clearApiKey) {
    secretStore.delete(secretReference);
  } else if (input.apiKey !== undefined) {
    const apiKey = normalizeNullable(input.apiKey);
    if (apiKey) secretStore.set(secretReference, apiKey);
    else secretStore.delete(secretReference);
  }
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const isPrimary = input.isPrimary ?? existing?.isPrimary ?? false;
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO web_search_connections(
         id, provider, name, enabled, is_primary, settings_json, api_key, secret_ref,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         name = excluded.name,
         enabled = excluded.enabled,
         is_primary = excluded.is_primary,
         settings_json = excluded.settings_json,
         api_key = NULL,
         secret_ref = excluded.secret_ref,
         updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.provider,
      input.name.trim(),
      enabled ? 1 : 0,
      isPrimary ? 1 : 0,
      JSON.stringify(input.settings ?? existing?.settings ?? {}),
      secretStore.has(secretReference) ? secretReference : null,
      existing?.createdAt ?? now,
      now,
    );
  if (isPrimary) activateWebSearchConnection(id);
  return toPublicConnection(getWebSearchConnection(id)!);
}

export function activateWebSearchConnection(id: string): WebSearchConnection {
  const connection = getWebSearchConnection(id);
  if (!connection) throw new Error(`Web Search connection "${id}" was not found.`);
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb()
      .prepare("UPDATE web_search_connections SET is_primary = 0, updated_at = ? WHERE provider = ?")
      .run(now, connection.provider);
    getDb()
      .prepare(
        `UPDATE web_search_connections
         SET enabled = 1, is_primary = 1, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
  })();
  return toPublicConnection(getWebSearchConnection(id)!);
}

export function deleteWebSearchConnection(id: string): boolean {
  const deleted =
    getDb().prepare("DELETE FROM web_search_connections WHERE id = ?").run(id).changes > 0;
  if (deleted) getSecretStore().delete(`web-search-connection:${id}`);
  return deleted;
}

export function updateWebSearchConnectionTest(
  id: string,
  status: "success" | "failed",
  message: string,
): void {
  getDb()
    .prepare(
      `UPDATE web_search_connections
       SET last_test_status = ?, last_test_message = ?, last_tested_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(status, message.slice(0, 500), new Date().toISOString(), new Date().toISOString(), id);
}

function toPrivateConnection(row: ConnectionRow): WebSearchConnectionConfig {
  return {
    ...toPublicConnection(row),
    apiKey:
      (row.secret_ref ? getSecretStore().get(row.secret_ref) : undefined) ??
      row.api_key ??
      undefined,
  };
}

function toPublicConnection(row: ConnectionRow | WebSearchConnectionConfig): WebSearchConnection {
  if ("createdAt" in row) {
    const { apiKey: _apiKey, ...connection } = row;
    return connection;
  }
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled === 1,
    isPrimary: row.is_primary === 1,
    settings: JSON.parse(row.settings_json) as WebSearchConnection["settings"],
    hasApiKey: Boolean(
      (row.secret_ref && getSecretStore().has(row.secret_ref)) || row.api_key,
    ),
    lastTestStatus: row.last_test_status ?? undefined,
    lastTestMessage: row.last_test_message ?? undefined,
    lastTestedAt: row.last_tested_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeNullable(value: string | undefined): string | null {
  return value?.trim() || null;
}
