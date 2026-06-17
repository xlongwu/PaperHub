/**
 * PaperHub configuration loader.
 * Extends the legacy digest config with desktop-app specific settings.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import type { RepoConfig } from "./github";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Base data directory — ~/PaperHub */
export function getDataDir(): string {
  const dir = process.env["PAPERHUB_DATA_DIR"]?.trim() || path.join(os.homedir(), "PaperHub");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbPath(): string {
  const override = process.env["PAPERHUB_DB_PATH"]?.trim();
  if (override) {
    fs.mkdirSync(path.dirname(override), { recursive: true });
    return override;
  }

  const dbPath = path.join(getDataDir(), "data", "paperhub.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

export function getLogsDir(): string {
  const dir = process.env["PAPERHUB_LOGS_DIR"]?.trim() || path.join(getDataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCacheDir(): string {
  const dir = process.env["PAPERHUB_CACHE_DIR"]?.trim() || path.join(getDataDir(), "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// PaperHub Schema
// ---------------------------------------------------------------------------

export interface PaperHubConfig {
  /** API server port */
  port: number;
  /** arXiv categories to collect */
  arxivCategories: string[];
  /** arXiv max results per fetch */
  arxivMaxResults: number;
  /** Collection intervals (cron expressions) */
  intervals: {
    arxiv: string;
    gptBlog: string;
    claudeBlog: string;
  };
  /** LLM provider for summaries */
  llmProvider: string;
  /** Default user preferences */
  defaults: {
    language: "zh" | "en";
    summaryLength: "short" | "detailed";
    dailyRecommendCount: number;
  };
}

// ---------------------------------------------------------------------------
// PaperHub Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PaperHubConfig = {
  port: 3000,
  arxivCategories: ["cs.AI", "cs.CL", "cs.LG", "cs.CV", "cs.IR"],
  arxivMaxResults: 50,
  intervals: {
    arxiv: "0 0 */6 * * *", // every 6 hours
    gptBlog: "0 */30 * * * *", // every 30 minutes
    claudeBlog: "0 */30 * * * *", // every 30 minutes
  },
  llmProvider: "deepseek",
  defaults: {
    language: "zh",
    summaryLength: "short",
    dailyRecommendCount: 10,
  },
};

// ---------------------------------------------------------------------------
// PaperHub Loader
// ---------------------------------------------------------------------------

export function loadPaperHubConfig(configPath = "paperhub.yml"): PaperHubConfig {
  const resolved = path.resolve(configPath);
  const envPort = parsePositiveInteger(process.env["PAPERHUB_PORT"]);

  if (!fs.existsSync(resolved)) {
    console.log(`[config] ${configPath} not found — using built-in defaults.`);
    return { ...DEFAULT_CONFIG, port: envPort ?? DEFAULT_CONFIG.port };
  }

  const raw = yaml.load(fs.readFileSync(resolved, "utf-8")) as Partial<PaperHubConfig>;

  return {
    port: envPort ?? raw.port ?? DEFAULT_CONFIG.port,
    arxivCategories: raw.arxivCategories ?? DEFAULT_CONFIG.arxivCategories,
    arxivMaxResults: raw.arxivMaxResults ?? DEFAULT_CONFIG.arxivMaxResults,
    intervals: {
      arxiv: raw.intervals?.arxiv ?? DEFAULT_CONFIG.intervals.arxiv,
      gptBlog: raw.intervals?.gptBlog ?? DEFAULT_CONFIG.intervals.gptBlog,
      claudeBlog: raw.intervals?.claudeBlog ?? DEFAULT_CONFIG.intervals.claudeBlog,
    },
    llmProvider: raw.llmProvider ?? DEFAULT_CONFIG.llmProvider,
    defaults: {
      language: raw.defaults?.language ?? DEFAULT_CONFIG.defaults.language,
      summaryLength: raw.defaults?.summaryLength ?? DEFAULT_CONFIG.defaults.summaryLength,
      dailyRecommendCount: raw.defaults?.dailyRecommendCount ?? DEFAULT_CONFIG.defaults.dailyRecommendCount,
    },
  };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Legacy compatibility (preserved for existing code/tests)
// ---------------------------------------------------------------------------

interface RawRepoEntry {
  id: string;
  repo: string;
  name: string;
  paginated?: boolean;
}

interface RawConfig {
  cli_repos?: RawRepoEntry[];
  skills_repo?: string;
  openclaw?: RawRepoEntry;
  openclaw_peers?: RawRepoEntry[];
}

export interface RadarConfig {
  cliRepos: RepoConfig[];
  skillsRepo: string;
  openclaw: RepoConfig;
  openclawPeers: RepoConfig[];
}

const DEFAULT_CLI_REPOS: RepoConfig[] = [
  { id: "claude-code", repo: "anthropics/claude-code", name: "Claude Code" },
  { id: "codex", repo: "openai/codex", name: "OpenAI Codex" },
  { id: "gemini-cli", repo: "google-gemini/gemini-cli", name: "Gemini CLI" },
  { id: "copilot-cli", repo: "github/copilot-cli", name: "GitHub Copilot CLI" },
  { id: "kimi-cli", repo: "MoonshotAI/kimi-cli", name: "Kimi Code CLI" },
  { id: "opencode", repo: "anomalyco/opencode", name: "OpenCode" },
  { id: "qwen-code", repo: "QwenLM/qwen-code", name: "Qwen Code" },
];

const DEFAULT_SKILLS_REPO = "anthropics/skills";

const DEFAULT_OPENCLAW: RepoConfig = {
  id: "openclaw",
  repo: "openclaw/openclaw",
  name: "OpenClaw",
  paginated: true,
};

const DEFAULT_OPENCLAW_PEERS: RepoConfig[] = [
  { id: "nanobot", repo: "HKUDS/nanobot", name: "NanoBot", paginated: true },
  { id: "hermes-agent", repo: "nousresearch/hermes-agent", name: "Hermes Agent" },
  { id: "picoclaw", repo: "sipeed/picoclaw", name: "PicoClaw", paginated: true },
  { id: "nanoclaw", repo: "qwibitai/nanoclaw", name: "NanoClaw" },
  { id: "nullclaw", repo: "nullclaw/nullclaw", name: "NullClaw" },
  { id: "ironclaw", repo: "nearai/ironclaw", name: "IronClaw" },
  { id: "lobsterai", repo: "netease-youdao/LobsterAI", name: "LobsterAI" },
  { id: "tinyclaw", repo: "TinyAGI/tinyclaw", name: "TinyClaw" },
  { id: "copaw", repo: "agentscope-ai/CoPaw", name: "CoPaw" },
  { id: "moltis", repo: "moltis-org/moltis", name: "Moltis" },
  { id: "zeptoclaw", repo: "qhkm/zeptoclaw", name: "ZeptoClaw" },
  { id: "easyclaw", repo: "gaoyangz77/easyclaw", name: "EasyClaw" },
  { id: "zeroclaw", repo: "zeroclaw-labs/zeroclaw", name: "ZeroClaw" },
];

export function toRepoConfig(e: RawRepoEntry): RepoConfig {
  return { id: e.id, repo: e.repo, name: e.name, ...(e.paginated ? { paginated: true } : {}) };
}

export function loadConfig(configPath = "config.yml"): RadarConfig {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    console.log(`[config] ${configPath} not found — using built-in defaults.`);
    return {
      cliRepos: DEFAULT_CLI_REPOS,
      skillsRepo: DEFAULT_SKILLS_REPO,
      openclaw: DEFAULT_OPENCLAW,
      openclawPeers: DEFAULT_OPENCLAW_PEERS,
    };
  }

  const raw = yaml.load(fs.readFileSync(resolved, "utf-8")) as RawConfig;

  const cliRepos =
    Array.isArray(raw?.cli_repos) && raw.cli_repos.length > 0
      ? raw.cli_repos.map(toRepoConfig)
      : DEFAULT_CLI_REPOS;

  const skillsRepo =
    typeof raw?.skills_repo === "string" && raw.skills_repo.trim()
      ? raw.skills_repo.trim()
      : DEFAULT_SKILLS_REPO;

  const openclaw = raw?.openclaw?.id && raw.openclaw.repo ? toRepoConfig(raw.openclaw) : DEFAULT_OPENCLAW;

  const openclawPeers =
    Array.isArray(raw?.openclaw_peers) && raw.openclaw_peers.length > 0
      ? raw.openclaw_peers.map(toRepoConfig)
      : DEFAULT_OPENCLAW_PEERS;

  console.log(
    `[config] Loaded from ${configPath}: ` +
      `${cliRepos.length} CLI repos, ${openclawPeers.length} OpenClaw peers`,
  );

  return { cliRepos, skillsRepo, openclaw, openclawPeers };
}
