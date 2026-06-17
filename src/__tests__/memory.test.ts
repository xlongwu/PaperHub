import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDbPath, closeDb, initDatabase, setDbPath } from "@/db/index";
import { getUserMemoryTerms } from "@/db/recommendations";
import { extractMemoryFromDigests, rebuildUserMemoryFromDigests } from "@/recommendation/memory";

const TEST_DB_PATH = "/tmp/paperhub-memory-test.db";
const TEST_DIGEST_DIR = "/tmp/paperhub-digests-test";
const SPARSE_DIGEST_DIR = "/tmp/paperhub-digests-sparse-test";
const NOW = new Date("2026-06-30T00:00:00Z");

beforeEach(() => {
  closeDb();
  fs.rmSync(TEST_DIGEST_DIR, { recursive: true, force: true });
  fs.rmSync(SPARSE_DIGEST_DIR, { recursive: true, force: true });
  try {
    fs.unlinkSync(TEST_DB_PATH);
  } catch {}

  setDbPath(TEST_DB_PATH);
  initDatabase();

  writeDigest("2026-06-28", "ai-agents.md", `
    Agents and RAG are becoming core patterns.
    GPT-4 powers many agent workflows.
    arXiv and OpenAI GPT Blog are both highlighted here.
  `);
  writeDigest("2026-06-27", "ai-cli.md", `
    CLI agents are popular.
    Claude 3 and GPT-4 appear in tooling discussions.
    Anthropic and arXiv are referenced repeatedly.
  `);
  writeDigest("2026-06-23", "ai-weekly.md", `
    Weekly recap: Agents, RAG, GPT-4, Claude 3, Anthropic, arXiv.
  `);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIGEST_DIR, { recursive: true, force: true });
  fs.rmSync(SPARSE_DIGEST_DIR, { recursive: true, force: true });
  try {
    fs.unlinkSync(TEST_DB_PATH);
  } catch {}
});

afterAll(() => {
  clearDbPath();
});

describe("extractMemoryFromDigests", () => {
  it("extracts domain, model, source, and topic terms", () => {
    const terms = extractMemoryFromDigests({
      digestDir: TEST_DIGEST_DIR,
      now: NOW,
      maxDays: 30,
      maxTerms: 10,
    });

    expect(terms.some((term) => term.term === "Agents" && term.category === "domain")).toBe(true);
    expect(terms.some((term) => term.term === "GPT-4" && term.category === "model")).toBe(true);
    expect(terms.some((term) => term.term === "arxiv" && term.category === "source")).toBe(true);
    expect(terms.some((term) => term.term === "CLI" && term.category === "topic")).toBe(true);
  });

  it("normalizes weights and respects maxTerms", () => {
    const terms = extractMemoryFromDigests({
      digestDir: TEST_DIGEST_DIR,
      now: NOW,
      maxDays: 30,
      maxTerms: 3,
    });

    expect(terms).toHaveLength(3);
    expect(terms[0]!.weight).toBeLessThanOrEqual(1);
    expect(terms[0]!.weight).toBeGreaterThanOrEqual(terms[1]!.weight);
  });

  it("adds fallback topic terms when rule extraction is too sparse", () => {
    writeSparseDigest("2026-06-29", "ai-sparse.md", `
      Benchmarking orchestration pipelines needs benchmarking discipline.
      Orchestration quality depends on benchmarking and regression tracking.
    `);

    const terms = extractMemoryFromDigests({
      digestDir: SPARSE_DIGEST_DIR,
      now: NOW,
      maxDays: 30,
      maxTerms: 5,
      useLlmFallback: true,
    });

    expect(terms.some((term) => term.term === "Benchmarking" && term.category === "topic")).toBe(true);
  });
});

describe("rebuildUserMemoryFromDigests", () => {
  it("persists digest-derived memory terms", () => {
    const rebuilt = rebuildUserMemoryFromDigests({
      digestDir: TEST_DIGEST_DIR,
      now: NOW,
      maxDays: 30,
      maxTerms: 8,
    });

    const stored = getUserMemoryTerms({ source: "digest", limit: 20 });

    expect(rebuilt.length).toBeGreaterThan(0);
    expect(stored.length).toBe(rebuilt.length);
    expect(stored.every((term) => term.source === "digest")).toBe(true);
  });
});

function writeDigest(date: string, fileName: string, content: string): void {
  const dir = path.join(TEST_DIGEST_DIR, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content.trim(), "utf-8");
}

function writeSparseDigest(date: string, fileName: string, content: string): void {
  const dir = path.join(SPARSE_DIGEST_DIR, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content.trim(), "utf-8");
}
