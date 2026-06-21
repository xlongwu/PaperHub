/**
 * Search evaluation metrics — Recall@K, NDCG@K, MRR@K, Precision@K, zero-result rate.
 *
 * All functions operate on QueryResult arrays and produce average scores
 * across all queries. For queries that return zero results:
 *   - Recall / Precision / NDCG → 0 for that query
 *   - MRR → 0 for that query
 *   - The query still counts toward the zeroResultRate denominator.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single evaluation query with its known relevant documents. */
export interface EvaluationQuery {
  queryId: string;
  query: string;
  language: "zh" | "en";
  relevantDocIds: string[];
  mode: "keyword" | "semantic" | "hybrid";
  category?: string;
  /** Optional per-document relevance grades (3=high, 2=medium, 1=low, 0=not-relevant). */
  relevanceGrades?: Record<string, number>;
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  sources?: string[];
  dateRange?: { start: string; end: string };
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
}

/** Result for one query in an evaluation run. */
export interface QueryResult {
  queryId: string;
  query: string;
  mode: string;
  category?: string;
  results: Array<{ documentId: string; score: number; rank: number }>;
  /** Set of document IDs considered relevant for this query (from EvaluationQuery). */
  relevantDocIds: string[];
  /** Per-document relevance grades (3=high, 2=medium, 1=low). */
  relevanceGrades?: Record<string, number>;
  latencyMs: number;
  metrics: {
    recallAt10: number;
    ndcgAt10: number;
    mrrAt10: number;
    precisionAt5: number;
  };
  zeroResult: boolean;
  constraintViolations?: number;
  allTagMatches?: number;
  mustConceptCoverage?: number;
  relaxedResultCount?: number;
  conjunctive?: boolean;
}

/** Aggregate metrics across all queries. */
export interface SearchMetrics {
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  ndcgAt5: number;
  ndcgAt10: number;
  ndcgAt20: number;
  mrrAt10: number;
  precisionAt5: number;
  zeroResultRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalQueries: number;
  queriesWithResults: number;
  constraintViolationRate: number;
  allTagAccuracy: number;
  conjunctivePrecisionAt5: number;
  mustConceptCoverage: number;
  relaxedResultRatio: number;
}

/** Full evaluation report persisted to disk. */
export interface EvaluationReport {
  timestamp: string;
  engineVersion: "v1" | "v2";
  corpusSize: number;
  metrics: SearchMetrics;
  queries: QueryResult[];
  comparison?: {
    vsBaseline?: Record<string, { before: number; after: number; delta: number }>;
  };
  /** Category breakdown: metrics grouped by query category. */
  categoryBreakdown?: Record<string, SearchMetrics>;
}

// ---------------------------------------------------------------------------
// Core metric functions
// ---------------------------------------------------------------------------

/**
 * Recall@K = |retrieved relevant docs in top K| / |total relevant docs|.
 * Averaged across all queries that have at least one relevant doc.
 */
export function computeRecallAtK(queryResults: QueryResult[], k: number): number {
  const queriesWithRelevant = queryResults.filter((q) => relevantSet(q).size > 0);
  if (queriesWithRelevant.length === 0) return 0;

  const recalls = queriesWithRelevant.map((qr) => {
    const relSet = relevantSet(qr);
    if (relSet.size === 0) return 0;
    const topK = qr.results.slice(0, k).map((r) => r.documentId);
    const found = topK.filter((id) => relSet.has(id)).length;
    return found / relSet.size;
  });

  return recalls.reduce((s, v) => s + v, 0) / recalls.length;
}

/**
 * NDCG@K — Normalized Discounted Cumulative Gain.
 * Uses relevance grades from query annotations (default: 1 if in relevantDocIds, 0 otherwise).
 */
export function computeNDCGAtK(queryResults: QueryResult[], k: number): number {
  const queriesWithRelevant = queryResults.filter((q) => relevantSet(q).size > 0);
  if (queriesWithRelevant.length === 0) return 0;

  const ndcgs = queriesWithRelevant.map((qr) => {
    const grades = relevanceGradesForQuery(qr);
    const idcg = idealDCG(grades, k);
    if (idcg === 0) return 0;

    const topK = qr.results.slice(0, k);
    const dcg = topK.reduce((sum, r, i) => {
      const rel = relevanceGrade(r.documentId, grades);
      return sum + rel / Math.log2(i + 2); // i+2 because rank starts at 1
    }, 0);

    return dcg / idcg;
  });

  return ndcgs.reduce((s, v) => s + v, 0) / ndcgs.length;
}

/**
 * MRR@K — Mean Reciprocal Rank.
 * For each query: RR = 1 / rank_of_first_relevant_doc (0 if none in top K).
 */
export function computeMRRAtK(queryResults: QueryResult[], k: number): number {
  if (queryResults.length === 0) return 0;

  const rrs = queryResults.map((qr) => {
    const relSet = relevantSet(qr);
    if (relSet.size === 0) return 0;

    const topK = qr.results.slice(0, k);
    const firstRelevantIndex = topK.findIndex((r) => relSet.has(r.documentId));
    return firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0;
  });

  return rrs.reduce((s, v) => s + v, 0) / rrs.length;
}

/**
 * Precision@K = |relevant docs in top K| / K.
 */
export function computePrecisionAtK(queryResults: QueryResult[], k: number): number {
  if (queryResults.length === 0) return 0;

  const precisions = queryResults.map((qr) => {
    const relSet = relevantSet(qr);
    if (relSet.size === 0) return 0;
    const topK = qr.results.slice(0, k).map((r) => r.documentId);
    return topK.filter((id) => relSet.has(id)).length / k;
  });

  return precisions.reduce((s, v) => s + v, 0) / precisions.length;
}

/**
 * Zero-result rate = fraction of queries that returned 0 results.
 */
export function computeZeroResultRate(queryResults: QueryResult[]): number {
  if (queryResults.length === 0) return 0;
  const zeros = queryResults.filter((q) => q.zeroResult).length;
  return zeros / queryResults.length;
}

/**
 * Compute metrics for a subset of queries (e.g. Chinese-only).
 */
export function computeMetricsForSubset(
  queryResults: QueryResult[],
  filter: (qr: QueryResult) => boolean,
): SearchMetrics {
  const subset = queryResults.filter(filter);
  return computeAllMetrics(subset);
}

/**
 * Compute all aggregate metrics from a list of per-query results.
 */
export function computeAllMetrics(queryResults: QueryResult[]): SearchMetrics {
  const latencies = queryResults.map((q) => q.latencyMs).sort((a, b) => a - b);
  const nonZero = queryResults.filter((q) => !q.zeroResult);
  const totalResults = queryResults.reduce((sum, result) => sum + result.results.length, 0);
  const constraintViolations = queryResults.reduce(
    (sum, result) => sum + (result.constraintViolations ?? 0),
    0,
  );
  const allTagQueries = queryResults.filter((result) => result.allTagMatches !== undefined);
  const allTagResults = allTagQueries.reduce((sum, result) => sum + result.results.length, 0);
  const allTagMatches = allTagQueries.reduce((sum, result) => sum + (result.allTagMatches ?? 0), 0);
  const conjunctiveQueries = queryResults.filter((result) => result.conjunctive);
  const mustCoverageQueries = queryResults.filter((result) => result.mustConceptCoverage !== undefined);
  const relaxedResultCount = queryResults.reduce((sum, result) => sum + (result.relaxedResultCount ?? 0), 0);

  return {
    recallAt5: computeRecallAtK(queryResults, 5),
    recallAt10: computeRecallAtK(queryResults, 10),
    recallAt20: computeRecallAtK(queryResults, 20),
    ndcgAt5: computeNDCGAtK(queryResults, 5),
    ndcgAt10: computeNDCGAtK(queryResults, 10),
    ndcgAt20: computeNDCGAtK(queryResults, 20),
    mrrAt10: computeMRRAtK(queryResults, 10),
    precisionAt5: computePrecisionAtK(queryResults, 5),
    zeroResultRate: computeZeroResultRate(queryResults),
    avgLatencyMs: latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalQueries: queryResults.length,
    queriesWithResults: nonZero.length,
    constraintViolationRate: totalResults > 0 ? constraintViolations / totalResults : 0,
    allTagAccuracy: allTagResults > 0 ? allTagMatches / allTagResults : 1,
    conjunctivePrecisionAt5:
      conjunctiveQueries.length > 0 ? computeConjunctivePrecisionAt5(conjunctiveQueries) : 1,
    mustConceptCoverage:
      mustCoverageQueries.length > 0
        ? mustCoverageQueries.reduce((sum, result) => sum + (result.mustConceptCoverage ?? 0), 0) /
          mustCoverageQueries.length
        : 1,
    relaxedResultRatio: totalResults > 0 ? relaxedResultCount / totalResults : 0,
  };
}

function computeConjunctivePrecisionAt5(queryResults: QueryResult[]): number {
  const precisions = queryResults.map((result) => {
    const relevant = relevantSet(result);
    const denominator = Math.min(5, relevant.size);
    if (denominator === 0) return 0;
    const relevantResults = result.results.slice(0, 5).filter((item) => relevant.has(item.documentId)).length;
    return relevantResults / denominator;
  });
  return precisions.reduce((sum, value) => sum + value, 0) / precisions.length;
}

/**
 * Compute per-query metrics for a single evaluation query.
 */
export function computeQueryMetrics(
  query: EvaluationQuery,
  resultDocIds: string[],
  k: number,
): QueryResult["metrics"] {
  const relevantSet = new Set(query.relevantDocIds);
  const topK = resultDocIds.slice(0, k);

  // Recall@K
  const found = topK.filter((id) => relevantSet.has(id)).length;
  const recall = relevantSet.size > 0 ? found / relevantSet.size : 0;

  // NDCG@K
  const grades = { ...(query.relevanceGrades ?? {}) };
  for (const id of query.relevantDocIds) {
    if (!(id in grades)) grades[id] = 1;
  }
  const idcg = idealDCGFromSet(relevantSet, grades, k);
  const dcg = topK.reduce((sum, id, i) => sum + relevanceGrade(id, grades) / Math.log2(i + 2), 0);
  const ndcg = idcg > 0 ? dcg / idcg : 0;

  // MRR@K
  const firstIdx = topK.findIndex((id) => relevantSet.has(id));
  const mrr = firstIdx >= 0 ? 1 / (firstIdx + 1) : 0;

  // Precision@K
  const precision = topK.filter((id) => relevantSet.has(id)).length / k;

  return { recallAt10: recall, ndcgAt10: ndcg, mrrAt10: mrr, precisionAt5: precision };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relevantSet(qr: QueryResult): Set<string> {
  return new Set(qr.relevantDocIds ?? []);
}

function relevanceGradesForQuery(qr: QueryResult): Record<string, number> {
  const grades: Record<string, number> = {};
  if (qr.relevanceGrades) {
    Object.assign(grades, qr.relevanceGrades);
  }
  // Default: relevantDocIds get grade 1 if not in relevanceGrades
  for (const id of qr.relevantDocIds ?? []) {
    if (!(id in grades)) grades[id] = 1;
  }
  return grades;
}

function relevanceGrade(docId: string, grades: Record<string, number>): number {
  return grades[docId] ?? 0;
}

/**
 * Compute ideal DCG for sorting all relevant docs with given grades.
 */
function idealDCG(grades: Record<string, number>, k: number): number {
  const sorted = Object.values(grades)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  return sorted.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

function idealDCGFromSet(relevantSet: Set<string>, grades: Record<string, number>, k: number): number {
  const rels: number[] = [];
  for (const id of relevantSet) {
    rels.push(grades[id] ?? 1);
  }
  rels.sort((a, b) => b - a);
  return rels.slice(0, k).reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Compare two metric snapshots and produce per-metric deltas.
 */
export function compareMetrics(
  baseline: SearchMetrics,
  current: SearchMetrics,
): Record<string, { before: number; after: number; delta: number }> {
  const keys: (keyof SearchMetrics)[] = [
    "recallAt5",
    "recallAt10",
    "recallAt20",
    "ndcgAt5",
    "ndcgAt10",
    "ndcgAt20",
    "mrrAt10",
    "precisionAt5",
    "zeroResultRate",
    "constraintViolationRate",
    "allTagAccuracy",
    "conjunctivePrecisionAt5",
    "mustConceptCoverage",
    "relaxedResultRatio",
  ];

  const comparison: Record<string, { before: number; after: number; delta: number }> = {};
  for (const key of keys) {
    const before = baseline[key] as number;
    const after = current[key] as number;
    comparison[key] = { before, after, delta: after - before };
  }

  return comparison;
}
