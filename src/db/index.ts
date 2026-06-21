/**
 * SQLite database layer using better-sqlite3.
 * Initializes schema, runs migrations, and provides the DB instance.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { getDbPath } from "@/config";
import { getLlmProviderPreset } from "@/providers/catalog";
import { getSecretStore } from "@/security/secret-store";
import { rebuildDocumentSearchTags } from "./search-tags";

// ---------------------------------------------------------------------------
// Migration tracking
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 24;

interface Migration {
  version: number;
  name: string;
  sql: string;
  postMigrate?: (db: Database.Database) => void;
}

function rebuildCanonicalTagStats(db: Database.Database): void {
  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM tag_stats").run();
    db.prepare(
      `INSERT INTO tag_stats(tag, category, count, last_updated)
       SELECT canonical_tag, category, COUNT(DISTINCT document_id), CURRENT_TIMESTAMP
       FROM document_search_tags
       GROUP BY canonical_tag, category`,
    ).run();
  });
  rebuild();
}

function ensureWebSaveDocumentSchema(db: Database.Database): void {
  const documentsTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    )
    .get();
  if (!documentsTable) return;

  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>
    ).map((column) => column.name),
  );
  const additions = [
    ["external_ids", "TEXT"],
    ["canonical_url", "TEXT"],
    ["origin_json", "TEXT"],
    ["discovery_json", "TEXT"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_canonical_url ON documents(canonical_url);
    CREATE INDEX IF NOT EXISTS idx_documents_doi
      ON documents(json_extract(external_ids, '$.doi'));
    CREATE INDEX IF NOT EXISTS idx_documents_arxiv_id
      ON documents(json_extract(external_ids, '$.arxivId'));
    CREATE INDEX IF NOT EXISTS idx_documents_openalex_id
      ON documents(json_extract(external_ids, '$.openAlexId'));

    CREATE TABLE IF NOT EXISTS web_search_saved_results (
      session_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      save_mode TEXT NOT NULL CHECK (
        save_mode IN ('metadata_only', 'save_content', 'download_pdf')
      ),
      pdf_source_url TEXT,
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, result_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_web_search_saved_results_document
      ON web_search_saved_results(document_id);
  `);
}

function migrateSecretsToStore(db: Database.Database): void {
  const secretStore = getSecretStore();
  const migrations = [
    {
      table: "llm_provider_settings",
      idColumn: "provider",
      prefix: "llm-provider",
    },
    {
      table: "llm_connections",
      idColumn: "id",
      prefix: "llm-connection",
    },
    {
      table: "embedding_provider_settings",
      idColumn: "provider",
      prefix: "embedding-provider",
    },
    {
      table: "web_search_connections",
      idColumn: "id",
      prefix: "web-search-connection",
    },
  ] as const;

  for (const migration of migrations) {
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(migration.table);
    if (!tableExists) continue;
    const rows = db
      .prepare(
        `SELECT ${migration.idColumn} AS id, api_key, secret_ref
         FROM ${migration.table}
         WHERE api_key IS NOT NULL AND trim(api_key) != ''`,
      )
      .all() as Array<{ id: string; api_key: string; secret_ref: string | null }>;
    const update = db.prepare(
      `UPDATE ${migration.table}
       SET secret_ref = ?, api_key = NULL
       WHERE ${migration.idColumn} = ?`,
    );
    for (const row of rows) {
      const reference = row.secret_ref || `${migration.prefix}:${row.id}`;
      secretStore.set(reference, row.api_key);
      update.run(reference, row.id);
    }
  }
}

function ensureW7Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_provider_settings (
      provider TEXT PRIMARY KEY,
      model TEXT,
      base_url TEXT,
      api_key TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const columns = [
    ["llm_provider_settings", "secret_ref", "TEXT"],
    ["llm_connections", "secret_ref", "TEXT"],
    ["embedding_provider_settings", "secret_ref", "TEXT"],
    ["web_search_connections", "secret_ref", "TEXT"],
    ["web_search_summaries", "latency_ms", "INTEGER"],
    ["web_search_summaries", "estimated_tokens", "INTEGER"],
    ["web_search_summaries", "cited_claims", "INTEGER NOT NULL DEFAULT 0"],
    ["web_search_summaries", "uncited_claims", "INTEGER NOT NULL DEFAULT 0"],
    ["web_search_summaries", "evidence_insufficient", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [table, column, definition] of columns) {
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!tableExists) continue;
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!existing.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  migrateSecretsToStore(db);
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
  {
    version: 10,
    name: "summary-level-cache",
    sql: `
      ALTER TABLE documents ADD COLUMN summary_zh_level TEXT
        CHECK (summary_zh_level IN ('short', 'detailed'));
      ALTER TABLE documents ADD COLUMN summary_en_level TEXT
        CHECK (summary_en_level IN ('short', 'detailed'));

      UPDATE documents
      SET summary_zh_level = 'short'
      WHERE summary_zh IS NOT NULL AND trim(summary_zh) != '';

      UPDATE documents
      SET summary_en_level = 'short'
      WHERE summary_en IS NOT NULL AND trim(summary_en) != '';
    `,
  },
  {
    version: 11,
    name: "dynamic-embedding-index",
    sql: `
      ALTER TABLE embedding_index_metadata ADD COLUMN provider TEXT;
      ALTER TABLE embedding_index_metadata ADD COLUMN model TEXT;
      ALTER TABLE embedding_index_metadata ADD COLUMN dimensions INTEGER;
      ALTER TABLE embedding_index_metadata ADD COLUMN status TEXT NOT NULL DEFAULT 'unconfigured'
        CHECK (status IN (
          'unconfigured', 'probing', 'ready', 'rebuild_required', 'rebuilding', 'failed'
        ));
      ALTER TABLE embedding_index_metadata ADD COLUMN last_error TEXT;
      ALTER TABLE embedding_index_metadata ADD COLUMN rebuild_started_at TEXT;
      ALTER TABLE embedding_index_metadata ADD COLUMN rebuild_completed_at TEXT;

      UPDATE embedding_index_metadata
      SET dimensions = 1536,
          status = 'rebuild_required'
      WHERE dimensions IS NULL;
    `,
  },
  {
    version: 12,
    name: "embedding-provider-settings",
    sql: `
      -- Stores user-configured embedding provider settings from the Profile UI.
      -- Priority: this table > environment variables > built-in defaults.
      CREATE TABLE IF NOT EXISTS embedding_provider_settings (
        provider TEXT PRIMARY KEY,      -- 'openai' | 'ollama'
        model     TEXT,
        base_url  TEXT,
        api_key   TEXT,                 -- stored locally; never returned in API responses
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 13,
    name: "llm-connections",
    sql: `
      CREATE TABLE IF NOT EXISTS llm_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preset_id TEXT,
        protocol TEXT NOT NULL CHECK (
          protocol IN ('openai_chat', 'anthropic_messages', 'gemini_generate_content', 'custom_json')
        ),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        auth_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        models_json TEXT,
        last_test_status TEXT CHECK (last_test_status IN ('success', 'failed')),
        last_test_message TEXT,
        last_test_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS llm_runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_connection_id TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (active_connection_id) REFERENCES llm_connections(id) ON DELETE SET NULL
      );
    `,
    postMigrate: migrateLegacyLlmConnections,
  },
  {
    version: 14,
    name: "canonical-document-search-tags",
    sql: `
      CREATE TABLE document_search_tags (
        document_id TEXT NOT NULL,
        canonical_tag TEXT NOT NULL,
        raw_tag TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (document_id, canonical_tag, category),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_search_tags_tag_doc
        ON document_search_tags(canonical_tag, document_id);

      CREATE INDEX idx_search_tags_doc_tag
        ON document_search_tags(document_id, canonical_tag);
    `,
    postMigrate: rebuildDocumentSearchTags,
  },
  {
    version: 15,
    name: "search-event-query-type",
    sql: "",
    postMigrate: ensureSearchEventQueryType,
  },
  {
    version: 16,
    name: "multi-vector-search-fields",
    sql: "",
    postMigrate: (db) => ensureMultiVectorSchema(db, true),
  },
  {
    version: 17,
    name: "search-event-result-diagnostics",
    sql: `
      CREATE TABLE IF NOT EXISTS search_event_results (
        event_id INTEGER NOT NULL,
        document_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        PRIMARY KEY (event_id, document_id),
        FOREIGN KEY (event_id) REFERENCES search_events(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_search_event_results_event_rank
        ON search_event_results(event_id, rank);
      CREATE INDEX IF NOT EXISTS idx_search_event_results_document
        ON search_event_results(document_id);
    `,
  },
  {
    version: 18,
    name: "canonical-tag-stats-sync",
    sql: `
      CREATE TABLE IF NOT EXISTS tag_stats (
        tag TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tag, category)
      );
      CREATE INDEX IF NOT EXISTS idx_tag_stats_category ON tag_stats(category);
      CREATE INDEX IF NOT EXISTS idx_tag_stats_count ON tag_stats(count);

      CREATE TRIGGER IF NOT EXISTS document_search_tags_stats_insert
      AFTER INSERT ON document_search_tags BEGIN
        INSERT INTO tag_stats(tag, category, count, last_updated)
        VALUES (new.canonical_tag, new.category, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(tag, category) DO UPDATE SET
          count = count + 1,
          last_updated = CURRENT_TIMESTAMP;
      END;

      CREATE TRIGGER IF NOT EXISTS document_search_tags_stats_delete
      AFTER DELETE ON document_search_tags BEGIN
        UPDATE tag_stats
        SET count = count - 1,
            last_updated = CURRENT_TIMESTAMP
        WHERE tag = old.canonical_tag
          AND category = old.category;

        DELETE FROM tag_stats
        WHERE tag = old.canonical_tag
          AND category = old.category
          AND count <= 0;
      END;
    `,
    postMigrate: rebuildCanonicalTagStats,
  },
  {
    version: 19,
    name: "canonical-content-tag-backfill",
    sql: "",
    postMigrate: rebuildDocumentSearchTags,
  },
  {
    version: 20,
    name: "web-search-session-foundation",
    sql: `
      CREATE TABLE web_search_sessions (
        id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        plan_json TEXT,
        status TEXT NOT NULL CHECK (
          status IN (
            'created', 'planning', 'searching', 'aggregating', 'summarizing',
            'completed', 'partial', 'failed', 'cancelled', 'expired'
          )
        ),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_web_search_sessions_expires
        ON web_search_sessions(expires_at, status);

      CREATE TABLE web_search_provider_runs (
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_count INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        warning TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (session_id, provider_id),
        FOREIGN KEY (session_id) REFERENCES web_search_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_web_search_provider_runs_expires
        ON web_search_provider_runs(expires_at);

      CREATE TABLE web_search_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        rank_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES web_search_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_web_search_results_session_rank
        ON web_search_results(session_id, rank_order);
      CREATE INDEX idx_web_search_results_expires
        ON web_search_results(expires_at);

      CREATE TABLE web_search_events (
        session_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id),
        FOREIGN KEY (session_id) REFERENCES web_search_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_web_search_events_created
        ON web_search_events(session_id, created_at);
    `,
  },
  {
    version: 21,
    name: "openalex-web-search-connection",
    sql: `
      CREATE TABLE web_search_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('openalex', 'tavily', 'brave', 'mcp')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_primary INTEGER NOT NULL DEFAULT 0,
        settings_json TEXT NOT NULL DEFAULT '{}',
        api_key TEXT,
        last_test_status TEXT CHECK (last_test_status IN ('success', 'failed')),
        last_test_message TEXT,
        last_tested_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_web_search_connections_provider
        ON web_search_connections(provider, enabled, is_primary);

      ALTER TABLE web_search_provider_runs ADD COLUMN estimated_credits REAL;
      ALTER TABLE web_search_provider_runs ADD COLUMN request_id TEXT;
    `,
  },
  {
    version: 22,
    name: "web-search-evidence-and-summaries",
    sql: `
      CREATE TABLE web_search_result_evidence (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES web_search_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (result_id) REFERENCES web_search_results(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_web_search_evidence_result
        ON web_search_result_evidence(session_id, result_id);
      CREATE INDEX idx_web_search_evidence_expires
        ON web_search_result_evidence(expires_at);

      CREATE TABLE web_search_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        result_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('synthesis', 'result')),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        summary_json TEXT,
        citations_json TEXT NOT NULL DEFAULT '[]',
        evidence_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES web_search_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (result_id) REFERENCES web_search_results(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_web_search_summary_cache
        ON web_search_summaries(session_id, kind, COALESCE(result_id, ''));
      CREATE INDEX idx_web_search_summaries_expires
        ON web_search_summaries(expires_at);

      CREATE TABLE web_content_cache (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        canonical_url TEXT,
        content_type TEXT NOT NULL,
        title TEXT,
        author TEXT,
        published_at TEXT,
        text_content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_web_content_cache_expires
        ON web_content_cache(expires_at);
    `,
  },
  {
    version: 23,
    name: "web-search-save-and-document-origin",
    sql: "",
    postMigrate: ensureWebSaveDocumentSchema,
  },
  {
    version: 24,
    name: "secure-secrets-web-search-observability",
    sql: `
      CREATE TABLE web_search_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'search', 'result_open', 'summary_synthesis', 'summary_result',
            'save', 'favorite', 'pdf_download', 'aggregation'
          )
        ),
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        estimated_tokens INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_web_search_usage_events_created
        ON web_search_usage_events(created_at, event_type);
      CREATE INDEX idx_web_search_usage_events_session
        ON web_search_usage_events(session_id, created_at);

      CREATE TABLE web_search_maintenance_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_cleanup_at TEXT,
        last_cleanup_json TEXT,
        last_recovery_at TEXT,
        last_recovery_json TEXT
      );
    `,
    postMigrate: ensureW7Schema,
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

function migrateLegacyLlmConnections(db: Database.Database): void {
  const legacyRows = db
    .prepare("SELECT provider, api_key, model, base_url FROM llm_provider_settings")
    .all() as Array<{
    provider: string;
    api_key: string | null;
    model: string | null;
    base_url: string | null;
  }>;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO llm_connections(
       id, name, preset_id, protocol, base_url, model, api_key,
       auth_json, request_json, models_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of legacyRows) {
    const preset = getLlmProviderPreset(row.provider);
    if (!preset) continue;
    const id = `legacy-${row.provider}`;
    insert.run(
      id,
      preset.label,
      preset.id,
      preset.protocol,
      row.base_url?.trim() || preset.baseUrl,
      row.model?.trim() || preset.defaultModel,
      row.api_key,
      JSON.stringify(preset.auth),
      JSON.stringify(preset.request),
      preset.models ? JSON.stringify(preset.models) : null,
    );
  }

  const count = db.prepare("SELECT COUNT(*) AS count FROM llm_connections").get() as {
    count: number;
  };
  if (count.count === 0) {
    const preset = getLlmProviderPreset("deepseek");
    if (!preset) throw new Error("Built-in DeepSeek preset is missing.");
    insert.run(
      "default-deepseek",
      preset.label,
      preset.id,
      preset.protocol,
      preset.baseUrl,
      preset.defaultModel,
      null,
      JSON.stringify(preset.auth),
      JSON.stringify(preset.request),
      preset.models ? JSON.stringify(preset.models) : null,
    );
  }

  const selected = db.prepare("SELECT value FROM user_preferences WHERE key = 'llm_provider'").get() as
    | { value: string }
    | undefined;
  const preferredId = selected
    ? `legacy-${selected.value}`
    : legacyRows.some((row) => row.provider === "deepseek")
      ? "legacy-deepseek"
      : "default-deepseek";
  const preferredExists = db.prepare("SELECT 1 FROM llm_connections WHERE id = ?").get(preferredId);
  const fallback = db
    .prepare(
      `SELECT id FROM llm_connections
       ORDER BY CASE WHEN preset_id = 'deepseek' THEN 0 ELSE 1 END, created_at, id
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  db.prepare(
    `INSERT INTO llm_runtime_settings(id, active_connection_id)
     VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET active_connection_id = excluded.active_connection_id`,
  ).run(preferredExists ? preferredId : (fallback?.id ?? null));
}

function ensureSearchEventQueryType(db: Database.Database): void {
  const searchEventsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_events'")
    .get();
  if (!searchEventsTable) return;

  const columns = db.prepare("PRAGMA table_info(search_events)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "query_type")) {
    db.exec("ALTER TABLE search_events ADD COLUMN query_type TEXT NOT NULL DEFAULT 'unknown'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_events_query_type ON search_events(query_type, created_at)");
}

export function runMigrations(): void {
  const db = getDb();
  const current = getCurrentVersion(db);

  if (current >= CURRENT_SCHEMA_VERSION) {
    console.log(`[db] Schema up to date (v${current})`);
    assertDatabaseIntegrity(db);
    return;
  }

  const backupPath = current > 0 ? createMigrationBackup(db, current) : undefined;
  try {
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
    assertDatabaseIntegrity(db);
    console.log(`[db] Migrations complete. Now at v${finalVersion}`);
  } catch (error) {
    const backupMessage = backupPath ? ` Backup retained at ${backupPath}.` : "";
    throw new Error(
      `Database migration failed.${backupMessage} ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function createMigrationBackup(db: Database.Database, version: number): string | undefined {
  const dbPath = customDbPath ?? getDbPath();
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) return undefined;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // DELETE journal mode and read-only test fixtures do not require a checkpoint.
  }
  const backupPath = `${dbPath}.pre-v${CURRENT_SCHEMA_VERSION}-from-v${version}.bak`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error(
      `Database quick_check failed: ${rows.map((row) => row.quick_check).join(", ") || "unknown"}`,
    );
  }
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
  const hasMetadataTable = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_metadata'")
      .get(),
  );
  const metadata = hasMetadataTable
    ? (db
        .prepare(
          `SELECT dimensions
           FROM embedding_index_metadata
           WHERE id = 1`,
        )
        .get() as { dimensions?: number | null } | undefined)
    : undefined;
  const dimensions =
    Number.isSafeInteger(metadata?.dimensions) &&
    Number(metadata?.dimensions) >= 32 &&
    Number(metadata?.dimensions) <= 8192
      ? Number(metadata?.dimensions)
      : 1536;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors_v2 USING vec0(
      document_id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    );
  `);
  ensureMultiVectorSchema(db, false, dimensions);
  console.log("[db] sqlite-vec schema ready");
}

function ensureMultiVectorSchema(
  db: Database.Database,
  resetIndexState: boolean,
  requestedDimensions?: number,
): void {
  const documentsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get();
  if (!documentsTable) return;

  const metadataTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_metadata'")
    .get();
  const metadata =
    requestedDimensions === undefined && metadataTable
      ? (db.prepare("SELECT dimensions FROM embedding_index_metadata WHERE id = 1").get() as
          | { dimensions?: number | null }
          | undefined)
      : undefined;
  const dimensions =
    requestedDimensions ??
    (Number.isSafeInteger(metadata?.dimensions) &&
    Number(metadata?.dimensions) >= 32 &&
    Number(metadata?.dimensions) <= 8192
      ? Number(metadata?.dimensions)
      : 1536);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_title_abstract_vectors_v2 USING vec0(
      document_id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_tag_vectors_v2 USING vec0(
      document_id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    );

    CREATE TRIGGER IF NOT EXISTS document_multivectors_update
    AFTER UPDATE OF title, abstract, summary_zh, summary_en, authors,
      domain_tags, model_tags, source, source_tag, type_tag, year_tag, full_text
    ON documents BEGIN
      DELETE FROM document_title_abstract_vectors_v2 WHERE document_id = new.id;
      DELETE FROM document_tag_vectors_v2 WHERE document_id = new.id;
    END;

    CREATE TRIGGER IF NOT EXISTS document_multivectors_delete
    AFTER DELETE ON documents BEGIN
      DELETE FROM document_title_abstract_vectors_v2 WHERE document_id = old.id;
      DELETE FROM document_tag_vectors_v2 WHERE document_id = old.id;
    END;
  `);

  if (resetIndexState) {
    const indexStateTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_index_state'")
      .get();
    if (indexStateTable) {
      db.exec(`
        UPDATE document_index_state
        SET embedding_status = 'pending',
            vector_indexed_at = NULL,
            updated_at = datetime('now')
      `);
    }
    if (metadataTable) {
      db.prepare(
        `UPDATE embedding_index_metadata
         SET status = CASE WHEN status = 'unconfigured' THEN status ELSE 'rebuilding' END,
             updated_at = datetime('now')
         WHERE id = 1`,
      ).run();
    }
  }
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
