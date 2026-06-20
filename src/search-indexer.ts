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

import {
  indexDocumentVector,
  indexDocumentVectors,
  getPendingVectorDocuments,
  markVectorIndexFailed,
} from "@/db/search";
import { getDocumentById } from "@/db/documents";
import {
  activateEmbeddingRuntime,
  finalizeEmbeddingIndex,
  getEmbeddingIndexMetadata,
} from "@/db/embedding-index";

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
let activationPromise: Promise<void> | null = null;
let stopped = false;

const MAX_RETRIES = 5;
const PROCESS_INTERVAL_MS = 2000; // Process one batch every 2 seconds

function getBatchSize(): number {
  const configured = Number(process.env["EMBEDDING_BATCH_SIZE"] ?? 8);
  return Number.isSafeInteger(configured) ? Math.min(32, Math.max(1, configured)) : 8;
}

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
  startIndexer();
}

/** Start the indexer and recover pending/stale work from the database. */
export function startIndexer(): void {
  if (activationPromise || state.running) return;
  stopped = false;
  activationPromise = activateEmbeddingRuntime()
    .then((activation) => {
      if (stopped) return;
      console.log(
        `[search-indexer] Embedding runtime ready: ${activation.runtime.provider}/${activation.runtime.model} ` +
          `(${activation.runtime.dimensions} dimensions, index=${activation.status})`,
      );
      ensureProcessing();
    })
    .catch((error) => {
      console.warn(
        `[search-indexer] Embeddings unavailable; keyword search remains active: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (!stopped) {
        processingTimer = setTimeout(startIndexer, 30_000);
      }
    })
    .finally(() => {
      activationPromise = null;
    });
}

/**
 * Process a specific number of pending documents from the database.
 * Used for bulk catch-up (e.g. after migration or backfill).
 */
export async function processPending(count = 50): Promise<number> {
  await activateEmbeddingRuntime();
  const docs = getPendingVectorDocuments(count);
  if (docs.length === 0) return 0;

  let processed = 0;
  const batchSize = getBatchSize();
  for (let offset = 0; offset < docs.length; offset += batchSize) {
    const batch = docs.slice(offset, offset + batchSize);
    try {
      await indexDocumentVectors(batch);
      processed += batch.length;
      state.processedToday += batch.length;
    } catch {
      const recovered = await retryDocumentsIndividually(batch);
      processed += recovered;
    }
  }

  if (getEmbeddingIndexMetadata()?.status === "rebuilding") finalizeEmbeddingIndex();
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
  stopped = true;
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
        pending = getPendingVectorDocuments(getBatchSize());
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
    const batch = queue.splice(0, getBatchSize());
    state.queueSize = queue.length;
    const documents = batch
      .map((documentId) => getDocumentById(documentId))
      .filter((document): document is NonNullable<typeof document> => Boolean(document));

    if (documents.length > 0) {
      try {
        await indexDocumentVectors(documents);
        state.processedToday += documents.length;
      } catch (error) {
        console.warn(
          `[search-indexer] Batch embedding failed; retrying ${documents.length} documents individually: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await retryDocumentsIndividually(documents);
      }
    }

    if (getEmbeddingIndexMetadata()?.status === "rebuilding") finalizeEmbeddingIndex();

    state.lastProcessedAt = new Date().toISOString();

    // Schedule next batch
    processingTimer = setTimeout(tick, PROCESS_INTERVAL_MS);
  };

  // Delay startup slightly to avoid thundering herd
  processingTimer = setTimeout(tick, 100);
}

async function retryDocumentsIndividually(
  documents: Array<NonNullable<ReturnType<typeof getDocumentById>>>,
): Promise<number> {
  let recovered = 0;
  for (const document of documents) {
    let lastError: unknown = "Unknown embedding failure";
    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await indexDocumentVector(document);
        state.processedToday++;
        recovered++;
        success = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(20_000, 1000 * 2 ** (attempt - 1));
          console.warn(
            `[search-indexer] Retry ${attempt}/${MAX_RETRIES} for ${document.id} after ${delay}ms: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    if (!success) {
      state.errorsToday++;
      markVectorIndexFailed(document.id, lastError);
    }
  }
  return recovered;
}
