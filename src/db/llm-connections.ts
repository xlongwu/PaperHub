import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import type {
  LlmAuthConfig,
  LlmConnectionConfig,
  LlmConnectionPublic,
  LlmModelDiscoveryTemplate,
  LlmProtocol,
  LlmRequestTemplate,
} from "@/providers/types";

interface LlmConnectionRow {
  id: string;
  name: string;
  preset_id: string | null;
  protocol: string;
  base_url: string;
  model: string;
  api_key: string | null;
  auth_json: string;
  request_json: string;
  models_json: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  last_test_at: string | null;
  created_at: string;
  updated_at: string;
  is_active?: number;
}

export interface LlmConnectionWrite {
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

export function listLlmConnections(): LlmConnectionPublic[] {
  const rows = getDb()
    .prepare(
      `SELECT c.*, CASE WHEN r.active_connection_id = c.id THEN 1 ELSE 0 END AS is_active
       FROM llm_connections c
       LEFT JOIN llm_runtime_settings r ON r.id = 1
       ORDER BY is_active DESC, c.updated_at DESC, c.name COLLATE NOCASE`,
    )
    .all() as LlmConnectionRow[];
  return rows.map(toPublicConnection);
}

export function getLlmConnection(id: string): LlmConnectionConfig | null {
  const row = getDb().prepare("SELECT * FROM llm_connections WHERE id = ?").get(id) as
    | LlmConnectionRow
    | undefined;
  return row ? toPrivateConnection(row) : null;
}

export function getPublicLlmConnection(id: string): LlmConnectionPublic | null {
  const row = getDb()
    .prepare(
      `SELECT c.*, CASE WHEN r.active_connection_id = c.id THEN 1 ELSE 0 END AS is_active
       FROM llm_connections c
       LEFT JOIN llm_runtime_settings r ON r.id = 1
       WHERE c.id = ?`,
    )
    .get(id) as LlmConnectionRow | undefined;
  return row ? toPublicConnection(row) : null;
}

export function getActiveLlmConnection(): LlmConnectionConfig | null {
  const row = getDb()
    .prepare(
      `SELECT c.*
       FROM llm_runtime_settings r
       JOIN llm_connections c ON c.id = r.active_connection_id
       WHERE r.id = 1`,
    )
    .get() as LlmConnectionRow | undefined;
  return row ? toPrivateConnection(row) : null;
}

export function getActiveLlmConnectionId(): string | null {
  const row = getDb()
    .prepare("SELECT active_connection_id FROM llm_runtime_settings WHERE id = 1")
    .get() as { active_connection_id: string | null } | undefined;
  return row?.active_connection_id ?? null;
}

export function saveLlmConnection(input: LlmConnectionWrite): LlmConnectionPublic {
  const db = getDb();
  const id = input.id?.trim() || randomUUID();
  const existing = getLlmConnection(id);
  const apiKey = input.clearApiKey
    ? null
    : input.apiKey === undefined
      ? existing?.apiKey ?? null
      : normalizeNullable(input.apiKey);

  db.prepare(
    `INSERT INTO llm_connections(
       id, name, preset_id, protocol, base_url, model, api_key,
       auth_json, request_json, models_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       preset_id = excluded.preset_id,
       protocol = excluded.protocol,
       base_url = excluded.base_url,
       model = excluded.model,
       api_key = excluded.api_key,
       auth_json = excluded.auth_json,
       request_json = excluded.request_json,
       models_json = excluded.models_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    id,
    input.name.trim(),
    normalizeNullable(input.presetId),
    input.protocol,
    input.baseUrl.trim(),
    input.model.trim(),
    apiKey,
    JSON.stringify(input.auth),
    JSON.stringify(input.request),
    input.models ? JSON.stringify(input.models) : null,
  );

  const saved = getPublicLlmConnection(id);
  if (!saved) throw new Error("LLM connection was not saved.");
  return saved;
}

export function activateLlmConnection(id: string): LlmConnectionPublic {
  if (!getLlmConnection(id)) {
    throw new Error(`LLM connection "${id}" was not found.`);
  }
  getDb()
    .prepare(
      `INSERT INTO llm_runtime_settings(id, active_connection_id, updated_at)
       VALUES (1, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         active_connection_id = excluded.active_connection_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(id);
  const active = getPublicLlmConnection(id);
  if (!active) throw new Error("LLM connection could not be activated.");
  return active;
}

export function deleteLlmConnection(id: string): boolean {
  if (getActiveLlmConnectionId() === id) {
    throw new Error("The active LLM connection cannot be deleted.");
  }
  return getDb().prepare("DELETE FROM llm_connections WHERE id = ?").run(id).changes > 0;
}

export function updateLlmConnectionTest(
  id: string,
  status: "success" | "failed",
  message: string,
): void {
  getDb()
    .prepare(
      `UPDATE llm_connections
       SET last_test_status = ?, last_test_message = ?, last_test_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(status, message.slice(0, 1000), id);
}

function toPrivateConnection(row: LlmConnectionRow): LlmConnectionConfig {
  return {
    id: row.id,
    name: row.name,
    presetId: row.preset_id,
    protocol: row.protocol as LlmProtocol,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key ?? undefined,
    auth: JSON.parse(row.auth_json) as LlmAuthConfig,
    request: JSON.parse(row.request_json) as LlmRequestTemplate,
    models: row.models_json
      ? (JSON.parse(row.models_json) as LlmModelDiscoveryTemplate)
      : null,
  };
}

function toPublicConnection(row: LlmConnectionRow): LlmConnectionPublic {
  const connection = toPrivateConnection(row);
  const { apiKey: _apiKey, ...safe } = connection;
  return {
    ...safe,
    hasApiKey: Boolean(row.api_key),
    isActive: row.is_active === 1,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
