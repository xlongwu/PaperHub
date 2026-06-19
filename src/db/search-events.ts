import crypto from "node:crypto";
import { getDb } from "./index";

export function hashSearchQuery(query: string): string {
  return crypto.createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export function recordSearchEvent(input: {
  query: string;
  mode: string;
  modeUsed: string;
  resultCount: number;
  latencyMs: number;
}): number {
  const result = getDb()
    .prepare(
      `
      INSERT INTO search_events(
        query_hash, mode, mode_used, result_count, latency_ms, degraded
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      hashSearchQuery(input.query),
      input.mode,
      input.modeUsed,
      input.resultCount,
      input.latencyMs,
      input.modeUsed === "keyword_fallback" ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

export function recordSearchClick(input: { eventId: number; documentId: string; rank: number }): void {
  getDb()
    .prepare(
      `
      UPDATE search_events
      SET clicked_document_id = ?, clicked_rank = ?
      WHERE id = ?
    `,
    )
    .run(input.documentId, input.rank, input.eventId);
}

export function markSearchReformulated(eventId: number): void {
  getDb().prepare("UPDATE search_events SET reformulated = 1 WHERE id = ?").run(eventId);
}

export function getSearchQualityStats(): {
  searches: number;
  zeroResultRate: number;
  openRate: number;
  top3ClickRate: number;
  reformulationRate: number;
  p95LatencyMs: number;
  degradationRate: number;
} {
  const rows = getDb()
    .prepare(
      `
      SELECT result_count, clicked_rank, reformulated, latency_ms, degraded
      FROM search_events
      ORDER BY id DESC
      LIMIT 1000
    `,
    )
    .all() as Array<{
    result_count: number;
    clicked_rank: number | null;
    reformulated: number;
    latency_ms: number;
    degraded: number;
  }>;

  if (rows.length === 0) {
    return {
      searches: 0,
      zeroResultRate: 0,
      openRate: 0,
      top3ClickRate: 0,
      reformulationRate: 0,
      p95LatencyMs: 0,
      degradationRate: 0,
    };
  }

  const ratio = (predicate: (row: (typeof rows)[number]) => boolean): number =>
    rows.filter(predicate).length / rows.length;
  const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);

  return {
    searches: rows.length,
    zeroResultRate: ratio((row) => row.result_count === 0),
    openRate: ratio((row) => row.clicked_rank !== null),
    top3ClickRate: ratio((row) => row.clicked_rank !== null && row.clicked_rank <= 3),
    reformulationRate: ratio((row) => row.reformulated === 1),
    p95LatencyMs: latencies[p95Index] ?? 0,
    degradationRate: ratio((row) => row.degraded === 1),
  };
}
