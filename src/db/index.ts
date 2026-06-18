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

const CURRENT_SCHEMA_VERSION = 6;

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
      db.exec(migration.sql);
      migration.postMigrate?.(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
    }
  }

  console.log(`[db] Migrations complete. Now at v${CURRENT_SCHEMA_VERSION}`);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDatabase(): void {
  const db = getDb();
  runMigrations();
  if (getCurrentVersion(db) >= 2) {
    ensureVectorSchema(db);
  }
}

function ensureVectorSchema(db: Database.Database): void {
  if (!vectorReadyConnections.has(db)) {
    db.loadExtension(sqliteVec.getLoadablePath());
    vectorReadyConnections.add(db);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors USING vec0(
      document_id TEXT PRIMARY KEY,
      embedding float[1536]
    );
  `);
  console.log("[db] sqlite-vec schema ready");
}
