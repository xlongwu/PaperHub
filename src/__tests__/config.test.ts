import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import {
  getCacheDir,
  getDataDir,
  getDbPath,
  getLogsDir,
  loadConfig,
  loadPaperHubConfig,
  toRepoConfig,
} from "../config";
import { resetDir, testPath } from "./test-utils";

// ---------------------------------------------------------------------------
// toRepoConfig
// ---------------------------------------------------------------------------

describe("toRepoConfig", () => {
  it("converts a basic entry", () => {
    const result = toRepoConfig({ id: "test", repo: "org/test", name: "Test" });
    expect(result).toEqual({ id: "test", repo: "org/test", name: "Test" });
  });

  it("includes paginated when true", () => {
    const result = toRepoConfig({ id: "test", repo: "org/test", name: "Test", paginated: true });
    expect(result).toEqual({ id: "test", repo: "org/test", name: "Test", paginated: true });
  });

  it("omits paginated when false", () => {
    const result = toRepoConfig({ id: "test", repo: "org/test", name: "Test", paginated: false });
    expect(result).not.toHaveProperty("paginated");
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns defaults when config file does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const config = loadConfig("/nonexistent/config.yml");
    expect(config.cliRepos.length).toBeGreaterThan(0);
    expect(config.skillsRepo).toBe("anthropics/skills");
    expect(config.openclaw.id).toBe("openclaw");
    expect(config.openclawPeers.length).toBeGreaterThan(0);
  });

  it("loads cli_repos from valid YAML", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(`
cli_repos:
  - id: custom
    repo: org/custom
    name: Custom Tool
skills_repo: custom/skills
`);
    const config = loadConfig("test.yml");
    expect(config.cliRepos).toHaveLength(1);
    expect(config.cliRepos[0]!.id).toBe("custom");
    expect(config.skillsRepo).toBe("custom/skills");
  });

  it("falls back to defaults for empty cli_repos", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("cli_repos: []");
    const config = loadConfig("test.yml");
    expect(config.cliRepos.length).toBeGreaterThan(0);
    expect(config.cliRepos[0]!.id).toBe("claude-code");
  });

  it("falls back to defaults for empty skills_repo", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("skills_repo: ''");
    const config = loadConfig("test.yml");
    expect(config.skillsRepo).toBe("anthropics/skills");
  });

  it("parses openclaw from YAML", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(`
openclaw:
  id: myclaw
  repo: org/myclaw
  name: MyClaw
  paginated: true
`);
    const config = loadConfig("test.yml");
    expect(config.openclaw).toEqual({ id: "myclaw", repo: "org/myclaw", name: "MyClaw", paginated: true });
  });

  it("falls back to default openclaw when incomplete", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("openclaw:\n  id: partial\n");
    const config = loadConfig("test.yml");
    expect(config.openclaw.id).toBe("openclaw"); // default
  });
});

describe("PaperHub path overrides", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetDir(testPath("config-overrides"));
  });

  it("prefers environment overrides for data directories and db file", () => {
    const dataDir = testPath("config-overrides", "data");
    const dbPath = testPath("config-overrides", "db", "paperhub.db");
    const logsDir = testPath("config-overrides", "logs");
    const cacheDir = testPath("config-overrides", "cache");

    vi.stubEnv("PAPERHUB_DATA_DIR", dataDir);
    vi.stubEnv("PAPERHUB_DB_PATH", dbPath);
    vi.stubEnv("PAPERHUB_LOGS_DIR", logsDir);
    vi.stubEnv("PAPERHUB_CACHE_DIR", cacheDir);

    expect(getDataDir()).toBe(dataDir);
    expect(getDbPath()).toBe(dbPath);
    expect(getLogsDir()).toBe(logsDir);
    expect(getCacheDir()).toBe(cacheDir);
  });
});

describe("loadPaperHubConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("lets PAPERHUB_PORT override the default or file-configured port", () => {
    vi.stubEnv("PAPERHUB_PORT", "4310");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const config = loadPaperHubConfig("/nonexistent/paperhub.yml");

    expect(config.port).toBe(4310);
  });
});
