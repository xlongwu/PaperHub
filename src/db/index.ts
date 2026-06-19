/**
 * SQLite database layer using better-sqlite3.
 * Initializes schema, runs migrations, and provides the DB instance.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { getDbPath } from "@/config";

// ---------------------------------------------------------------------------
// Migration tracking
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = 9;

interface Migration {
  version: number;
  name: string;
  sql: string;
  postMigrate?: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
      -- Documents table
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        published_at TEXT,
        authors TEXT, -- JSON array
        abstract TEXT,
        full_text_path TEXT,
        language TEXT,
        domain_tags TEXT, -- JSON array
        source_tag TEXT,
        type_tag TEXT,
        year_tag INTEGER,
        model_tags TEXT, -- JSON array
        summary_zh TEXT,
        summary_en TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        is_summarized INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
      CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type_tag);
      CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year_tag);

      -- User preferences table
      CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Browsing history table
      CREATE TABLE IF NOT EXISTS browsing_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_history_document ON browsing_history(document_id);
      CREATE INDEX IF NOT EXISTS idx_history_viewed ON browsing_history(viewed_at);

      -- Favorites table
      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    name: "fts5-vec-tags",
    sql: `
      -- FTS5 全文搜索虚拟表 (external content mode)
      CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
        title,
        abstract,
        tags,
        content='documents',
        content_rowid='rowid'
      );

      -- FTS5 triggers for sync
      CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
        INSERT INTO document_fts(rowid, title, abstract, tags)
        VALUES (new.rowid, new.title, new.abstract, 
                COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
        INSERT INTO document_fts(document_fts, rowid, title, abstract, tags)
        VALUES ('delete', old.rowid, old.title, old.abstract, '');
      END;

      CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
        INSERT INTO document_fts(document_fts, rowid, title, abstract, tags)
        VALUES ('delete', old.rowid, old.title, old.abstract, '');
        INSERT INTO document_fts(rowid, title, abstract, tags)
        VALUES (new.rowid, new.title, new.abstract,
                COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''));
      END;

      -- Tag stats table
      CREATE TABLE IF NOT EXISTS tag_stats (
        tag TEXT PRIMARY KEY,
        category TEXT,        -- 'domain' | 'source' | 'model' | 'type' | 'year'
        count INTEGER DEFAULT 0,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tag_stats_category ON tag_stats(category);
      CREATE INDEX IF NOT EXISTS idx_tag_stats_count ON tag_stats(count);
    `,
    postMigrate: ensureVectorSchema,
  },
  {
    version: 3,
    name: "tag-stats-composite-key",
    sql: `
      ALTER TABLE tag_stats RENAME TO tag_stats_legacy;

      CREATE TABLE tag_stats (
        tag TEXT NOT NULL,
        category TEXT NOT NULL, -- 'domain' | 'source' | 'model' | 'type' | 'year'
        count INTEGER DEFAULT 0,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tag, category)
      );

      INSERT INTO tag_stats(tag, category, count, last_updated)
      SELECT
        tag,
        category,
        SUM(count) AS count,
        MAX(last_updated) AS last_updated
      FROM tag_stats_legacy
      GROUP BY tag, category;

      DROP TABLE tag_stats_legacy;

      CREATE INDEX IF NOT EXISTS idx_tag_stats_category ON tag_stats(category);
      CREATE INDEX IF NOT EXISTS idx_tag_stats_count ON tag_stats(count);
    `,
  },
  {
    version: 4,
    name: "recommendation-memory-snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS user_memory_terms (
        term TEXT NOT NULL,
        category TEXT NOT NULL,          -- 'domain' | 'model' | 'source' | 'topic'
        weight REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL,            -- 'digest' | 'preference' | 'history' | 'favorite'
        last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
        meta TEXT,
        PRIMARY KEY (term, category, source)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_weight ON user_memory_terms(weight DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_source ON user_memory_terms(source);

      CREATE TABLE IF NOT EXISTS recommendation_snapshots (
        kind TEXT NOT NULL,              -- 'hot' | 'personalized'
        snapshot_date TEXT NOT NULL,     -- YYYY-MM-DD
        document_id TEXT NOT NULL,
        score REAL NOT NULL,
        rank INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, snapshot_date, document_id)
      );

      CREATE INDEX IF NOT EXISTS idx_rec_snapshots_kind_date
        ON recommendation_snapshots(kind, snapshot_date, rank);
    `,
  },
  {
    version: 5,
    name: "llm-provider-settings",
    sql: `
      CREATE TABLE IF NOT EXISTS llm_provider_settings (
        provider TEXT PRIMARY KEY,
        api_key TEXT,
        model TEXT,
        base_url TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 6,
    name: "embedding-index-metadata",
    sql: `
      CREATE TABLE IF NOT EXISTS embedding_index_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        signature TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 7,
    name: "fts-v2-eight-columns",
    sql: `
      -- Drop old FTS5 triggers and table
      DROP TRIGGER IF EXISTS documents_fts_insert;
      DROP TRIGGER IF EXISTS documents_fts_delete;
      DROP TRIGGER IF EXISTS documents_fts_update;
      DROP TABLE IF EXISTS document_fts_v2;

      -- New 8-column FTS5 table (standalone — triggers handle all sync,
      -- not external-content, because computed columns like 'tags' don't
      -- exist in the documents table).
      CREATE VIRTUAL TABLE document_fts_v2 USING fts5(
        title,
        abstract,
        summary_zh,
        summary_en,
        authors,
        tags,
        source_type,
        full_text,
        tokenize='unicode61 remove_diacritics 2'
      );

      -- INSERT trigger: all 8 columns populated from documents row
      CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
        INSERT INTO document_fts_v2(
          rowid, title, abstract, summary_zh, summary_en,
          authors, tags, source_type, full_text
        ) VALUES (
          new.rowid,
          new.title,
          new.abstract,
          COALESCE(new.summary_zh, ''),
          COALESCE(new.summary_en, ''),
          COALESCE(new.authors, ''),
          COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''),
          new.type_tag || ' ' || COALESCE(new.source, ''),
          ''
        );
      END;

      -- DELETE trigger: standalone FTS5 uses DELETE FROM, not 'delete' insert
      CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
        DELETE FROM document_fts_v2 WHERE rowid = old.rowid;
      END;

      -- UPDATE trigger: delete old entry, then insert new with full field set
      CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
        DELETE FROM document_fts_v2 WHERE rowid = old.rowid;
        INSERT INTO document_fts_v2(
          rowid, title, abstract, summary_zh, summary_en,
          authors, tags, source_type, full_text
        ) VALUES (
          new.rowid,
          new.title,
          new.abstract,
          COALESCE(new.summary_zh, ''),
          COALESCE(new.summary_en, ''),
          COALESCE(new.authors, ''),
          COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''),
          new.type_tag || ' ' || COALESCE(new.source, ''),
          ''
        );
      END;
    `,
    postMigrate: rebuildFtsV2,
  },
  {
    version: 8,
    name: "vector-v2-cosine-index-state",
    sql: `
      -- Build the cosine table alongside the legacy table. Search only
      -- switches to v2 after the table exists, so migration is reversible.
      CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors_v2 USING vec0(
        document_id TEXT PRIMARY KEY,
        embedding float[1536] distance_metric=cosine
      );

      -- Per-document index state: tracks FTS and vector indexing status
      CREATE TABLE IF NOT EXISTS document_index_state (
        document_id TEXT PRIMARY KEY,
        fts_version INTEGER NOT NULL DEFAULT 2,
        fts_indexed_at TEXT,
        vector_signature TEXT,
        vector_indexed_at TEXT,
        vector_error TEXT,
        vector_retry_count INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_doc_index_state_vector
        ON document_index_state(vector_indexed_at);
      CREATE INDEX IF NOT EXISTS idx_doc_index_state_pending
        ON document_index_state(document_id)
        WHERE vector_indexed_at IS NULL;
    `,
    postMigrate: initIndexState,
  },
  {
    version: 9,
    name: "index-lifecycle-search-feedback",
    sql: `
      ALTER TABLE documents ADD COLUMN full_text TEXT;

      ALTER TABLE document_index_state
        ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'running', 'ready', 'failed'));
      ALTER TABLE document_index_state
        ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE document_index_state ADD COLUMN last_error TEXT;

      UPDATE document_index_state
      SET embedding_status = CASE
        WHEN vector_indexed_at IS NOT NULL THEN 'ready'
        WHEN vector_error IS NOT NULL THEN 'failed'
        ELSE 'pending'
      END,
      embedding_attempts = COALESCE(vector_retry_count, 0),
      last_error = vector_error;

      CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors_v2 USING vec0(
        document_id TEXT PRIMARY KEY,
        embedding float[1536] distance_metric=cosine
      );

      DROP TRIGGER IF EXISTS documents_fts_insert;
      DROP TRIGGER IF EXISTS documents_fts_delete;
      DROP TRIGGER IF EXISTS documents_fts_update;
      DROP TABLE IF EXISTS document_fts_v2;

      CREATE VIRTUAL TABLE document_fts_v2 USING fts5(
        title,
        abstract,
        summary_zh,
        summary_en,
        authors,
        tags,
        source_type,
        full_text,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
        INSERT INTO document_fts_v2(
          rowid, title, abstract, summary_zh, summary_en,
          authors, tags, source_type, full_text
        ) VALUES (
          new.rowid, new.title, new.abstract,
          COALESCE(new.summary_zh, ''), COALESCE(new.summary_en, ''),
          COALESCE(new.authors, ''),
          COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''),
          COALESCE(new.type_tag, '') || ' ' || COALESCE(new.source, '') || ' ' ||
            COALESCE(new.source_tag, '') || ' ' || COALESCE(new.year_tag, ''),
          COALESCE(new.full_text, '')
        );
      END;

      CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
        DELETE FROM document_fts_v2 WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
        DELETE FROM document_fts_v2 WHERE rowid = old.rowid;
        INSERT INTO document_fts_v2(
          rowid, title, abstract, summary_zh, summary_en,
          authors, tags, source_type, full_text
        ) VALUES (
          new.rowid, new.title, new.abstract,
          COALESCE(new.summary_zh, ''), COALESCE(new.summary_en, ''),
          COALESCE(new.authors, ''),
          COALESCE(new.domain_tags, '') || ' ' || COALESCE(new.model_tags, ''),
          COALESCE(new.type_tag, '') || ' ' || COALESCE(new.source, '') || ' ' ||
            COALESCE(new.source_tag, '') || ' ' || COALESCE(new.year_tag, ''),
          COALESCE(new.full_text, '')
        );
      END;

      CREATE TRIGGER document_index_state_insert AFTER INSERT ON documents BEGIN
        INSERT INTO document_index_state(
          document_id, fts_version, fts_indexed_at, embedding_status, updated_at
        ) VALUES (new.id, 2, new.updated_at, 'pending', datetime('now'))
        ON CONFLICT(document_id) DO UPDATE SET
          fts_version = 2,
          fts_indexed_at = excluded.fts_indexed_at,
          embedding_status = 'pending',
          vector_indexed_at = NULL,
          last_error = NULL,
          updated_at = datetime('now');
      END;

      CREATE TRIGGER document_index_state_update
      AFTER UPDATE OF title, abstract, summary_zh, summary_en, authors,
        domain_tags, model_tags, source, source_tag, type_tag, year_tag, full_text
      ON documents BEGIN
        DELETE FROM document_vectors_v2 WHERE document_id = new.id;
        INSERT INTO document_index_state(
          document_id, fts_version, fts_indexed_at, embedding_status, updated_at
        ) VALUES (new.id, 2, new.updated_at, 'pending', datetime('now'))
        ON CONFLICT(document_id) DO UPDATE SET
          fts_version = 2,
          fts_indexed_at = excluded.fts_indexed_at,
          embedding_status = 'pending',
          vector_indexed_at = NULL,
          last_error = NULL,
          updated_at = datetime('now');
      END;

      CREATE TRIGGER document_vectors_delete AFTER DELETE ON documents BEGIN
        DELETE FROM document_vectors_v2 WHERE document_id = old.id;
      END;

      CREATE TABLE IF NOT EXISTS search_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_hash TEXT NOT NULL,
        mode TEXT NOT NULL,
        mode_used TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        degraded INTEGER NOT NULL DEFAULT 0,
        clicked_document_id TEXT,
        clicked_rank INTEGER,
        reformulated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_search_events_created
        ON search_events(created_at);
    `,
    postMigrate: (db) => {
      rebuildFtsV2(db);
      initIndexState(db);
    },
  },
];

// ---------------------------------------------------------------------------
// Singleton DB instance
// ---------------------------------------------------------------------------

let dbInstance: Database.Database | null = null;
let customDbPath: string | null = null;
const vectorReadyConnections = new WeakSet<Database.Database>();

/** For testing: override the database file path. */
export function setDbPath(p: string): void {
  closeDb();
  customDbPath = p;
}

/** For testing: clear the custom path override. */
export function clearDbPath(): void {
  closeDb();
  customDbPath = null;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = customDbPath ?? getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma(customDbPath ? "journal_mode = DELETE" : "journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export function runMigrations(): void {
  const db = getDb();
  const current = getCurrentVersion(db);

  if (current >= CURRENT_SCHEMA_VERSION) {
    console.log(`[db] Schema up to date (v${current})`);
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      console.log(`[db] Applying migration v${migration.version}: ${migration.name}`);
      const applyMigration = db.transaction(() => {
        db.exec(migration.sql);
        migration.postMigrate?.(db);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      });
      applyMigration();
    }
  }

  const finalVersion = getCurrentVersion(db);
  if (finalVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database migration incomplete: expected v${CURRENT_SCHEMA_VERSION}, got v${finalVersion}`,
    );
  }
  console.log(`[db] Migrations complete. Now at v${finalVersion}`);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDatabase(): void {
  const db = getDb();
  // Load sqlite-vec extension BEFORE running migrations,
  // because v8 migration creates a vec0 virtual table.
  ensureVectorExtension(db);
  runMigrations();
  if (getCurrentVersion(db) >= 2) {
    ensureVectorSchema(db);
  }
  // Defer consistency check to avoid blocking startup
  if (!customDbPath) {
    setTimeout(() => {
      try {
        if (db.open) runConsistencyCheck(db);
      } catch (e) {
        console.error("[db] Consistency check failed:", e);
      }
    }, 500);
  }
}

/**
 * Load sqlite-vec extension (no schema creation).
 * Safe to call multiple times — loads once per connection.
 */
function ensureVectorExtension(db: Database.Database): void {
  if (!vectorReadyConnections.has(db)) {
    db.loadExtension(sqliteVec.getLoadablePath());
    vectorReadyConnections.add(db);
    console.log("[db] sqlite-vec extension loaded");
  }
}

/**
 * Startup consistency scan: verifies FTS and vector index coverage.
 * Logs warnings for any mismatches.
 */
export function runConsistencyCheck(db: Database.Database = getDb()): void {
  const totalDocs = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;

  // FTS check (standalone FTS5 — count directly)
  let ftsDocs = 0;
  try {
    ftsDocs = (db.prepare("SELECT COUNT(*) as c FROM document_fts_v2").get() as { c: number }).c;
  } catch {
    console.warn("[db] FTS table not available");
  }

  // Vector check
  let vecDocs = 0;
  try {
    vecDocs = (
      db
        .prepare(
          `SELECT COUNT(*) as c
           FROM document_index_state s
           JOIN document_vectors_v2 v ON v.document_id = s.document_id
           WHERE s.embedding_status = 'ready'`,
        )
        .get() as { c: number }
    ).c;
  } catch {
    console.warn("[db] document_index_state not available");
  }

  console.log(
    `[db] Consistency: total=${totalDocs}, fts=${ftsDocs}, vec=${vecDocs}, pending=${totalDocs - vecDocs}`,
  );

  if (ftsDocs < totalDocs) {
    console.warn(`[db] FTS mismatch: ${totalDocs - ftsDocs} docs missing from FTS index`);
  }

  if (vecDocs < totalDocs) {
    console.log(`[db] ${totalDocs - vecDocs} documents pending vector indexing`);
  }
}

function ensureVectorSchema(db: Database.Database): void {
  if (!vectorReadyConnections.has(db)) {
    db.loadExtension(sqliteVec.getLoadablePath());
    vectorReadyConnections.add(db);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors_v2 USING vec0(
      document_id TEXT PRIMARY KEY,
      embedding float[1536] distance_metric=cosine
    );
  `);
  console.log("[db] sqlite-vec schema ready");
}

// ---------------------------------------------------------------------------
// Post-migration hooks for v7 and v8
// ---------------------------------------------------------------------------

/**
 * Rebuild FTS v2 index for all existing documents.
 * Called after v7 migration creates the new 8-column FTS table.
 *
 * Standalone FTS5 (no external content) — must manually re-insert
 * all rows from the content table.
 */
export function rebuildFtsV2(db: Database.Database = getDb()): void {
  db.exec("DELETE FROM document_fts_v2");
  const allRows = db.prepare("SELECT rowid, * FROM documents").all() as Record<string, unknown>[];

  const insertStmt = db.prepare(`
    INSERT INTO document_fts_v2(
      rowid, title, abstract, summary_zh, summary_en,
      authors, tags, source_type, full_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let indexed = 0;
  for (const row of allRows) {
    const rowid = Number(row.rowid);
    const title = String(row.title ?? "");
    const abstract = String(row.abstract ?? "");
    const summaryZh = String(row.summary_zh ?? "");
    const summaryEn = String(row.summary_en ?? "");
    const authors = String(row.authors ?? "");
    const domainTags = String(row.domain_tags ?? "");
    const modelTags = String(row.model_tags ?? "");
    const tags = `${domainTags} ${modelTags}`;
    const typeTag = String(row.type_tag ?? "");
    const source = String(row.source ?? "");
    const sourceTag = String(row.source_tag ?? "");
    const yearTag = String(row.year_tag ?? "");
    const sourceType = `${typeTag} ${source} ${sourceTag} ${yearTag}`;
    const fullText = String(row.full_text ?? "");

    insertStmt.run(rowid, title, abstract, summaryZh, summaryEn, authors, tags, sourceType, fullText);
    indexed++;
  }

  console.log(`[db] FTS v2 rebuilt: ${indexed} documents indexed`);

  // Consistency check
  const docCount = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;
  if (indexed !== docCount) {
    console.warn(`[db] FTS v2 consistency warning: documents=${docCount}, fts=${indexed}`);
  }
}

/**
 * Initialize document_index_state for existing documents after v8 migration.
 */
function initIndexState(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(document_index_state)").all() as Array<{ name: string }>;
  const hasEmbeddingStatus = columns.some((column) => column.name === "embedding_status");

  if (hasEmbeddingStatus) {
    db.exec(`
      INSERT INTO document_index_state (
        document_id, fts_version, fts_indexed_at, embedding_status, updated_at
      )
      SELECT id, 2, updated_at, 'pending', datetime('now') FROM documents WHERE true
      ON CONFLICT(document_id) DO UPDATE SET
        fts_version = 2,
        fts_indexed_at = excluded.fts_indexed_at,
        updated_at = datetime('now');
    `);
  } else {
    db.exec(`
      INSERT OR IGNORE INTO document_index_state(
        document_id, fts_version, fts_indexed_at
      )
      SELECT id, 2, updated_at FROM documents;
    `);
  }
  const count = (db.prepare("SELECT COUNT(*) as c FROM document_index_state").get() as { c: number }).c;
  console.log(`[db] document_index_state initialized: ${count} rows`);
}
