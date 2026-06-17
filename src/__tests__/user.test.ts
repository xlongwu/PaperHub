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
import fs from "node:fs";

const TEST_DB_PATH = "/tmp/paperhub-user-test.db";

beforeEach(() => {
  closeDb();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  setDbPath(TEST_DB_PATH);
  initDatabase();
});

afterAll(() => {
  closeDb();
  clearDbPath();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

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
    recordHistory("doc-1");
    recordHistory("doc-2");
    const history = getHistory();
    expect(history.length).toBe(2);
    expect(history[0]!.documentId).toBe("doc-2");
  });

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) recordHistory(`doc-${i}`);
    const page = getHistory({ limit: 2, offset: 0 });
    expect(page.length).toBe(2);
  });

  it("counts history", () => {
    recordHistory("doc-1");
    expect(countHistory()).toBe(1);
  });
});

describe("Favorites", () => {
  it("adds and retrieves favorites", () => {
    addFavorite("doc-1");
    addFavorite("doc-2");
    const favs = getFavorites();
    expect(favs.length).toBe(2);
    expect(isFavorite("doc-1")).toBe(true);
  });

  it("removes favorites", () => {
    addFavorite("doc-1");
    removeFavorite("doc-1");
    expect(isFavorite("doc-1")).toBe(false);
    expect(countFavorites()).toBe(0);
  });

  it("handles duplicate adds gracefully", () => {
    addFavorite("doc-1");
    addFavorite("doc-1");
    expect(countFavorites()).toBe(1);
  });
});
