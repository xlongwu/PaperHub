import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLlmConnection,
  deleteLlmConnection,
  getActiveLlmConnection,
  listLlmConnections,
  saveLlmConnection,
} from "@/db/llm-connections";
import { clearDbPath, closeDb, initDatabase, setDbPath } from "@/db/index";
import { createLlmConnectionInputFromPreset } from "@/providers/connections";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-llm-connections.db");

afterEach(() => {
  closeDb();
  clearDbPath();
  safeUnlink(TEST_DB_PATH);
});

describe("LLM connection storage", () => {
  it("creates a default connection and supports multiple named connections", () => {
    setDbPath(TEST_DB_PATH);
    initDatabase();
    expect(getActiveLlmConnection()?.presetId).toBe("deepseek");

    const openai = createLlmConnectionInputFromPreset("openai", "Work OpenAI");
    const saved = saveLlmConnection({ ...openai, apiKey: "stored-secret" });
    expect(saved.hasApiKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("stored-secret");

    activateLlmConnection(saved.id);
    expect(getActiveLlmConnection()?.id).toBe(saved.id);
    expect(() => deleteLlmConnection(saved.id)).toThrow("active");
    expect(listLlmConnections()).toHaveLength(2);
  });

  it("migrates legacy provider rows and restores the selected provider", () => {
    const legacy = new Database(TEST_DB_PATH);
    legacy.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_version(version) VALUES (12);
      CREATE TABLE user_preferences(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO user_preferences(key, value) VALUES ('llm_provider', 'openai');
      CREATE TABLE llm_provider_settings(
        provider TEXT PRIMARY KEY,
        api_key TEXT,
        model TEXT,
        base_url TEXT,
        updated_at TEXT
      );
      INSERT INTO llm_provider_settings(provider, api_key, model, base_url)
      VALUES ('openai', 'legacy-secret', 'legacy-model', 'https://legacy.example/v1');
    `);
    legacy.close();

    setDbPath(TEST_DB_PATH);
    initDatabase();
    const active = getActiveLlmConnection();
    expect(active).toMatchObject({
      id: "legacy-openai",
      presetId: "openai",
      model: "legacy-model",
      baseUrl: "https://legacy.example/v1",
      apiKey: "legacy-secret",
    });
  });
});
