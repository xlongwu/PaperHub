#!/usr/bin/env tsx
/**
 * arXiv historical backfill script.
 *
 * Fetches papers from config-driven arXiv categories by date range
 * with checkpoint support for resumption.
 *
 * Usage:
 *   npx tsx scripts/backfill-arxiv.ts --from 2026-01-01 --to 2026-06-01
 *   npx tsx scripts/backfill-arxiv.ts --from 2024-06-01 --to 2026-06-01 --resume
 *   npx tsx scripts/backfill-arxiv.ts --days 30  (last 30 days)
 */

import fs from "node:fs";
import path from "node:path";
import { fetchArxivData } from "@/arxiv";
import { ingestDocuments } from "@/services/document-ingestion";
import { processPending } from "@/search-indexer";
import { loadPaperHubConfig } from "@/config";
import { initDatabase, closeDb } from "@/db/index";
import type { RawDocument } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackfillState {
  lastDate: string;
  lastCategory: string;
  lastStartIndex: number;
  processed: number;
  inserted: number;
  skipped: number;
  errors: number;
  totalCategories: number;
  categories: string[];
}

interface CliArgs {
  from?: string;
  to?: string;
  days?: number;
  resume: boolean;
  indexVectors: boolean;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

const STATE_FILE = path.resolve(process.cwd(), ".tmp", "backfill-state.json");

function loadState(): BackfillState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as BackfillState;
    }
  } catch {
    // Corrupted state — start fresh
  }
  return null;
}

function saveState(state: BackfillState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function clearState(): void {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { resume: false, indexVectors: true };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) result.from = args[++i]!;
    else if (args[i] === "--to" && args[i + 1]) result.to = args[++i]!;
    else if (args[i] === "--days" && args[i + 1]) result.days = parseInt(args[++i]!);
    else if (args[i] === "--resume") result.resume = true;
    else if (args[i] === "--no-index") result.indexVectors = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// ArXiv paper → RawDocument mapping
// ---------------------------------------------------------------------------

function mapArxivPaper(paper: { id: string; title: string; summary: string; authors: string[]; published: string; updated: string; categories: string[]; url: string; pdfUrl: string }): RawDocument {
  return {
    title: paper.title,
    source: "arxiv",
    url: paper.url,
    publishedAt: paper.published,
    authors: paper.authors,
    abstract: paper.summary,
    language: "en",
    metadata: {
      categories: paper.categories,
      pdfUrl: paper.pdfUrl,
      updated: paper.updated,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // Resolve date range
  const now = new Date();
  const toDate = args.to || now.toISOString().slice(0, 10);
  const fromDate = args.from || (
    args.days
      ? new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );

  console.log(`[backfill] Date range: ${fromDate} → ${toDate}`);
  console.log(`[backfill] Resume: ${args.resume}`);

  // Init database
  initDatabase();
  const config = loadPaperHubConfig();
  const categories = config.arxivCategories;

  // Load or create state
  let state: BackfillState;
  if (args.resume) {
    const saved = loadState();
    if (saved) {
      state = saved;
      console.log(`[backfill] Resumed from: ${state.lastDate}, cat=${state.lastCategory}, processed=${state.processed}`);
    } else {
      console.log(`[backfill] No saved state found. Starting fresh.`);
      state = newFreshState(categories, toDate);
    }
  } else {
    clearState();
    state = newFreshState(categories, toDate);
  }

  // Iterate from new to old
  let currentDate = new Date(state.lastDate);
  const endDate = new Date(fromDate);

  while (currentDate >= endDate) {
    const dateStr = currentDate.toISOString().slice(0, 10);

    for (const cat of state.categories) {
      // Checkpoint: save state before each category fetch
      state.lastDate = dateStr;
      state.lastCategory = cat;
      saveState(state);

      try {
        console.log(`[backfill] Fetching ${cat} for ${dateStr}...`);
        const data = await fetchArxivData({
          categories: [cat],
          fromDate: dateStr,
          toDate: dateStr,
          maxResults: config.arxivMaxResults,
          maxPages: 20,
        });

        if (!data.fetchSuccess || data.papers.length === 0) continue;

        const rawDocs = data.papers.map(mapArxivPaper);
        const result = await ingestDocuments(rawDocs);

        state.processed += data.papers.length;
        state.inserted += result.inserted;
        state.skipped += result.skipped;
        state.errors += result.errors;

        console.log(
          `[backfill] ${cat} ${dateStr}: ${result.inserted} new, ${result.skipped} dup, ${result.errors} err (total: ${state.inserted})`,
        );

        // ArXiv rate limit: 3s between requests
        await sleep(3500);
      } catch (e) {
        console.error(`[backfill] Error for ${cat} ${dateStr}:`, e);
        state.errors++;
        saveState(state);
      }
    }

    // Move to previous day
    currentDate.setDate(currentDate.getDate() - 1);
  }

  // Final save
  saveState(state);
  console.log(`\n[backfill] Complete!`);
  console.log(`  Processed: ${state.processed}  Inserted: ${state.inserted}  Skipped: ${state.skipped}  Errors: ${state.errors}`);

  // Trigger vector indexing
  if (args.indexVectors && state.inserted > 0) {
    console.log(`\n[backfill] Starting vector indexing for ${state.inserted} new documents...`);
    const indexed = await processPending(state.inserted);
    console.log(`[backfill] Vector indexed: ${indexed}`);
  }

  closeDb();
}

function newFreshState(categories: string[], toDate: string): BackfillState {
  return {
    lastDate: toDate,
    lastCategory: categories[0]!,
    lastStartIndex: 0,
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
    totalCategories: categories.length,
    categories,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("[backfill] Fatal error:", e);
  process.exit(1);
});
