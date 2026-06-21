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
  queryType?: string;
  resultDocumentIds?: string[];
}): number {
  const db = getDb();
  const write = db.transaction(() => {
    const result = db
      .prepare(
        `
        INSERT INTO search_events(
          query_hash, mode, mode_used, result_count, latency_ms, degraded, query_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        hashSearchQuery(input.query),
        input.mode,
        input.modeUsed,
        input.resultCount,
        input.latencyMs,
        input.modeUsed === "keyword_fallback" ? 1 : 0,
        input.queryType ?? "unknown",
      );
    const eventId = Number(result.lastInsertRowid);
    const insertResult = db.prepare(
      `INSERT INTO search_event_results(event_id, document_id, rank)
       VALUES (?, ?, ?)`,
    );
    input.resultDocumentIds?.slice(0, 20).forEach((documentId, index) => {
      insertResult.run(eventId, documentId, index + 1);
    });
    return eventId;
  });
  return write();
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
  noClickRate: number;
  top3ClickRate: number;
  clickMrr: number;
  reformulationRate: number;
  p95LatencyMs: number;
  degradationRate: number;
  byQueryType: Record<
    string,
    {
      searches: number;
      noClickRate: number;
      reformulationRate: number;
      clickMrr: number;
    }
  >;
  failureQueries: Array<{
    queryHash: string;
    queryType: string;
    failures: number;
  }>;
  hardNegativeDocumentIds: string[];
} {
  const rows = getDb()
    .prepare(
      `
      SELECT id, query_hash, result_count, clicked_rank, reformulated,
             latency_ms, degraded, query_type
      FROM search_events
      ORDER BY id DESC
      LIMIT 1000
    `,
    )
    .all() as Array<{
    id: number;
    query_hash: string;
    result_count: number;
    clicked_rank: number | null;
    reformulated: number;
    latency_ms: number;
    degraded: number;
    query_type: string;
  }>;

  if (rows.length === 0) {
    return {
      searches: 0,
      zeroResultRate: 0,
      openRate: 0,
      noClickRate: 0,
      top3ClickRate: 0,
      clickMrr: 0,
      reformulationRate: 0,
      p95LatencyMs: 0,
      degradationRate: 0,
      byQueryType: {},
      failureQueries: [],
      hardNegativeDocumentIds: [],
    };
  }

  const ratio = (predicate: (row: (typeof rows)[number]) => boolean): number =>
    rows.filter(predicate).length / rows.length;
  const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
  const clickMrr = (items: typeof rows): number =>
    items.length > 0
      ? items.reduce((sum, row) => sum + (row.clicked_rank ? 1 / row.clicked_rank : 0), 0) / items.length
      : 0;
  const byQueryType = Object.fromEntries(
    [...new Set(rows.map((row) => row.query_type))].map((queryType) => {
      const items = rows.filter((row) => row.query_type === queryType);
      return [
        queryType,
        {
          searches: items.length,
          noClickRate: items.filter((row) => row.clicked_rank === null).length / items.length,
          reformulationRate: items.filter((row) => row.reformulated === 1).length / items.length,
          clickMrr: clickMrr(items),
        },
      ];
    }),
  );
  const failedRows = rows.filter((row) => row.clicked_rank === null || row.reformulated === 1);
  const failureCounts = new Map<string, { queryHash: string; queryType: string; failures: number }>();
  for (const row of failedRows) {
    const key = `${row.query_hash}:${row.query_type}`;
    const current = failureCounts.get(key) ?? {
      queryHash: row.query_hash,
      queryType: row.query_type,
      failures: 0,
    };
    current.failures++;
    failureCounts.set(key, current);
  }
  const failureQueries = [...failureCounts.values()]
    .sort((left, right) => right.failures - left.failures)
    .slice(0, 20);
  const failedEventIds = failedRows.map((row) => row.id);
  const hardNegativeDocumentIds =
    failedEventIds.length > 0
      ? (
          getDb()
            .prepare(
              `SELECT document_id, COUNT(*) AS occurrences
               FROM search_event_results
               WHERE event_id IN (${failedEventIds.map(() => "?").join(",")})
               GROUP BY document_id
               ORDER BY occurrences DESC, MIN(rank), document_id
               LIMIT 50`,
            )
            .all(...failedEventIds) as Array<{
            document_id: string;
            occurrences: number;
          }>
        ).map((row) => row.document_id)
      : [];

  return {
    searches: rows.length,
    zeroResultRate: ratio((row) => row.result_count === 0),
    openRate: ratio((row) => row.clicked_rank !== null),
    noClickRate: ratio((row) => row.clicked_rank === null),
    top3ClickRate: ratio((row) => row.clicked_rank !== null && row.clicked_rank <= 3),
    clickMrr: clickMrr(rows),
    reformulationRate: ratio((row) => row.reformulated === 1),
    p95LatencyMs: latencies[p95Index] ?? 0,
    degradationRate: ratio((row) => row.degraded === 1),
    byQueryType,
    failureQueries,
    hardNegativeDocumentIds,
  };
}
