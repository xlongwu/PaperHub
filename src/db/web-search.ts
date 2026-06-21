import { getDb } from "./index";
import type {
  ProviderRunStatus,
  WebSearchEvent,
  WebSearchPlan,
  WebSearchProviderRun,
  WebSearchRequest,
  WebSearchResult,
  WebSaveMode,
  WebSearchSession,
  WebSearchSessionStatus,
} from "@/web-search/types";
import {
  cleanupExpiredWebSearchContent,
  getWebSearchSummary,
} from "./web-search-content";

const TERMINAL_STATUSES = new Set<WebSearchSessionStatus>([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "expired",
]);

export function createWebSearchSessionRecord(input: {
  id: string;
  request: WebSearchRequest;
  expiresAt: string;
}): WebSearchSession {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO web_search_sessions(
         id, request_json, status, created_at, updated_at, expires_at
       ) VALUES (?, ?, 'created', ?, ?, ?)`,
    )
    .run(input.id, JSON.stringify(input.request), now, now, input.expiresAt);
  appendWebSearchEvent(input.id, "session.created", {
    status: "created",
    expiresAt: input.expiresAt,
  });
  return getWebSearchSession(input.id)!;
}

export function getWebSearchSession(id: string): WebSearchSession | null {
  expireWebSearchSessionIfNeeded(id);
  const row = getDb()
    .prepare(
      `SELECT id, request_json, plan_json, status, error, created_at, updated_at, expires_at
       FROM web_search_sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    request: parseJson<WebSearchRequest>(row.request_json),
    plan: row.plan_json ? parseJson<WebSearchPlan>(row.plan_json) : undefined,
    status: row.status,
    providerRuns: listWebSearchProviderRuns(id),
    results: listWebSearchResults(id),
    summary: getWebSearchSummary(id, "synthesis") ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function updateWebSearchSession(input: {
  id: string;
  status?: WebSearchSessionStatus;
  plan?: WebSearchPlan;
  error?: string | null;
}): void {
  const current = getWebSearchSession(input.id);
  if (!current) throw new Error(`Web search session "${input.id}" was not found.`);
  getDb()
    .prepare(
      `UPDATE web_search_sessions
       SET status = ?,
           plan_json = ?,
           error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status ?? current.status,
      JSON.stringify(input.plan ?? current.plan ?? null),
      input.error === undefined ? (current.error ?? null) : input.error,
      new Date().toISOString(),
      input.id,
    );
}

export function upsertWebSearchProviderRun(input: {
  sessionId: string;
  providerId: string;
  status: ProviderRunStatus;
  resultCount?: number;
  latencyMs?: number;
  estimatedCredits?: number;
  requestId?: string;
  warning?: string;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO web_search_provider_runs(
         session_id, provider_id, status, result_count, latency_ms, estimated_credits,
         request_id, warning,
         started_at, completed_at, created_at, updated_at, expires_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, expires_at
       FROM web_search_sessions WHERE id = ?
       ON CONFLICT(session_id, provider_id) DO UPDATE SET
         status = excluded.status,
         result_count = excluded.result_count,
         latency_ms = excluded.latency_ms,
         estimated_credits = excluded.estimated_credits,
         request_id = excluded.request_id,
         warning = excluded.warning,
         started_at = COALESCE(web_search_provider_runs.started_at, excluded.started_at),
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.sessionId,
      input.providerId,
      input.status,
      input.resultCount ?? 0,
      input.latencyMs ?? null,
      input.estimatedCredits ?? null,
      input.requestId ?? null,
      input.warning ?? null,
      input.status === "running" ? now : null,
      isProviderTerminal(input.status) ? now : null,
      now,
      now,
      input.sessionId,
    );
}

export function insertWebSearchResults(results: WebSearchResult[]): void {
  if (results.length === 0) return;
  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO web_search_results(
       id, session_id, result_json, rank_order, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  getDb().transaction(() => {
    results.forEach((result, index) => {
      insert.run(
        result.id,
        result.sessionId,
        JSON.stringify(result),
        index + 1,
        result.createdAt,
        result.createdAt,
        result.expiresAt,
      );
    });
  })();
}

export function listWebSearchResults(sessionId: string): WebSearchResult[] {
  return (
    getDb()
      .prepare(
        `SELECT result_json FROM web_search_results
         WHERE session_id = ? ORDER BY rank_order, created_at, id`,
      )
      .all(sessionId) as Array<{ result_json: string }>
  ).map((row) => parseJson<WebSearchResult>(row.result_json));
}

export function getWebSearchResult(
  sessionId: string,
  resultId: string,
): WebSearchResult | null {
  const row = getDb()
    .prepare(
      `SELECT result_json FROM web_search_results
       WHERE session_id = ? AND id = ?`,
    )
    .get(sessionId, resultId) as { result_json: string } | undefined;
  return row ? parseJson<WebSearchResult>(row.result_json) : null;
}

export function updateWebSearchResultLocalState(
  sessionId: string,
  resultId: string,
  localState: WebSearchResult["localState"],
): WebSearchResult {
  const current = getWebSearchResult(sessionId, resultId);
  if (!current) throw new Error("Web Search result was not found.");
  const updated: WebSearchResult = { ...current, localState };
  getDb()
    .prepare(
      `UPDATE web_search_results
       SET result_json = ?, updated_at = ?
       WHERE session_id = ? AND id = ?`,
    )
    .run(
      JSON.stringify(updated),
      new Date().toISOString(),
      sessionId,
      resultId,
    );
  return updated;
}

export function upsertSavedWebSearchResult(input: {
  sessionId: string;
  resultId: string;
  documentId: string;
  saveMode: WebSaveMode;
  pdfSourceUrl?: string;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO web_search_saved_results(
         session_id, result_id, document_id, save_mode, pdf_source_url,
         saved_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, result_id) DO UPDATE SET
         document_id = excluded.document_id,
         save_mode = excluded.save_mode,
         pdf_source_url = COALESCE(excluded.pdf_source_url, web_search_saved_results.pdf_source_url),
         updated_at = excluded.updated_at`,
    )
    .run(
      input.sessionId,
      input.resultId,
      input.documentId,
      input.saveMode,
      input.pdfSourceUrl ?? null,
      now,
      now,
    );
}

export function getSavedWebSearchResult(
  sessionId: string,
  resultId: string,
): {
  documentId: string;
  saveMode: WebSaveMode;
  pdfSourceUrl?: string;
  savedAt: string;
} | null {
  const row = getDb()
    .prepare(
      `SELECT document_id, save_mode, pdf_source_url, saved_at
       FROM web_search_saved_results
       WHERE session_id = ? AND result_id = ?`,
    )
    .get(sessionId, resultId) as
    | {
        document_id: string;
        save_mode: WebSaveMode;
        pdf_source_url: string | null;
        saved_at: string;
      }
    | undefined;
  return row
    ? {
        documentId: row.document_id,
        saveMode: row.save_mode,
        pdfSourceUrl: row.pdf_source_url ?? undefined,
        savedAt: row.saved_at,
      }
    : null;
}

export function appendWebSearchEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): WebSearchEvent {
  const db = getDb();
  const now = new Date().toISOString();
  const eventId = db.transaction(() => {
    const row = db
      .prepare("SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM web_search_events WHERE session_id = ?")
      .get(sessionId) as { next: number };
    db.prepare(
      `INSERT INTO web_search_events(
         session_id, event_id, event_type, data_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, row.next, type, JSON.stringify(data), now);
    return row.next;
  })();
  return { eventId, sessionId, type, data, createdAt: now };
}

export function listWebSearchEvents(sessionId: string, afterEventId = 0): WebSearchEvent[] {
  return (
    getDb()
      .prepare(
        `SELECT event_id, event_type, data_json, created_at
         FROM web_search_events
         WHERE session_id = ? AND event_id > ?
         ORDER BY event_id`,
      )
      .all(sessionId, afterEventId) as Array<{
      event_id: number;
      event_type: string;
      data_json: string;
      created_at: string;
    }>
  ).map((row) => ({
    eventId: row.event_id,
    sessionId,
    type: row.event_type,
    data: parseJson<Record<string, unknown>>(row.data_json),
    createdAt: row.created_at,
  }));
}

export function cancelWebSearchSession(id: string): boolean {
  const session = getWebSearchSession(id);
  if (!session || TERMINAL_STATUSES.has(session.status)) return false;
  updateWebSearchSession({ id, status: "cancelled" });
  appendWebSearchEvent(id, "session.cancelled", { status: "cancelled" });
  return true;
}

export function cleanupExpiredWebSearchData(now = new Date()): {
  sessions: number;
  results: number;
  providerRuns: number;
  evidence: number;
  summaries: number;
  content: number;
  usageEvents: number;
} {
  const db = getDb();
  const isoNow = now.toISOString();
  const deleteBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const base = db.transaction(() => {
    db.prepare(
      `UPDATE web_search_sessions
       SET status = 'expired', updated_at = ?
       WHERE expires_at <= ?
         AND status IN ('completed', 'partial', 'failed', 'cancelled')`,
    ).run(isoNow, isoNow);
    const results = db
      .prepare(
        `DELETE FROM web_search_results
         WHERE expires_at <= ?
           AND json_extract(result_json, '$.localState.status') != 'saving'`,
      )
      .run(isoNow).changes;
    const providerRuns = db
      .prepare("DELETE FROM web_search_provider_runs WHERE expires_at <= ?")
      .run(isoNow).changes;
    const sessions = db
      .prepare(
        `DELETE FROM web_search_sessions
         WHERE expires_at <= ? AND status = 'expired'`,
      )
      .run(deleteBefore).changes;
    return { sessions, results, providerRuns };
  })();
  const usageEvents = db
    .prepare("DELETE FROM web_search_usage_events WHERE created_at <= ?")
    .run(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()).changes;
  const result = { ...base, ...cleanupExpiredWebSearchContent(now), usageEvents };
  getDb()
    .prepare(
      `INSERT INTO web_search_maintenance_state(id, last_cleanup_at, last_cleanup_json)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_cleanup_at = excluded.last_cleanup_at,
         last_cleanup_json = excluded.last_cleanup_json`,
    )
    .run(isoNow, JSON.stringify(result));
  return result;
}

export function recoverInterruptedWebSearchState(now = new Date()): {
  sessions: number;
  savingResults: number;
} {
  const db = getDb();
  const timestamp = now.toISOString();
  const activeRows = db
    .prepare(
      `SELECT s.id,
              (SELECT COUNT(*) FROM web_search_results r WHERE r.session_id = s.id) AS result_count
       FROM web_search_sessions s
       WHERE s.status IN ('planning', 'searching', 'aggregating', 'summarizing')`,
    )
    .all() as Array<{ id: string; result_count: number }>;
  const savingRows = db
    .prepare(
      `SELECT id, session_id, result_json
       FROM web_search_results
       WHERE json_extract(result_json, '$.localState.status') = 'saving'`,
    )
    .all() as Array<{ id: string; session_id: string; result_json: string }>;

  db.transaction(() => {
    const updateSession = db.prepare(
      `UPDATE web_search_sessions
       SET status = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    );
    for (const row of activeRows) {
      updateSession.run(
        row.result_count > 0 ? "partial" : "failed",
        "Previous PaperHub process stopped before this search completed.",
        timestamp,
        row.id,
      );
      appendWebSearchEvent(row.id, "session.interrupted", {
        status: row.result_count > 0 ? "partial" : "failed",
      });
    }

    const updateResult = db.prepare(
      `UPDATE web_search_results SET result_json = ?, updated_at = ?
       WHERE session_id = ? AND id = ?`,
    );
    for (const row of savingRows) {
      const result = parseJson<WebSearchResult>(row.result_json);
      result.localState = { ...result.localState, status: "save_failed" };
      updateResult.run(JSON.stringify(result), timestamp, row.session_id, row.id);
    }

    db.prepare(
      `INSERT INTO web_search_maintenance_state(id, last_recovery_at, last_recovery_json)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_recovery_at = excluded.last_recovery_at,
         last_recovery_json = excluded.last_recovery_json`,
    ).run(
      timestamp,
      JSON.stringify({
        sessions: activeRows.length,
        savingResults: savingRows.length,
      }),
    );
  })();
  return { sessions: activeRows.length, savingResults: savingRows.length };
}

export function getWebSearchMaintenanceState(): {
  lastCleanupAt?: string;
  lastCleanup?: Record<string, number>;
  lastRecoveryAt?: string;
  lastRecovery?: Record<string, number>;
} {
  const row = getDb()
    .prepare(
      `SELECT last_cleanup_at, last_cleanup_json, last_recovery_at, last_recovery_json
       FROM web_search_maintenance_state WHERE id = 1`,
    )
    .get() as
    | {
        last_cleanup_at: string | null;
        last_cleanup_json: string | null;
        last_recovery_at: string | null;
        last_recovery_json: string | null;
      }
    | undefined;
  return row
    ? {
        lastCleanupAt: row.last_cleanup_at ?? undefined,
        lastCleanup: row.last_cleanup_json
          ? parseJson<Record<string, number>>(row.last_cleanup_json)
          : undefined,
        lastRecoveryAt: row.last_recovery_at ?? undefined,
        lastRecovery: row.last_recovery_json
          ? parseJson<Record<string, number>>(row.last_recovery_json)
          : undefined,
      }
    : {};
}

export function getWebSearchCacheCounts(): {
  sessions: number;
  results: number;
  evidence: number;
  summaries: number;
  content: number;
} {
  const db = getDb();
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    sessions: count("web_search_sessions"),
    results: count("web_search_results"),
    evidence: count("web_search_result_evidence"),
    summaries: count("web_search_summaries"),
    content: count("web_content_cache"),
  };
}

function listWebSearchProviderRuns(sessionId: string): WebSearchProviderRun[] {
  return (
    getDb()
      .prepare(
        `SELECT provider_id, status, result_count, latency_ms, estimated_credits, request_id,
                warning, started_at, completed_at
         FROM web_search_provider_runs WHERE session_id = ? ORDER BY provider_id`,
      )
      .all(sessionId) as Array<{
      provider_id: string;
      status: ProviderRunStatus;
      result_count: number;
      latency_ms: number | null;
      estimated_credits: number | null;
      request_id: string | null;
      warning: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>
  ).map((row) => ({
    providerId: row.provider_id,
    status: row.status,
    resultCount: row.result_count,
    latencyMs: row.latency_ms ?? undefined,
    estimatedCredits: row.estimated_credits ?? undefined,
    requestId: row.request_id ?? undefined,
    warning: row.warning ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }));
}

function expireWebSearchSessionIfNeeded(id: string): void {
  const db = getDb();
  const row = db.prepare("SELECT status, expires_at FROM web_search_sessions WHERE id = ?").get(id) as
    | { status: WebSearchSessionStatus; expires_at: string }
    | undefined;
  if (
    row &&
    new Date(row.expires_at).getTime() <= Date.now() &&
    TERMINAL_STATUSES.has(row.status) &&
    row.status !== "expired"
  ) {
    db.prepare("UPDATE web_search_sessions SET status = 'expired', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  }
}

function isProviderTerminal(status: ProviderRunStatus): boolean {
  return !["queued", "running"].includes(status);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

interface SessionRow {
  id: string;
  request_json: string;
  plan_json: string | null;
  status: WebSearchSessionStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}
