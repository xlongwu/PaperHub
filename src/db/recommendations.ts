/**
 * Persistence helpers for user memory terms and recommendation snapshots.
 */

import { getDocumentById } from "./documents";
import { getDb } from "./index";
import type {
  MemoryCategory,
  MemorySource,
  MemoryTerm,
  RecommendationEntry,
  RecommendationKind,
  RecommendationReason,
} from "@/types";

interface RecommendationSnapshotRow {
  document_id: string;
  score: number;
  rank: number;
  reason: string | null;
}

export function getUserMemoryTerms(options?: {
  category?: MemoryCategory;
  source?: MemorySource;
  limit?: number;
}): MemoryTerm[] {
  const db = getDb();
  let sql = `
    SELECT term, category, weight, source, last_seen_at, meta
    FROM user_memory_terms
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (options?.category) {
    sql += " AND category = ?";
    params.push(options.category);
  }

  if (options?.source) {
    sql += " AND source = ?";
    params.push(options.source);
  }

  sql += " ORDER BY weight DESC, last_seen_at DESC, term ASC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    term: string;
    category: MemoryCategory;
    weight: number;
    source: MemorySource;
    last_seen_at: string;
    meta: string | null;
  }>;

  return rows.map((row) => ({
    term: row.term,
    category: row.category,
    weight: row.weight,
    source: row.source,
    lastSeenAt: row.last_seen_at,
    meta: parseJsonMeta(row.meta),
  }));
}

export function clearUserMemoryTerms(source?: MemorySource): void {
  const db = getDb();
  if (source) {
    db.prepare("DELETE FROM user_memory_terms WHERE source = ?").run(source);
    return;
  }

  db.prepare("DELETE FROM user_memory_terms").run();
}

export function upsertUserMemoryTerms(terms: MemoryTerm[]): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO user_memory_terms (term, category, weight, source, last_seen_at, meta)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(term, category, source) DO UPDATE SET
      weight = excluded.weight,
      last_seen_at = excluded.last_seen_at,
      meta = excluded.meta
  `);

  const transaction = db.transaction((items: MemoryTerm[]) => {
    for (const term of items) {
      insert.run(
        term.term,
        term.category,
        term.weight,
        term.source,
        term.lastSeenAt ?? new Date().toISOString(),
        term.meta ? JSON.stringify(term.meta) : null,
      );
    }
  });

  transaction(terms);
}

export function saveRecommendationSnapshot(
  kind: RecommendationKind,
  snapshotDate: string,
  entries: RecommendationEntry[],
): void {
  const db = getDb();
  const removeExisting = db.prepare(
    "DELETE FROM recommendation_snapshots WHERE kind = ? AND snapshot_date = ?"
  );
  const insert = db.prepare(`
    INSERT INTO recommendation_snapshots (
      kind,
      snapshot_date,
      document_id,
      score,
      rank,
      reason
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    removeExisting.run(kind, snapshotDate);

    entries.forEach((entry, index) => {
      insert.run(
        kind,
        snapshotDate,
        entry.document.id,
        entry.score,
        index + 1,
        JSON.stringify(entry.reason),
      );
    });
  });

  transaction();
}

export function pruneRecommendationSnapshots(
  kind: RecommendationKind,
  earliestSnapshotDateToKeep: string,
): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM recommendation_snapshots WHERE kind = ? AND snapshot_date < ?"
  ).run(kind, earliestSnapshotDateToKeep);
}

export function getRecommendationSnapshot(options: {
  kind: RecommendationKind;
  snapshotDate?: string;
  limit?: number;
}): RecommendationEntry[] {
  const db = getDb();
  const snapshotDate = options.snapshotDate ?? getLatestRecommendationSnapshotDate(options.kind);
  if (!snapshotDate) {
    return [];
  }

  let sql = `
    SELECT document_id, score, rank, reason
    FROM recommendation_snapshots
    WHERE kind = ? AND snapshot_date = ?
    ORDER BY rank ASC
  `;
  const params: (string | number)[] = [options.kind, snapshotDate];

  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as RecommendationSnapshotRow[];
  const results: RecommendationEntry[] = [];

  for (const row of rows) {
    const document = getDocumentById(row.document_id);
    if (!document) {
      continue;
    }

    results.push({
      document,
      score: row.score,
      reason: parseRecommendationReason(row.reason, options.kind),
    });
  }

  return results;
}

export function getLatestRecommendationSnapshotDate(
  kind: RecommendationKind,
): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT snapshot_date FROM recommendation_snapshots WHERE kind = ? ORDER BY snapshot_date DESC LIMIT 1"
  ).get(kind) as { snapshot_date: string } | undefined;

  return row?.snapshot_date ?? null;
}

export function clearRecommendationSnapshots(kind?: RecommendationKind): void {
  const db = getDb();
  if (kind) {
    db.prepare("DELETE FROM recommendation_snapshots WHERE kind = ?").run(kind);
    return;
  }

  db.prepare("DELETE FROM recommendation_snapshots").run();
}

function parseJsonMeta(meta: string | null): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseRecommendationReason(
  reason: string | null,
  kind: RecommendationKind,
): RecommendationReason {
  if (!reason) {
    return { kind, factors: [] };
  }

  try {
    return JSON.parse(reason) as RecommendationReason;
  } catch {
    return { kind, factors: [] };
  }
}
