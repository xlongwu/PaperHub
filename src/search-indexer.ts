/**
 * Background vector indexing queue.
 *
 * Maintains an in-memory queue of document IDs that need vector embeddings.
 * Processes documents in batches with:
 *   - rate limiting (max 5 API calls per second)
 *   - retry with exponential backoff (up to 3 attempts)
 *   - graceful shutdown
 *   - status reporting
 *
 * No external message queue dependency — uses setTimeout for scheduling.
 */

import { indexDocumentVector, getPendingVectorDocuments, markVectorIndexFailed } from "@/db/search";
import { getDocumentById } from "@/db/documents";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface IndexerState {
  running: boolean;
  queueSize: number;
  processedToday: number;
  errorsToday: number;
  lastProcessedAt: string | null;
}

const state: IndexerState = {
  running: false,
  queueSize: 0,
  processedToday: 0,
  errorsToday: 0,
  lastProcessedAt: null,
};

const queue: string[] = [];
let processingTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_RETRIES = 3;
const BATCH_SIZE = 10;
const PROCESS_INTERVAL_MS = 2000; // Process one batch every 2 seconds
const RATE_LIMIT_PER_SECOND = 5;
const INDEX_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add document IDs to the indexing queue (idempotent per session).
 */
export function enqueueVectorIndexing(documentIds: string[]): void {
  const existing = new Set(queue);
  let added = 0;
  for (const id of documentIds) {
    if (!existing.has(id)) {
      queue.push(id);
      added++;
    }
  }
  state.queueSize = queue.length;
  if (added > 0) {
    console.log(`[search-indexer] Enqueued ${added} documents for vector indexing`);
  }
  ensureProcessing();
}

/** Start the indexer and recover pending/stale work from the database. */
export function startIndexer(): void {
  ensureProcessing();
}

/**
 * Process a specific number of pending documents from the database.
 * Used for bulk catch-up (e.g. after migration or backfill).
 */
export async function processPending(count = 50): Promise<number> {
  const docs = getPendingVectorDocuments(count);
  if (docs.length === 0) return 0;

  let processed = 0;
  for (const doc of docs) {
    try {
      await indexDocumentVector(doc);
      processed++;
      state.processedToday++;

      // Rate limiting
      if (processed % RATE_LIMIT_PER_SECOND === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (e) {
      state.errorsToday++;
      markVectorIndexFailed(doc.id, e);
      console.error(`[search-indexer] Failed for ${doc.id}:`, e);
    }
  }

  state.lastProcessedAt = new Date().toISOString();
  return processed;
}

/**
 * Get a copy of the current indexer state for monitoring.
 */
export function getIndexerState(): IndexerState {
  return { ...state };
}

/**
 * Stop the indexer gracefully. Remaining queue items will be lost
 * (they'll be picked up from the database on next startup).
 */
export function stopIndexer(): void {
  if (processingTimer) {
    clearTimeout(processingTimer);
    processingTimer = null;
  }
  const remaining = queue.length;
  queue.length = 0;
  state.queueSize = 0;
  state.running = false;
  console.log(`[search-indexer] Stopped. Queue had ${remaining} remaining items.`);
}

// ---------------------------------------------------------------------------
// Internal processing loop
// ---------------------------------------------------------------------------

function ensureProcessing(): void {
  if (state.running) return;
  state.running = true;

  const tick = async () => {
    // If the in-memory queue is empty, try to pull from the database
    if (queue.length === 0) {
      let pending;
      try {
        pending = getPendingVectorDocuments(BATCH_SIZE);
      } catch (error) {
        state.running = false;
        console.warn(
          `[search-indexer] Paused because embeddings are unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (pending.length === 0) {
        state.running = false;
        console.log("[search-indexer] Queue empty, pausing.");
        return;
      }
      // Load pending IDs into the queue
      const ids = pending.map((d) => d.id);
      for (const id of ids) {
        if (!queue.includes(id)) queue.push(id);
      }
      state.queueSize = queue.length;
    }

    // Process one batch
    const batch = queue.splice(0, BATCH_SIZE);
    state.queueSize = queue.length;

    const pendingBatch = [...batch];
    const worker = async (): Promise<void> => {
      while (pendingBatch.length > 0) {
        const docId = pendingBatch.shift();
        if (!docId) return;
        const doc = getDocumentById(docId);
        if (!doc) {
          // Document was deleted — skip
          continue;
        }

        let success = false;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            await indexDocumentVector(doc);
            state.processedToday++;
            success = true;
            break;
          } catch (e) {
            const delay = Math.pow(2, attempt) * 1000;
            console.error(`[search-indexer] Retry ${attempt + 1}/${MAX_RETRIES} for ${docId}:`, e);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (!success) {
          state.errorsToday++;
          markVectorIndexFailed(docId, `Failed after ${MAX_RETRIES} retries`);
        }

        // Rate limit between documents
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await Promise.all(Array.from({ length: Math.min(INDEX_CONCURRENCY, batch.length) }, () => worker()));

    state.lastProcessedAt = new Date().toISOString();

    // Schedule next batch
    processingTimer = setTimeout(tick, PROCESS_INTERVAL_MS);
  };

  // Delay startup slightly to avoid thundering herd
  processingTimer = setTimeout(tick, 100);
}
