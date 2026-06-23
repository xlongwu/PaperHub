import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "@/api/server";
import { clearDbPath, closeDb, CURRENT_SCHEMA_VERSION, getDb, initDatabase, setDbPath } from "@/db/index";
import {
  createWebSearchSessionRecord,
  getWebSearchSession,
  insertWebSearchResults,
  recoverInterruptedWebSearchState,
  updateWebSearchSession,
  updateWebSearchResultLocalState,
} from "@/db/web-search";
import { getWebSearchMetrics, recordWebSearchUsageEvent } from "@/db/web-search-metrics";
import { saveLlmConnection } from "@/db/llm-connections";
import { saveStoredEmbeddingSettings } from "@/db/embedding-settings";
import { saveWebSearchConnection } from "@/db/web-search-connections";
import {
  createMemorySecretStore,
  getSecretStore,
  setSecretStoreForTests,
  type SecretStore,
} from "@/security/secret-store";
import { redactLogValue, redactSensitiveText } from "@/security/redaction";
import { safeFetch } from "@/web-search/safe-fetch";
import type { WebSearchResult } from "@/web-search/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-w7-test.db");

beforeEach(() => {
  closeDb();
  cleanupFiles();
  setSecretStoreForTests(createMemorySecretStore());
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterEach(() => {
  closeDb();
  clearDbPath();
  setSecretStoreForTests(createMemorySecretStore());
  cleanupFiles();
});

describe("W7 SecretStore and migration", () => {
  it("keeps LLM, embedding, and Web Search credentials out of SQLite", () => {
    saveLlmConnection({
      id: "secure-llm",
      name: "Secure LLM",
      presetId: "deepseek",
      protocol: "openai_chat",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: "sk-llm-secret-value",
      auth: { type: "bearer" },
      request: {
        method: "POST",
        path: "/chat/completions",
        headers: {},
        body: {},
        responsePath: "$.choices[0].message.content",
      },
      models: null,
    });
    saveStoredEmbeddingSettings({
      provider: "openai",
      apiKey: "sk-embedding-secret-value",
    });
    saveWebSearchConnection({
      id: "secure-web",
      provider: "tavily",
      name: "Secure Web",
      settings: { baseUrl: "https://api.tavily.com" },
      apiKey: "tvly-secret-value",
    });

    const rows = [
      getDb().prepare("SELECT api_key, secret_ref FROM llm_connections WHERE id = ?").get("secure-llm"),
      getDb()
        .prepare("SELECT api_key, secret_ref FROM embedding_provider_settings WHERE provider = ?")
        .get("openai"),
      getDb()
        .prepare("SELECT api_key, secret_ref FROM web_search_connections WHERE id = ?")
        .get("secure-web"),
    ] as Array<{ api_key: string | null; secret_ref: string | null }>;

    expect(rows.every((row) => row.api_key === null && Boolean(row.secret_ref))).toBe(true);
    expect(getSecretStore().get("llm-connection:secure-llm")).toBe("sk-llm-secret-value");
    expect(fs.readFileSync(TEST_DB_PATH).toString("latin1")).not.toContain("secret-value");
  });

  it("migrates v23 plaintext credentials through the current schema and is idempotent on restart", () => {
    downgradeToV23WithPlaintextSecret();
    initDatabase();

    const row = getDb()
      .prepare("SELECT api_key, secret_ref FROM web_search_connections WHERE id = 'legacy-web'")
      .get() as { api_key: string | null; secret_ref: string | null };
    expect(row.api_key).toBeNull();
    expect(row.secret_ref).toBe("web-search-connection:legacy-web");
    expect(getSecretStore().get(row.secret_ref!)).toBe("legacy-plaintext-key");
    expect(currentVersion()).toBe(CURRENT_SCHEMA_VERSION);

    closeDb();
    initDatabase();
    expect(currentVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("rolls back the current upgrade and retains a backup when secret migration fails", () => {
    downgradeToV23WithPlaintextSecret();
    setSecretStoreForTests(new ThrowingSecretStore());

    expect(() => initDatabase()).toThrow(/Backup retained/);
    expect(currentVersion()).toBe(23);
    expect(fs.existsSync(`${TEST_DB_PATH}.pre-v${CURRENT_SCHEMA_VERSION}-from-v23.bak`)).toBe(true);
  });
});

describe("W7 observability and recovery", () => {
  it("aggregates local-only provider, summary, and usage metrics", () => {
    const now = new Date().toISOString();
    createWebSearchSessionRecord({
      id: "metrics-session",
      request: { query: "not persisted in metrics", scope: "academic" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    getDb()
      .prepare(
        `INSERT INTO web_search_provider_runs(
           session_id, provider_id, status, result_count, latency_ms, estimated_credits,
           started_at, completed_at, created_at, updated_at, expires_at
         ) VALUES (?, 'arxiv', 'success', 4, 120, 0.25, ?, ?, ?, ?, ?)`,
      )
      .run("metrics-session", now, now, now, now, new Date(Date.now() + 60_000).toISOString());
    recordWebSearchUsageEvent({
      sessionId: "metrics-session",
      eventType: "search",
    });
    recordWebSearchUsageEvent({
      sessionId: "metrics-session",
      eventType: "summary_result",
      durationMs: 300,
      estimatedTokens: 42,
      metadata: { citedClaims: 2, uncitedClaims: 0, evidenceInsufficient: 0 },
    });

    const metrics = getWebSearchMetrics(
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(metrics.providers[0]).toMatchObject({
      providerId: "arxiv",
      calls: 1,
      successRate: 1,
      p95LatencyMs: 120,
      estimatedCredits: 0.25,
    });
    expect(metrics.summaries).toMatchObject({
      attempts: 1,
      citationMappingAccuracy: 1,
      estimatedTokens: 42,
    });
    expect(JSON.stringify(metrics)).not.toContain("not persisted in metrics");
  });

  it("recovers interrupted sessions and hanging save states", () => {
    const session = createWebSearchSessionRecord({
      id: "interrupted-session",
      request: { query: "recovery", scope: "academic" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    updateWebSearchSession({ id: session.id, status: "searching" });
    const result = sampleResult(session.id);
    insertWebSearchResults([result]);
    updateWebSearchResultLocalState(session.id, result.id, { status: "saving" });

    const recovered = recoverInterruptedWebSearchState();
    expect(recovered).toEqual({ sessions: 1, savingResults: 1 });
    expect(getWebSearchSession(session.id)?.status).toBe("partial");
    expect(getWebSearchSession(session.id)?.results[0]?.localState.status).toBe("save_failed");
  });
});

describe("W7 security boundaries", () => {
  it("redacts credential-shaped strings and sensitive object fields", () => {
    expect(redactSensitiveText("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactLogValue({ apiKey: "sk-example-secret", nested: { token: "token-value" } })).toEqual({
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]" },
    });
  });

  it("rejects mapped loopback addresses, oversized headers, and oversized decoded bodies", async () => {
    await expect(
      safeFetch("https://example.test", {
        resolveHostname: async () => ["::ffff:127.0.0.1"],
        fetchImpl: async () => new Response("never"),
      }),
    ).rejects.toThrow(/private|reserved/);

    await expect(
      safeFetch("https://example.test", {
        resolveHostname: async () => ["93.184.216.34"],
        fetchImpl: async () =>
          new Response("ok", {
            headers: {
              "content-type": "text/plain",
              "x-large": "x".repeat(70 * 1024),
            },
          }),
      }),
    ).rejects.toThrow(/headers are too large/);

    await expect(
      safeFetch("https://example.test", {
        resolveHostname: async () => ["93.184.216.34"],
        maxBytes: 8,
        fetchImpl: async () =>
          new Response("decoded content is larger", {
            headers: { "content-type": "text/plain" },
          }),
      }),
    ).rejects.toThrow(/size limit/);
  });

  it("serves CSP and restrictive browser security headers", async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server failed.");
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps Electron navigation, permissions, and SecretStore bootstrap hardened", () => {
    const source = fs.readFileSync(path.resolve("desktop/main.cjs"), "utf8");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("setWindowOpenHandler");
    expect(source).toContain("setPermissionRequestHandler");
    expect(source).toContain("safeStorage.encryptString");
    expect(source).toContain("PAPERHUB_SECRET_KEY_B64");
  });

  it("excludes personal state from desktop releases and runs a privacy gate", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      build: { files: string[] };
    };
    const buildScript = fs.readFileSync(path.resolve("scripts/build-desktop.mjs"), "utf8");
    const privacyScript = fs.readFileSync(path.resolve("scripts/verify-release-privacy.mjs"), "utf8");

    expect(packageJson.build.files).not.toContain("digests/**/*");
    expect(packageJson.build.files).toEqual(
      expect.arrayContaining([
        "!**/.env",
        "!**/*.db",
        "!**/*.log",
        "!data/**",
        "!logs/**",
        "!secrets/**",
        "!digests/**",
        "!src/__tests__/**",
        "!src/test-support/**",
        "!scripts/**",
      ]),
    );
    expect(buildScript).toContain("await verifyReleasePrivacy()");
    expect(privacyScript).toContain("configured credential");
    expect(privacyScript).toContain("paperhub-secret-key.bin");
  });

  it("rejects packaged private files and configured credential values", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperhub-release-privacy-"));
    const appDir = path.join(fixtureRoot, "app");
    const projectDir = path.join(fixtureRoot, "project");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".env"), "OPENAI_API_KEY=sk-test-private-release-value-12345\n");
    fs.writeFileSync(path.join(appDir, "safe.js"), "console.log('safe release');\n");

    const verify = () =>
      spawnSync(
        process.execPath,
        [path.resolve("scripts/verify-release-privacy.mjs"), "--app-dir", appDir, "--root-dir", projectDir],
        { encoding: "utf8" },
      );

    try {
      expect(verify().status).toBe(0);

      fs.writeFileSync(path.join(appDir, ".env"), "SHOULD_NOT_SHIP=true\n");
      expect(verify().status).not.toBe(0);
      fs.unlinkSync(path.join(appDir, ".env"));

      fs.writeFileSync(
        path.join(appDir, "bundle.js"),
        "const key = 'sk-test-private-release-value-12345';\n",
      );
      const leaked = verify();
      expect(leaked.status).not.toBe(0);
      expect(`${leaked.stdout}${leaked.stderr}`).not.toContain("sk-test-private-release-value-12345");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

function downgradeToV23WithPlaintextSecret(): void {
  getDb()
    .prepare(
      `INSERT INTO web_search_connections(
         id, provider, name, enabled, is_primary, settings_json, api_key,
         secret_ref, created_at, updated_at
       ) VALUES (
         'legacy-web', 'tavily', 'Legacy Web', 1, 1, '{}', 'legacy-plaintext-key',
         NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
    )
    .run();
  getDb().prepare("DELETE FROM schema_version WHERE version >= 24").run();
  getDb().exec(`
    DROP TABLE web_search_usage_events;
    DROP TABLE web_search_maintenance_state;
    DROP TABLE web_search_provider_cache;
  `);
  closeDb();
}

function currentVersion(): number {
  return (getDb().prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number })
    .version;
}

function cleanupFiles(): void {
  safeUnlink(TEST_DB_PATH);
  safeUnlink(`${TEST_DB_PATH}-wal`);
  safeUnlink(`${TEST_DB_PATH}-shm`);
  safeUnlink(`${TEST_DB_PATH}.pre-v${CURRENT_SCHEMA_VERSION}-from-v23.bak`);
}

class ThrowingSecretStore implements SecretStore {
  get(): string | undefined {
    return undefined;
  }
  set(): void {
    throw new Error("SecretStore unavailable");
  }
  delete(): void {}
  has(): boolean {
    return false;
  }
}

function sampleResult(sessionId: string): WebSearchResult {
  const now = new Date().toISOString();
  return {
    id: "result-recovery",
    sessionId,
    title: "Recovery result",
    url: "https://example.com/recovery",
    authors: [],
    contentType: "technical_article",
    identifiers: {},
    origin: { domain: "example.com" },
    providerEvidence: [
      {
        providerId: "tavily",
        originalUrl: "https://example.com/recovery",
        providerRank: 1,
        retrievedAt: now,
      },
    ],
    ranking: {
      aggregateScore: 1,
      providerRrfScore: 1,
      conceptCoverageScore: 1,
      freshnessScore: 1,
      sourceQualityScore: 1,
      metadataQualityScore: 1,
    },
    match: { matchedConcepts: [], matchedFields: [], missingMustConcepts: [] },
    localState: { status: "not_saved" },
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
