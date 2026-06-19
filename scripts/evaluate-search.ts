#!/usr/bin/env tsx
/**
 * PaperHub Search Evaluation Script
 *
 * Runs a fixed set of evaluation queries against the search engine and
 * reports standard IR metrics: Recall@K, NDCG@K, MRR@K, Precision@K,
 * zero-result rate, and latency percentiles.
 *
 * Usage:
 *   npx tsx scripts/evaluate-search.ts [--engine v1|v2] [--corpus phase6] [--save] [--compare]
 *
 * Options:
 *   --engine v1|v2    Search engine version (default: v1)
 *   --corpus phase6   Corpus type (default: phase6)
 *   --save            Save the report to .tmp/evaluation/
 *   --compare         Compare against last saved baseline
 *   --verbose         Print per-query metrics
 */

import fs from "node:fs";
import path from "node:path";
import { ensureCorpus, indexCorpusVectors, loadSearchQueries, runEvaluationQueries } from "@/evaluation/index";
import { computeAllMetrics, compareMetrics, computeMetricsForSubset } from "@/evaluation/metrics";
import type { EvaluationReport, SearchMetrics } from "@/evaluation/metrics";
import { getIndexStateStats } from "@/db/search";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  engine: "v1" | "v2";
  corpus: string;
  save: boolean;
  compare: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  return {
    engine: (argv.includes("--engine") ? argv[argv.indexOf("--engine") + 1] : "v2") as "v1" | "v2",
    corpus: argv.includes("--corpus") ? argv[argv.indexOf("--corpus") + 1]! : "full",
    save: argv.includes("--save"),
    compare: argv.includes("--compare"),
    verbose: argv.includes("--verbose"),
  };
}

// ---------------------------------------------------------------------------
// Report persistence
// ---------------------------------------------------------------------------

const REPORT_DIR = path.resolve(process.cwd(), ".tmp", "evaluation");
const BASELINE_FILE = path.join(REPORT_DIR, "baseline.json");

function saveReport(report: EvaluationReport, engine: string): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = path.join(REPORT_DIR, `report-${engine}-${report.timestamp.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[eval] Report saved: ${filename}`);

  // Also save as latest
  const latestFile = path.join(REPORT_DIR, `latest-${engine}.json`);
  fs.writeFileSync(latestFile, JSON.stringify(report, null, 2), "utf-8");
}

function loadBaseline(): EvaluationReport | null {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as EvaluationReport;
    }
  } catch {
    // Baseline not available
  }
  return null;
}

function saveBaseline(report: EvaluationReport): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[eval] Baseline saved: ${BASELINE_FILE}`);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatPct(value: number, decimals = 4): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function printSeparator(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}`);
}

function printMetrics(metrics: SearchMetrics): void {
  console.log(`  Recall@5:              ${formatPct(metrics.recallAt5)}`);
  console.log(`  Recall@10:             ${formatPct(metrics.recallAt10)}`);
  console.log(`  Recall@20:             ${formatPct(metrics.recallAt20)}`);
  console.log(`  NDCG@5:                ${formatPct(metrics.ndcgAt5)}`);
  console.log(`  NDCG@10:               ${formatPct(metrics.ndcgAt10)}`);
  console.log(`  NDCG@20:               ${formatPct(metrics.ndcgAt20)}`);
  console.log(`  MRR@10:                ${formatPct(metrics.mrrAt10)}`);
  console.log(`  Precision@5:           ${formatPct(metrics.precisionAt5)}`);
  console.log(`  Zero-result rate:      ${formatPct(metrics.zeroResultRate)}`);
  console.log(`  Avg latency:           ${formatMs(metrics.avgLatencyMs)}`);
  console.log(`  P50 latency:           ${formatMs(metrics.p50LatencyMs)}`);
  console.log(`  P95 latency:           ${formatMs(metrics.p95LatencyMs)}`);
  console.log(`  Total queries:         ${metrics.totalQueries}`);
  console.log(`  Queries with results:  ${metrics.queriesWithResults}`);
}

function printComparison(
  comparison: Record<string, { before: number; after: number; delta: number }>,
): void {
  console.log(`\n  Metric                  Before      After       Delta`);
  console.log(`  ${"-".repeat(56)}`);
  for (const [key, vals] of Object.entries(comparison)) {
    const sign = vals.delta >= 0 ? "+" : "";
    const deltaStr = `${sign}${(vals.delta * 100).toFixed(2)}%`;
    console.log(
      `  ${key.padEnd(24)} ${formatPct(vals.before).padEnd(12)} ${formatPct(vals.after).padEnd(12)} ${deltaStr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`[eval] PaperHub Search Evaluation`);
  console.log(`[eval] Engine: ${args.engine}  Corpus: ${args.corpus}`);

  // 1. Seed corpus
  printSeparator("Step 1: Seed Corpus");
  const corpus = ensureCorpus(args.corpus as "phase6" | "full");
  console.log(`[eval] Corpus seeded: ${corpus.size} documents`);

  // 2. Index vectors (mock)
  printSeparator("Step 2: Index Vectors");
  const vectorCount = await indexCorpusVectors();
  console.log(`[eval] Vectors indexed: ${vectorCount}`);

  // 3. Load queries
  printSeparator("Step 3: Load Queries");
  const queries = loadSearchQueries(undefined, args.corpus as "phase6" | "full");
  console.log(`[eval] Loaded ${queries.length} evaluation queries`);

  // 4. Run evaluation
  printSeparator("Step 4: Run Evaluation");
  const queryResults = await runEvaluationQueries(queries, args.engine);

  if (args.verbose) {
    for (const qr of queryResults) {
      const status = qr.zeroResult ? "ZERO" : `${qr.results.length} results`;
      console.log(
        `  [${qr.queryId}] "${qr.query}" → ${status} (${qr.latencyMs}ms) ` +
        `R@10=${formatPct(qr.metrics.recallAt10)} NDCG@10=${formatPct(qr.metrics.ndcgAt10)}`,
      );
    }
  }

  // 5. Compute metrics
  printSeparator("Step 5: Aggregate Metrics");
  const metrics = computeAllMetrics(queryResults);
  const keywordMetrics = computeMetricsForSubset(
    queryResults,
    (result) => result.mode === "keyword",
  );

  // Category breakdown
  const chineseQueries = queryResults.filter(
    (_, i) => queries[i]?.language === "zh",
  );
  const chineseMetrics = chineseQueries.length > 0 ? computeAllMetrics(chineseQueries) : null;
  const categoryBreakdown = Object.fromEntries(
    [...new Set(queryResults.map((result) => result.category).filter(Boolean))]
      .sort()
      .map((category) => [
        category!,
        computeMetricsForSubset(queryResults, (result) => result.category === category),
      ]),
  );

  printMetrics(metrics);

  if (chineseMetrics) {
    console.log(`\n  --- Chinese Queries (${chineseQueries.length}) ---`);
    printMetrics(chineseMetrics);
  }

  // 6. Build report
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: EvaluationReport = {
    timestamp,
    engineVersion: args.engine,
    corpusSize: corpus.size,
    metrics,
    queries: queryResults,
    categoryBreakdown: {
      ...categoryBreakdown,
      ...(chineseMetrics ? { chinese: chineseMetrics } : {}),
    },
  };

  // 7. Compare with baseline
  let baselineReport: EvaluationReport | null = null;
  if (args.compare) {
    printSeparator("Step 6: Baseline Comparison");
    baselineReport = loadBaseline();
    if (baselineReport) {
      report.comparison = { vsBaseline: compareMetrics(baselineReport.metrics, metrics) };
      printComparison(report.comparison.vsBaseline!);
    } else {
      console.log(`  No baseline found. Run with --save to create one.`);
    }
  }

  // 8. Save
  if (args.save) {
    saveReport(report, args.engine);
    if (!args.compare) {
      saveBaseline(report);
    }
  }

  // 9. Quality gate check
  printSeparator("Quality Gate Check");
  const gates = checkQualityGates(
    metrics,
    chineseMetrics,
    keywordMetrics,
    getIndexStateStats(),
  );
  if (baselineReport) {
    gates.push({
      name: "Recall@20 improves >= 15% or preserves ceiling baseline",
      actual: formatPct(metrics.recallAt20 - baselineReport.metrics.recallAt20),
      threshold: "15.00% (or no regression when baseline >= 90%)",
      pass:
        metrics.recallAt20 - baselineReport.metrics.recallAt20 >= 0.15 ||
        (baselineReport.metrics.recallAt20 >= 0.9 &&
          metrics.recallAt20 >= baselineReport.metrics.recallAt20),
    });
    for (const [category, current] of Object.entries(categoryBreakdown)) {
      const previous = baselineReport.categoryBreakdown?.[category];
      if (!previous) continue;
      const delta = current.ndcgAt10 - previous.ndcgAt10;
      gates.push({
        name: `${category} NDCG@10 regression <= 0.02`,
        actual: `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`,
        threshold: ">= -2.00%",
        pass: delta >= -0.02,
      });
    }
  }
  for (const gate of gates) {
    const icon = gate.pass ? "✅" : "❌";
    console.log(`  ${icon} ${gate.name}: ${gate.actual} (threshold: ${gate.threshold})`);
  }
  const allPassed = gates.every((g) => g.pass);
  console.log(`\n  ${allPassed ? "✅ All gates passed!" : "❌ Some gates failed."}`);

  if (!allPassed && args.save) {
    const failedGates = gates.filter((g) => !g.pass);
    console.log(`\n  Failed gates:`);
    for (const gate of failedGates) {
      console.log(`    - ${gate.name}: ${gate.actual} (need ${gate.threshold})`);
    }
  }
  if (!allPassed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Quality gate definitions
// ---------------------------------------------------------------------------

interface QualityGate {
  name: string;
  actual: string;
  threshold: string;
  pass: boolean;
}

function checkQualityGates(
  metrics: SearchMetrics,
  chineseMetrics: SearchMetrics | null,
  keywordMetrics: SearchMetrics,
  indexStats: ReturnType<typeof getIndexStateStats>,
): QualityGate[] {
  return [
    {
      name: "Recall@20 >= 0.90",
      actual: formatPct(metrics.recallAt20),
      threshold: "90.00%",
      pass: metrics.recallAt20 >= 0.90,
    },
    {
      name: "NDCG@10 >= 0.80",
      actual: formatPct(metrics.ndcgAt10),
      threshold: "80.00%",
      pass: metrics.ndcgAt10 >= 0.80,
    },
    {
      name: "MRR@10 >= 0.75",
      actual: formatPct(metrics.mrrAt10),
      threshold: "75.00%",
      pass: metrics.mrrAt10 >= 0.75,
    },
    {
      name: "Precision@5 >= 0.80",
      actual: formatPct(metrics.precisionAt5),
      threshold: "80.00%",
      pass: metrics.precisionAt5 >= 0.80,
    },
    {
      name: "Zero-result rate <= 2%",
      actual: formatPct(metrics.zeroResultRate),
      threshold: "2.00%",
      pass: metrics.zeroResultRate <= 0.02,
    },
    {
      name: "Chinese Recall@20 >= 0.85",
      actual: chineseMetrics ? formatPct(chineseMetrics.recallAt20) : "N/A",
      threshold: "85.00%",
      pass: chineseMetrics ? chineseMetrics.recallAt20 >= 0.85 : true,
    },
    {
      name: "FTS coverage = 100%",
      actual: `${indexStats.ftsIndexed}/${indexStats.total}`,
      threshold: `${indexStats.total}/${indexStats.total}`,
      pass: indexStats.ftsIndexed === indexStats.total,
    },
    {
      name: "Vector coverage = 100%",
      actual: `${indexStats.vectorIndexed}/${indexStats.total}`,
      threshold: `${indexStats.total}/${indexStats.total}`,
      pass: indexStats.vectorIndexed === indexStats.total,
    },
    {
      name: "Keyword P95 <= 250ms",
      actual: formatMs(keywordMetrics.p95LatencyMs),
      threshold: "250ms",
      pass: keywordMetrics.p95LatencyMs <= 250,
    },
  ];
}

main().catch((e) => {
  console.error("[eval] Fatal error:", e);
  process.exit(1);
});
