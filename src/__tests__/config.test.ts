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
  });

  it("prefers environment overrides for data directories and db file", () => {
    vi.stubEnv("PAPERHUB_DATA_DIR", "/tmp/paperhub-custom-data");
    vi.stubEnv("PAPERHUB_DB_PATH", "/tmp/paperhub-custom-db/paperhub.db");
    vi.stubEnv("PAPERHUB_LOGS_DIR", "/tmp/paperhub-custom-logs");
    vi.stubEnv("PAPERHUB_CACHE_DIR", "/tmp/paperhub-custom-cache");

    expect(getDataDir()).toBe("/tmp/paperhub-custom-data");
    expect(getDbPath()).toBe("/tmp/paperhub-custom-db/paperhub.db");
    expect(getLogsDir()).toBe("/tmp/paperhub-custom-logs");
    expect(getCacheDir()).toBe("/tmp/paperhub-custom-cache");
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
