import { getDb } from "./index";

export type WebSearchUsageEventType =
  | "search"
  | "result_open"
  | "summary_synthesis"
  | "summary_result"
  | "save"
  | "favorite"
  | "pdf_download"
  | "aggregation";

export interface WebSearchMetricsReport {
  range: { from: string; to: string };
  providers: Array<{
    providerId: string;
    calls: number;
    successRate: number;
    timeoutRate: number;
    rateLimitRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    resultCount: number;
    estimatedCredits: number;
    cacheHitRate: number;
  }>;
  aggregation: {
    sessions: number;
    rawResults: number;
    deduplicatedResults: number;
    dedupRatio: number;
    multiProviderResultRate: number;
  };
  summaries: {
    attempts: number;
    successRate: number;
    p95LatencyMs: number;
    citationMappingAccuracy: number;
    uncitedClaims: number;
    evidenceInsufficient: number;
    estimatedTokens: number;
  };
  usage: {
    searches: number;
    resultOpens: number;
    deepSummaries: number;
    saves: number;
    favorites: number;
    pdfDownloads: number;
    partialSessionRate: number;
    noResultRate: number;
  };
}

export function recordWebSearchUsageEvent(input: {
  sessionId?: string;
  eventType: WebSearchUsageEventType;
  success?: boolean;
  durationMs?: number;
  estimatedTokens?: number;
  metadata?: Record<string, number | boolean | string>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO web_search_usage_events(
         session_id, event_type, success, duration_ms, estimated_tokens,
         metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId ?? null,
      input.eventType,
      input.success === false ? 0 : 1,
      input.durationMs ?? null,
      input.estimatedTokens ?? null,
      JSON.stringify(input.metadata ?? {}),
      new Date().toISOString(),
    );
}

export function getWebSearchMetrics(from: string, to: string): WebSearchMetricsReport {
  const providerRows = getDb()
    .prepare(
      `SELECT provider_id, status, result_count, latency_ms, estimated_credits, request_id
       FROM web_search_provider_runs
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(from, to) as Array<{
    provider_id: string;
    status: string;
    result_count: number;
    latency_ms: number | null;
    estimated_credits: number | null;
    request_id: string | null;
  }>;
  const providers = [...new Set(providerRows.map((row) => row.provider_id))]
    .sort()
    .map((providerId) => {
      const rows = providerRows.filter((row) => row.provider_id === providerId);
      const latencies = rows
        .map((row) => row.latency_ms)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      return {
        providerId,
        calls: rows.length,
        successRate: ratio(rows, (row) => row.status === "success" || row.status === "partial"),
        timeoutRate: ratio(rows, (row) => row.status === "timeout"),
        rateLimitRate: ratio(rows, (row) => row.status === "rate_limited"),
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        resultCount: rows.reduce((sum, row) => sum + row.result_count, 0),
        estimatedCredits: rows.reduce(
          (sum, row) => sum + (row.estimated_credits ?? 0),
          0,
        ),
        cacheHitRate: ratio(rows, (row) => row.request_id?.startsWith("cache:") === true),
      };
    });

  const events = getDb()
    .prepare(
      `SELECT event_type, success, duration_ms, estimated_tokens, metadata_json
       FROM web_search_usage_events
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(from, to) as Array<{
    event_type: WebSearchUsageEventType;
    success: number;
    duration_ms: number | null;
    estimated_tokens: number | null;
    metadata_json: string;
  }>;
  const aggregationEvents = events.filter((event) => event.event_type === "aggregation");
  const aggregationMetadata = aggregationEvents.map(readMetadata);
  const summaryEvents = events.filter(
    (event) =>
      event.event_type === "summary_synthesis" || event.event_type === "summary_result",
  );
  const summaryDurations = summaryEvents
    .map((event) => event.duration_ms)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const summaryMetadata = summaryEvents.map(readMetadata);
  const sessionRows = getDb()
    .prepare(
      `SELECT status,
              (SELECT COUNT(*) FROM web_search_results r WHERE r.session_id = s.id) AS result_count
       FROM web_search_sessions s
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(from, to) as Array<{ status: string; result_count: number }>;
  const citedClaims = sumMetadata(summaryMetadata, "citedClaims");
  const uncitedClaims = sumMetadata(summaryMetadata, "uncitedClaims");

  return {
    range: { from, to },
    providers,
    aggregation: {
      sessions: aggregationEvents.length,
      rawResults: sumMetadata(aggregationMetadata, "rawResults"),
      deduplicatedResults: sumMetadata(aggregationMetadata, "deduplicatedResults"),
      dedupRatio: safeRatio(
        sumMetadata(aggregationMetadata, "rawResults") -
          sumMetadata(aggregationMetadata, "deduplicatedResults"),
        sumMetadata(aggregationMetadata, "rawResults"),
      ),
      multiProviderResultRate: safeRatio(
        sumMetadata(aggregationMetadata, "multiProviderResults"),
        sumMetadata(aggregationMetadata, "deduplicatedResults"),
      ),
    },
    summaries: {
      attempts: summaryEvents.length,
      successRate: ratio(summaryEvents, (event) => event.success === 1),
      p95LatencyMs: percentile(summaryDurations, 0.95),
      citationMappingAccuracy: safeRatio(citedClaims, citedClaims + uncitedClaims),
      uncitedClaims,
      evidenceInsufficient: sumMetadata(summaryMetadata, "evidenceInsufficient"),
      estimatedTokens: summaryEvents.reduce(
        (sum, event) => sum + (event.estimated_tokens ?? 0),
        0,
      ),
    },
    usage: {
      searches: countEvents(events, "search"),
      resultOpens: countEvents(events, "result_open"),
      deepSummaries: countEvents(events, "summary_result"),
      saves: countEvents(events, "save"),
      favorites: countEvents(events, "favorite"),
      pdfDownloads: countEvents(events, "pdf_download"),
      partialSessionRate: ratio(sessionRows, (row) => row.status === "partial"),
      noResultRate: ratio(sessionRows, (row) => row.result_count === 0),
    },
  };
}

function readMetadata(row: { metadata_json: string }): Record<string, unknown> {
  try {
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sumMetadata(rows: Record<string, unknown>[], key: string): number {
  return rows.reduce((sum, row) => {
    const value = row[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function countEvents(
  events: Array<{ event_type: WebSearchUsageEventType }>,
  type: WebSearchUsageEventType,
): number {
  return events.filter((event) => event.event_type === type).length;
}

function ratio<T>(rows: T[], predicate: (row: T) => boolean): number {
  return rows.length === 0 ? 0 : rows.filter(predicate).length / rows.length;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)] ?? 0;
}
