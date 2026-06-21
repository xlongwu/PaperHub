import { resolveEmbeddingRuntime, type EmbeddingRuntime } from "@/embedding";
import type Database from "better-sqlite3";
import { getDb } from "./index";

export type EmbeddingIndexStatus =
  | "unconfigured"
  | "probing"
  | "ready"
  | "rebuild_required"
  | "rebuilding"
  | "failed";

export interface EmbeddingIndexMetadata {
  signature: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  status: EmbeddingIndexStatus;
  lastError: string | null;
  rebuildStartedAt: string | null;
  rebuildCompletedAt: string | null;
  updatedAt: string | null;
}

export interface EmbeddingIndexProgress extends EmbeddingIndexMetadata {
  total: number;
  ready: number;
  pending: number;
  running: number;
  failed: number;
}

export interface EmbeddingIndexActivation {
  runtime: EmbeddingRuntime;
  rebuilt: boolean;
  status: EmbeddingIndexStatus;
}

export async function activateEmbeddingRuntime(): Promise<EmbeddingIndexActivation> {
  let runtime: EmbeddingRuntime;
  try {
    runtime = await resolveEmbeddingRuntime({ probe: true });
  } catch (error) {
    recordEmbeddingProbeFailure(error);
    throw error;
  }
  return ensureEmbeddingIndexRuntime(runtime);
}

export async function forceRebuildEmbeddingIndex(): Promise<EmbeddingIndexActivation> {
  let runtime: EmbeddingRuntime;
  try {
    runtime = await resolveEmbeddingRuntime({ probe: true });
  } catch (error) {
    recordEmbeddingProbeFailure(error);
    throw error;
  }
  rebuildEmbeddingIndex(runtime);
  return { runtime, rebuilt: true, status: "rebuilding" };
}

export function ensureEmbeddingIndexRuntime(runtime: EmbeddingRuntime): EmbeddingIndexActivation {
  validateDimensions(runtime.dimensions);
  const metadata = getEmbeddingIndexMetadata();
  const tableDimensions = getVectorTableDimensions();
  const matches =
    metadata?.signature === runtime.signature &&
    metadata.dimensions === runtime.dimensions &&
    tableDimensions === runtime.dimensions;

  if (matches) {
    const progress = getEmbeddingIndexProgress();
    const resumeRebuild =
      ["rebuilding", "rebuild_required", "failed"].includes(metadata.status) &&
      (progress.pending > 0 || progress.running > 0 || progress.failed > 0);
    const status: EmbeddingIndexStatus = resumeRebuild ? "rebuilding" : "ready";
    updateMetadata(runtime, status, null, false);
    return { runtime, rebuilt: false, status };
  }

  rebuildEmbeddingIndex(runtime);
  return { runtime, rebuilt: true, status: "rebuilding" };
}

export function rebuildEmbeddingIndex(runtime: EmbeddingRuntime): void {
  validateDimensions(runtime.dimensions);
  const db = getDb();
  updateMetadata(runtime, "rebuild_required", null, false);

  try {
    const rebuild = db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS document_vectors_v2");
      db.exec("DROP TABLE IF EXISTS document_title_abstract_vectors_v2");
      db.exec("DROP TABLE IF EXISTS document_tag_vectors_v2");
      db.exec(`
        CREATE VIRTUAL TABLE document_vectors_v2 USING vec0(
          document_id TEXT PRIMARY KEY,
          embedding float[${runtime.dimensions}] distance_metric=cosine
        );
        CREATE VIRTUAL TABLE document_title_abstract_vectors_v2 USING vec0(
          document_id TEXT PRIMARY KEY,
          embedding float[${runtime.dimensions}] distance_metric=cosine
        );
        CREATE VIRTUAL TABLE document_tag_vectors_v2 USING vec0(
          document_id TEXT PRIMARY KEY,
          embedding float[${runtime.dimensions}] distance_metric=cosine
        );
      `);
      db.exec(`
        UPDATE document_index_state
        SET embedding_status = 'pending',
            embedding_attempts = 0,
            vector_signature = NULL,
            vector_indexed_at = NULL,
            vector_error = NULL,
            vector_retry_count = 0,
            last_error = NULL,
            updated_at = datetime('now')
      `);
      updateMetadata(runtime, "rebuilding", null, true, db);
    });
    rebuild();
  } catch (error) {
    updateMetadata(runtime, "failed", errorMessage(error), false);
    throw error;
  }
}

export function finalizeEmbeddingIndex(): EmbeddingIndexProgress {
  const progress = getEmbeddingIndexProgress();
  const metadata = getEmbeddingIndexMetadata();
  if (!metadata) return progress;

  if (progress.pending > 0 || progress.running > 0) {
    setEmbeddingIndexStatus("rebuilding");
  } else if (progress.failed > 0) {
    setEmbeddingIndexStatus("failed", `${progress.failed} document embeddings failed.`);
  } else {
    const db = getDb();
    db.prepare(
      `
      UPDATE embedding_index_metadata
      SET status = 'ready',
          last_error = NULL,
          rebuild_completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = 1
    `,
    ).run();
  }
  return getEmbeddingIndexProgress();
}

export function getEmbeddingIndexMetadata(): EmbeddingIndexMetadata | null {
  const row = getDb()
    .prepare(
      `
      SELECT signature, provider, model, dimensions, status, last_error,
             rebuild_started_at, rebuild_completed_at, updated_at
      FROM embedding_index_metadata
      WHERE id = 1
    `,
    )
    .get() as
    | {
        signature: string;
        provider: string | null;
        model: string | null;
        dimensions: number | null;
        status: EmbeddingIndexStatus;
        last_error: string | null;
        rebuild_started_at: string | null;
        rebuild_completed_at: string | null;
        updated_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    signature: row.signature || null,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    status: row.status,
    lastError: row.last_error,
    rebuildStartedAt: row.rebuild_started_at,
    rebuildCompletedAt: row.rebuild_completed_at,
    updatedAt: row.updated_at,
  };
}

export function getEmbeddingIndexProgress(): EmbeddingIndexProgress {
  const metadata = getEmbeddingIndexMetadata() ?? {
    signature: null,
    provider: null,
    model: null,
    dimensions: null,
    status: "unconfigured" as const,
    lastError: null,
    rebuildStartedAt: null,
    rebuildCompletedAt: null,
    updatedAt: null,
  };
  const row = getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN embedding_status = 'ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN embedding_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN embedding_status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM document_index_state
    `,
    )
    .get() as {
    total: number;
    ready: number | null;
    pending: number | null;
    running: number | null;
    failed: number | null;
  };
  return {
    ...metadata,
    total: row.total,
    ready: row.ready ?? 0,
    pending: row.pending ?? 0,
    running: row.running ?? 0,
    failed: row.failed ?? 0,
  };
}

export function assertEmbeddingIndexReady(runtime: EmbeddingRuntime): void {
  const metadata = getEmbeddingIndexMetadata();
  if (!metadata) {
    throw new Error("embedding_index_unconfigured");
  }
  if (metadata.signature !== runtime.signature || metadata.dimensions !== runtime.dimensions) {
    throw new Error("embedding_index_runtime_mismatch");
  }
  if (metadata.status !== "ready") {
    throw new Error(`embedding_index_${metadata.status}`);
  }
}

export function isEmbeddingIndexRebuilding(): boolean {
  const status = getEmbeddingIndexMetadata()?.status;
  return status === "rebuild_required" || status === "rebuilding" || status === "probing";
}

export function setEmbeddingIndexStatus(status: EmbeddingIndexStatus, lastError?: string | null): void {
  const db = getDb();
  const existing = getEmbeddingIndexMetadata();
  if (!existing) {
    db.prepare(
      `
      INSERT INTO embedding_index_metadata(
        id, signature, status, last_error, updated_at
      ) VALUES (1, '', ?, ?, datetime('now'))
    `,
    ).run(status, lastError ?? null);
    return;
  }
  db.prepare(
    `
    UPDATE embedding_index_metadata
    SET status = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = 1
  `,
  ).run(status, lastError ?? null);
}

function updateMetadata(
  runtime: EmbeddingRuntime,
  status: EmbeddingIndexStatus,
  lastError: string | null,
  rebuildStarted: boolean,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `
    INSERT INTO embedding_index_metadata(
      id, signature, provider, model, dimensions, status, last_error,
      rebuild_started_at, rebuild_completed_at, updated_at
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? THEN datetime('now') ELSE NULL END,
      NULL,
      datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      signature = excluded.signature,
      provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      status = excluded.status,
      last_error = excluded.last_error,
      rebuild_started_at = CASE
        WHEN ? THEN datetime('now')
        ELSE embedding_index_metadata.rebuild_started_at
      END,
      rebuild_completed_at = CASE
        WHEN excluded.status = 'ready' THEN datetime('now')
        ELSE embedding_index_metadata.rebuild_completed_at
      END,
      updated_at = datetime('now')
  `,
  ).run(
    runtime.signature,
    runtime.provider,
    runtime.model,
    runtime.dimensions,
    status,
    lastError,
    rebuildStarted ? 1 : 0,
    rebuildStarted ? 1 : 0,
  );
}

function recordEmbeddingProbeFailure(error: unknown): void {
  const db = getDb();
  const metadata = getEmbeddingIndexMetadata();
  const message = errorMessage(error).slice(0, 1000);
  if (!metadata) {
    db.prepare(
      `
      INSERT INTO embedding_index_metadata(id, signature, status, last_error, updated_at)
      VALUES (1, '', 'failed', ?, datetime('now'))
    `,
    ).run(message);
    return;
  }
  db.prepare(
    `
    UPDATE embedding_index_metadata
    SET last_error = ?, updated_at = datetime('now')
    WHERE id = 1
  `,
  ).run(message);
}

function getVectorTableDimensions(): number | null {
  const row = getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_vectors_v2'")
    .get() as { sql?: string } | undefined;
  const match = row?.sql?.match(/embedding\s+float\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

function validateDimensions(dimensions: number): void {
  if (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 8192) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
