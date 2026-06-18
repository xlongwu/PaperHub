/**
 * User database tests.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { initDatabase, closeDb, setDbPath, clearDbPath } from "@/db/index";
import {
  getUserPreference,
  setUserPreference,
  getUserPreferences,
  initDefaultPreferences,
  recordHistory,
  getHistory,
  countHistory,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavorites,
  countFavorites,
} from "@/db/user";
import { insertDocument } from "@/db/documents";
import { getStoredLlmProviderSettings, saveStoredLlmProviderSettings } from "@/db/llm-settings";
import type { Document } from "@/types";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-user-test.db");

beforeEach(() => {
  closeDb();
  safeUnlink(TEST_DB_PATH);
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  safeUnlink(TEST_DB_PATH);
});

function makeDoc(id: string): Document {
  return {
    id,
    title: `User Test ${id}`,
    source: "arxiv",
    url: `https://example.com/${id}`,
    publishedAt: "2026-06-15T00:00:00Z",
    authors: [],
    abstract: "User test document",
    language: "en",
    domainTags: [],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-16T00:00:00Z",
    updatedAt: "2026-06-16T00:00:00Z",
    isSummarized: false,
  };
}

describe("User preferences", () => {
  it("sets and gets a preference", () => {
    setUserPreference("test_key", "test_value");
    expect(getUserPreference("test_key")).toBe("test_value");
  });

  it("returns null for missing preference", () => {
    expect(getUserPreference("nonexistent")).toBeNull();
  });

  it("updates existing preference", () => {
    setUserPreference("lang", "zh");
    setUserPreference("lang", "en");
    expect(getUserPreference("lang")).toBe("en");
  });

  it("returns all preferences", () => {
    setUserPreference("a", "1");
    setUserPreference("b", "2");
    const all = getUserPreferences();
    expect(all["a"]).toBe("1");
    expect(all["b"]).toBe("2");
  });

  it("initializes default preferences", () => {
    initDefaultPreferences();
    const prefs = getUserPreferences();
    expect(prefs["default_language"]).toBe("zh");
    expect(prefs["summary_length"]).toBe("short");
    expect(prefs["daily_recommend_count"]).toBe("10");
    expect(JSON.parse(prefs["interest_tags"] ?? "[]")).toContain("AI");
  });

  it("does not overwrite existing preferences on init", () => {
    setUserPreference("default_language", "en");
    initDefaultPreferences();
    expect(getUserPreference("default_language")).toBe("en");
  });
});

describe("Browsing history", () => {
  it("records and retrieves history", () => {
    insertDocument(makeDoc("doc-1"));
    insertDocument(makeDoc("doc-2"));
    recordHistory("doc-1");
    recordHistory("doc-2");
    const history = getHistory();
    expect(history.length).toBe(2);
    expect(history[0]!.documentId).toBe("doc-2");
  });

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      insertDocument(makeDoc(`doc-${i}`));
      recordHistory(`doc-${i}`);
    }
    const page = getHistory({ limit: 2, offset: 0 });
    expect(page.length).toBe(2);
  });

  it("counts history", () => {
    insertDocument(makeDoc("doc-1"));
    recordHistory("doc-1");
    expect(countHistory()).toBe(1);
  });
});

describe("LLM provider settings", () => {
  it("stores provider credentials outside general preferences", () => {
    saveStoredLlmProviderSettings("deepseek", {
      apiKey: "sk-local-only",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    });

    expect(getStoredLlmProviderSettings("deepseek")).toEqual({
      provider: "deepseek",
      apiKey: "sk-local-only",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    });
    expect(Object.values(getUserPreferences())).not.toContain("sk-local-only");
  });

  it("preserves an existing key when only model settings change", () => {
    saveStoredLlmProviderSettings("openai", { apiKey: "sk-existing" });
    saveStoredLlmProviderSettings("openai", { model: "gpt-4o-mini" });

    expect(getStoredLlmProviderSettings("openai")).toMatchObject({
      apiKey: "sk-existing",
      model: "gpt-4o-mini",
    });
  });
});

describe("Favorites", () => {
  it("adds and retrieves favorites", () => {
    insertDocument(makeDoc("doc-1"));
    insertDocument(makeDoc("doc-2"));
    addFavorite("doc-1");
    addFavorite("doc-2");
    const favs = getFavorites();
    expect(favs.length).toBe(2);
    expect(isFavorite("doc-1")).toBe(true);
  });

  it("removes favorites", () => {
    insertDocument(makeDoc("doc-1"));
    addFavorite("doc-1");
    removeFavorite("doc-1");
    expect(isFavorite("doc-1")).toBe(false);
    expect(countFavorites()).toBe(0);
  });

  it("handles duplicate adds gracefully", () => {
    insertDocument(makeDoc("doc-1"));
    addFavorite("doc-1");
    addFavorite("doc-1");
    expect(countFavorites()).toBe(1);
  });
});
