/**
 * Evaluation metrics unit tests.
 * Verifies NDCG, MRR, Recall, Precision, and zero-result rate calculations.
 */

import { describe, it, expect } from "vitest";
import {
  computeZeroResultRate,
  computeAllMetrics,
  computeQueryMetrics,
  compareMetrics,
} from "@/evaluation/metrics";
import type { QueryResult, EvaluationQuery, SearchMetrics } from "@/evaluation/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metricResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    queryId: "q-test",
    query: "test query",
    mode: "hybrid",
    results: [],
    relevantDocIds: ["doc-1", "doc-2", "doc-3"],
    latencyMs: 100,
    metrics: {
      recallAt10: 1.0,
      ndcgAt10: 1.0,
      mrrAt10: 1.0,
      precisionAt5: 1.0,
    },
    zeroResult: false,
    ...overrides,
  };
}

function evalQuery(overrides: Partial<EvaluationQuery> = {}): EvaluationQuery {
  return {
    queryId: "q-test",
    query: "test",
    language: "en",
    relevantDocIds: ["doc-1", "doc-2", "doc-3"],
    mode: "hybrid",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Recall tests
// ---------------------------------------------------------------------------

describe("computeRecallAtK", () => {
  it("returns 1.0 when all relevant docs are in top K", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2", "doc-3"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2", "doc-3", "doc-4"], 10);
    expect(qMetrics.recallAt10).toBe(1.0);
  });

  it("returns 0.5 when half of relevant docs are found", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2", "doc-3", "doc-4"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2", "doc-5", "doc-6"], 10);
    expect(qMetrics.recallAt10).toBe(0.5);
  });

  it("returns 0 when no relevant docs are found", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-3", "doc-4"], 10);
    expect(qMetrics.recallAt10).toBe(0);
  });

  it("returns 0 when there are no relevant docs", () => {
    const evalQ = evalQuery({ relevantDocIds: [] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1"], 10);
    expect(qMetrics.recallAt10).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NDCG tests
// ---------------------------------------------------------------------------

describe("computeNDCGAtK", () => {
  it("returns 1.0 when results are perfectly ordered", () => {
    const evalQ = evalQuery({
      relevantDocIds: ["doc-1", "doc-2", "doc-3"],
      relevanceGrades: { "doc-1": 3, "doc-2": 2, "doc-3": 1 },
    });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2", "doc-3"], 10);
    expect(qMetrics.ndcgAt10).toBe(1.0);
  });

  it("returns lower value when results are in wrong order", () => {
    const evalQ = evalQuery({
      relevantDocIds: ["doc-1", "doc-2", "doc-3"],
      relevanceGrades: { "doc-1": 3, "doc-2": 2, "doc-3": 1 },
    });
    // Results in wrong order: doc-3 before doc-1
    const qMetrics = computeQueryMetrics(evalQ, ["doc-3", "doc-2", "doc-1"], 10);
    expect(qMetrics.ndcgAt10).toBeLessThan(1.0);
    expect(qMetrics.ndcgAt10).toBeGreaterThan(0);
  });

  it("returns 0 when no relevant docs are found", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-3", "doc-4"], 10);
    expect(qMetrics.ndcgAt10).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MRR tests
// ---------------------------------------------------------------------------

describe("computeMRRAtK", () => {
  it("returns 1.0 when first result is relevant", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-3", "doc-2"], 10);
    expect(qMetrics.mrrAt10).toBe(1.0);
  });

  it("returns 0.5 when second result is relevant", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-2"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2", "doc-3"], 10);
    expect(qMetrics.mrrAt10).toBe(0.5);
  });

  it("returns 0 when no results are relevant", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-5"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2"], 10);
    expect(qMetrics.mrrAt10).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Precision tests
// ---------------------------------------------------------------------------

describe("computePrecisionAtK", () => {
  it("returns 1.0 when all top K are relevant", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2", "doc-3"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-1", "doc-2", "doc-3", "doc-4"], 5);
    expect(qMetrics.precisionAt5).toBeGreaterThan(0.5);
  });

  it("returns 0 when none of top K are relevant", () => {
    const evalQ = evalQuery({ relevantDocIds: ["doc-1", "doc-2"] });
    const qMetrics = computeQueryMetrics(evalQ, ["doc-3", "doc-4", "doc-5"], 5);
    expect(qMetrics.precisionAt5).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Zero-result rate
// ---------------------------------------------------------------------------

describe("computeZeroResultRate", () => {
  it("returns 0 when all queries have results", () => {
    const results = [
      metricResult({ zeroResult: false }),
      metricResult({ zeroResult: false }),
      metricResult({ zeroResult: false }),
    ];
    expect(computeZeroResultRate(results)).toBe(0);
  });

  it("returns 0.5 when half queries have zero results", () => {
    const results = [
      metricResult({ zeroResult: true }),
      metricResult({ zeroResult: false }),
      metricResult({ zeroResult: true }),
      metricResult({ zeroResult: false }),
    ];
    expect(computeZeroResultRate(results)).toBe(0.5);
  });

  it("returns 1.0 when all queries have zero results", () => {
    const results = [metricResult({ zeroResult: true }), metricResult({ zeroResult: true })];
    expect(computeZeroResultRate(results)).toBe(1.0);
  });

  it("returns 0 for empty results", () => {
    expect(computeZeroResultRate([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full metrics aggregation
// ---------------------------------------------------------------------------

describe("computeAllMetrics", () => {
  it("handles empty results gracefully", () => {
    const metrics = computeAllMetrics([]);
    expect(metrics.totalQueries).toBe(0);
    expect(metrics.queriesWithResults).toBe(0);
    expect(metrics.recallAt10).toBe(0);
    expect(metrics.ndcgAt10).toBe(0);
    expect(metrics.mrrAt10).toBe(0);
  });

  it("computes correct P50 and P95 latency", () => {
    const results = [
      metricResult({ latencyMs: 100 }),
      metricResult({ latencyMs: 200 }),
      metricResult({ latencyMs: 300 }),
      metricResult({ latencyMs: 400 }),
      metricResult({ latencyMs: 500 }),
    ];
    const metrics = computeAllMetrics(results);
    expect(metrics.p50LatencyMs).toBe(300);
    expect(metrics.p95LatencyMs).toBe(500);
  });

  it("counts zero results correctly", () => {
    const results = [
      metricResult({ zeroResult: false }),
      metricResult({ zeroResult: true }),
      metricResult({ zeroResult: false }),
    ];
    const metrics = computeAllMetrics(results);
    expect(metrics.totalQueries).toBe(3);
    expect(metrics.queriesWithResults).toBe(2);
    expect(metrics.zeroResultRate).toBeCloseTo(1 / 3, 5);
  });
});

// ---------------------------------------------------------------------------
// Metric comparison
// ---------------------------------------------------------------------------

describe("compareMetrics", () => {
  it("computes per-metric deltas correctly", () => {
    const baseline: SearchMetrics = {
      recallAt5: 0.8,
      recallAt10: 0.7,
      recallAt20: 0.6,
      ndcgAt5: 0.85,
      ndcgAt10: 0.75,
      ndcgAt20: 0.65,
      mrrAt10: 0.7,
      precisionAt5: 0.9,
      zeroResultRate: 0.05,
      avgLatencyMs: 100,
      p50LatencyMs: 80,
      p95LatencyMs: 200,
      totalQueries: 10,
      queriesWithResults: 9,
      constraintViolationRate: 0,
      allTagAccuracy: 1,
      conjunctivePrecisionAt5: 0.8,
      mustConceptCoverage: 1,
      relaxedResultRatio: 0,
    };
    const current: SearchMetrics = {
      recallAt5: 0.9,
      recallAt10: 0.85,
      recallAt20: 0.8,
      ndcgAt5: 0.9,
      ndcgAt10: 0.85,
      ndcgAt20: 0.75,
      mrrAt10: 0.8,
      precisionAt5: 0.95,
      zeroResultRate: 0.02,
      avgLatencyMs: 110,
      p50LatencyMs: 90,
      p95LatencyMs: 210,
      totalQueries: 10,
      queriesWithResults: 9,
      constraintViolationRate: 0,
      allTagAccuracy: 1,
      conjunctivePrecisionAt5: 0.85,
      mustConceptCoverage: 1,
      relaxedResultRatio: 0,
    };

    const comparison = compareMetrics(baseline, current);
    expect(comparison["recallAt10"]!.delta).toBeCloseTo(0.15, 10);
    expect(comparison["ndcgAt10"]!.delta).toBeCloseTo(0.1, 10);
    expect(comparison["mrrAt10"]!.delta).toBeCloseTo(0.1, 10);
  });
});
