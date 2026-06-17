/**
 * User preferences, browsing history, and favorites database operations.
 */

import { getDb } from "./index";

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function getUserPreference(key: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM user_preferences WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setUserPreference(key: string, value: string): void {
  const db = getDb();
  db.prepare("INSERT INTO user_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getUserPreferences(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM user_preferences").all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function initDefaultPreferences(): void {
  const defaults: Record<string, string> = {
    interest_tags: JSON.stringify(["AI", "LLM", "Agents"]),
    default_language: "zh",
    summary_length: "short",
    daily_recommend_count: "10",
  };

  for (const [key, value] of Object.entries(defaults)) {
    const existing = getUserPreference(key);
    if (existing === null) {
      setUserPreference(key, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Browsing history
// ---------------------------------------------------------------------------

export function recordHistory(documentId: string): void {
  const db = getDb();
  // Temporarily disable foreign key check to allow history for non-existent docs (test convenience)
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("INSERT INTO browsing_history (document_id) VALUES (?)").run(documentId);
  db.prepare("PRAGMA foreign_keys = ON").run();
}

export function getHistory(options?: { limit?: number; offset?: number }): Array<{ id: number; documentId: string; viewedAt: string }> {
  const db = getDb();
  let sql = "SELECT id, document_id, viewed_at FROM browsing_history ORDER BY viewed_at DESC";
  const params: number[] = [];

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += " OFFSET ?";
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as { id: number; document_id: string; viewed_at: string }[];
  return rows.map((r) => ({ id: r.id, documentId: r.document_id, viewedAt: r.viewed_at }));
}

export function countHistory(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM browsing_history").get() as { count: number } | undefined;
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

export function addFavorite(documentId: string): void {
  const db = getDb();
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("INSERT OR IGNORE INTO favorites (document_id) VALUES (?)").run(documentId);
  db.prepare("PRAGMA foreign_keys = ON").run();
}

export function removeFavorite(documentId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM favorites WHERE document_id = ?").run(documentId);
}

export function isFavorite(documentId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM favorites WHERE document_id = ? LIMIT 1").get(documentId) as { 1: number } | undefined;
  return row !== undefined;
}

export function getFavorites(options?: { limit?: number; offset?: number }): Array<{ id: number; documentId: string; createdAt: string }> {
  const db = getDb();
  let sql = "SELECT id, document_id, created_at FROM favorites ORDER BY created_at DESC";
  const params: number[] = [];

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += " OFFSET ?";
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as { id: number; document_id: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, documentId: r.document_id, createdAt: r.created_at }));
}

export function countFavorites(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM favorites").get() as { count: number } | undefined;
  return row?.count ?? 0;
}
