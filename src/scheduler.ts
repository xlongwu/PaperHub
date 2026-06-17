/**
 * Scheduler — runs collection jobs on cron schedules using node-cron.
 * Integrates all three collectors + tag classification + summarization.
 */

import cron from "node-cron";
import { loadPaperHubConfig, getLogsDir } from "@/config";
import { arxivCollector } from "@/collectors/arxiv";
import { gptBlogCollector } from "@/collectors/gpt-blog";
import { claudeBlogCollector } from "@/collectors/claude-blog";
import { rawToDocument } from "@/collectors/transformer";
import { insertDocument, documentExists, getPendingSummaryDocuments } from "@/db/documents";
import { updateTagStatsForDocument } from "@/db/tags";
import { withRetry, logError } from "@/utils/retry";
import { findDuplicateByTitle } from "@/utils/dedup";
import { applyDocumentTags } from "@/tagger/apply";
import { summarizeBatch } from "@/summarizer";
import fs from "node:fs";
import path from "node:path";
import { rebuildUserMemoryFromDigests, refreshHotRecommendations } from "@/recommendation";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const tasks: cron.ScheduledTask[] = [];
const config = loadPaperHubConfig();

/** Track in-flight async work so stopScheduler can await completion. */
const runningPromises = new Set<Promise<unknown>>();

function track<T>(promise: Promise<T>): Promise<T> {
  runningPromises.add(promise);
  void promise.finally(() => runningPromises.delete(promise));
  return promise;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logScheduler(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());

  try {
    const file = path.join(getLogsDir(), "scheduler.log");
    fs.appendFileSync(file, line, "utf-8");
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Collection runner
// ---------------------------------------------------------------------------

async function runCollector(collector: typeof arxivCollector): Promise<{ inserted: number; source: string }> {
  logScheduler(`[scheduler] Running ${collector.id} collection...`);

  try {
    const rawDocs = await withRetry(() => collector.fetch(), {
      maxRetries: 3,
      baseDelayMs: 1000,
      onRetry: (attempt, error, delay) => {
        logScheduler(`[scheduler] ${collector.id} retry ${attempt}/3 after ${delay}ms: ${error}`);
      },
    });

    let inserted = 0;
    for (const raw of rawDocs) {
      const doc = rawToDocument(raw);
      if (documentExists(doc.url) || findDuplicateByTitle(doc.title)) {
        continue;
      }

      await applyDocumentTags(doc, raw);
      insertDocument(doc);
      updateTagStatsForDocument(doc);
      inserted++;
    }

    logScheduler(`[scheduler] ${collector.id} done: ${inserted} new items inserted.`);
    return { inserted, source: collector.id };
  } catch (e) {
    logError(`scheduler/${collector.id}`, e);
    logScheduler(`[scheduler] ${collector.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { inserted: 0, source: collector.id };
  }
}

// ---------------------------------------------------------------------------
// Summarization runner
// ---------------------------------------------------------------------------

async function runSummarization(): Promise<void> {
  logScheduler("[scheduler] Running summarization...");

  try {
    const pending = getPendingSummaryDocuments(100);

    if (pending.length === 0) {
      logScheduler("[scheduler] No pending documents to summarize.");
      return;
    }

    await summarizeBatch(pending, "zh", (done, total) => {
      if (done % 5 === 0 || done === total) {
        logScheduler(`[scheduler] Summarization progress: ${done}/${total}`);
      }
    });

    logScheduler(`[scheduler] Summarization done.`);
  } catch (e) {
    logError("scheduler/summarize", e);
    logScheduler(`[scheduler] Summarization failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function rebuildDailyHotRecommendations(): Promise<void> {
  const startedAt = Date.now();
  logScheduler("[scheduler] Rebuilding hot recommendations...");

  try {
    const entries = refreshHotRecommendations({ limit: 20, windowDays: 14, includeRead: true });
    logScheduler(
      `[scheduler] Hot recommendations rebuilt: ${entries.length} items in ${Date.now() - startedAt}ms.`,
    );
  } catch (e) {
    logError("scheduler/hot", e);
    logScheduler(`[scheduler] Hot recommendation rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function rebuildDailyUserMemory(): Promise<void> {
  const startedAt = Date.now();
  logScheduler("[scheduler] Rebuilding user memory from digests...");

  try {
    const terms = rebuildUserMemoryFromDigests({ maxDays: 30, maxTerms: 20 });
    logScheduler(
      `[scheduler] User memory rebuilt: ${terms.length} terms in ${Date.now() - startedAt}ms.`,
    );
  } catch (e) {
    logError("scheduler/memory", e);
    logScheduler(`[scheduler] User memory rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export function startScheduler(runImmediately = true): void {
  logScheduler("[scheduler] Starting scheduler...");

  // arXiv: every 6 hours
  const arxivTask = cron.schedule(config.intervals.arxiv, () => track(runCollector(arxivCollector)), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(arxivTask);
  logScheduler(`[scheduler] arXiv scheduled: ${config.intervals.arxiv}`);

  // GPT Blog: every 30 minutes
  const gptTask = cron.schedule(config.intervals.gptBlog, () => track(runCollector(gptBlogCollector)), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(gptTask);
  logScheduler(`[scheduler] GPT Blog scheduled: ${config.intervals.gptBlog}`);

  // Claude Blog: every 30 minutes
  const claudeTask = cron.schedule(config.intervals.claudeBlog, () => track(runCollector(claudeBlogCollector)), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(claudeTask);
  logScheduler(`[scheduler] Claude Blog scheduled: ${config.intervals.claudeBlog}`);

  // Summarization: every 30 minutes
  const summaryTask = cron.schedule("0 */30 * * * *", () => track(runSummarization()), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(summaryTask);
  logScheduler("[scheduler] Summarization scheduled: 0 */30 * * * *");

  const hotTask = cron.schedule("0 10 0 * * *", () => track(rebuildDailyHotRecommendations()), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(hotTask);
  logScheduler("[scheduler] Hot recommendations scheduled: 0 10 0 * * *");

  const memoryTask = cron.schedule("0 20 0 * * *", () => track(rebuildDailyUserMemory()), {
    scheduled: true,
    timezone: "UTC",
  });
  tasks.push(memoryTask);
  logScheduler("[scheduler] User memory scheduled: 0 20 0 * * *");

  // Run immediately on startup (for dev/test convenience)
  // Stagger collectors by 2 s each to avoid thundering-herd API calls
  if (runImmediately) {
    const startup = async () => {
      for (const collector of [arxivCollector, gptBlogCollector, claudeBlogCollector]) {
        await track(runCollector(collector));
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await track(runSummarization());
      await track(rebuildDailyUserMemory());
      await track(rebuildDailyHotRecommendations());
    };

    track(
      startup().catch((e) => {
        logError("scheduler/immediate", e);
      }),
    );
  }
}

export function stopScheduler(): void {
  logScheduler("[scheduler] Stopping scheduler...");
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;

  // Fire-and-forget: resolve any in-flight work with a 30 s deadline so
  // the process can exit cleanly without torn writes.
  if (runningPromises.size > 0) {
    logScheduler(`[scheduler] Waiting for ${runningPromises.size} in-flight task(s)...`);
    Promise.race([
      Promise.allSettled([...runningPromises]),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]).finally(() => {
      logScheduler("[scheduler] All in-flight tasks resolved (or timed out).");
    });
  }
}

/**
 * Wait for all in-flight scheduler work to settle (used by graceful shutdown).
 */
export function waitForRunningTasks(): Promise<void> {
  if (runningPromises.size === 0) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...runningPromises]).then(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
  ]);
}

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

export async function triggerCollection(source: "arxiv" | "gpt_blog" | "claude_blog" | "all" = "all"): Promise<Record<string, { inserted: number }>> {
  const results: Record<string, { inserted: number }> = {};

  const collectors = [
    { id: "arxiv" as const, collector: arxivCollector },
    { id: "gpt_blog" as const, collector: gptBlogCollector },
    { id: "claude_blog" as const, collector: claudeBlogCollector },
  ];

  for (const { id, collector } of collectors) {
    if (source === "all" || source === id) {
      const result = await runCollector(collector);
      results[id] = { inserted: result.inserted };
    }
  }

  return results;
}
