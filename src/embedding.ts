/**
 * Embedding service — generates vector embeddings for text.
 * Default: OpenAI text-embedding-3-small (1536 dims).
 * Fallback: local mock for testing.
 */

import { getCacheDir } from "@/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSION = 1536;
const EMBEDDING_MODEL = "text-embedding-3-small";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function ensureEmbeddingCacheDir(): string | null {
  try {
    const embeddingCacheDir = path.join(getCacheDir(), "embeddings");
    fs.mkdirSync(embeddingCacheDir, { recursive: true });
    return embeddingCacheDir;
  } catch {
    return null;
  }
}

function cacheKey(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) + ".json";
}

function getCachedEmbedding(text: string): number[] | null {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return null;

  const file = path.join(dir, cacheKey(text));
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as number[];
    if (data.length === EMBEDDING_DIMENSION) return data;
    return null;
  } catch {
    return null;
  }
}

function setCachedEmbedding(text: string, embedding: number[]): void {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return;

  const file = path.join(dir, cacheKey(text));
  try {
    fs.writeFileSync(file, JSON.stringify(embedding), "utf-8");
  } catch {
    // Cache writes are best-effort only.
  }
}

// ---------------------------------------------------------------------------
// OpenAI embedding via provider
// ---------------------------------------------------------------------------

async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = getEmbeddingApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY or EMBEDDING_API_KEY env var required for embeddings");
  }

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // token limit safety
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Embedding API error: ${resp.status} ${err}`);
  }

  const data = (await resp.json()) as {
    data: { embedding: number[] }[];
  };
  return data.data[0]!.embedding;
}

// ---------------------------------------------------------------------------
// Mock embedding for testing (random normalized vector)
// ---------------------------------------------------------------------------

function generateMockEmbedding(text: string): number[] {
  // Deterministic pseudo-random based on text hash
  const seed = crypto.createHash("sha256").update(text).digest("hex");
  const vec: number[] = [];
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    const start = (i * 8) % (seed.length - 8);
    const hex = seed.slice(start, start + 8);
    const val = (parseInt(hex, 16) % 2000) / 1000 - 1; // [-1, 1]
    vec.push(val);
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  const normalized = norm > 0 ? vec.map((v) => v / norm) : vec.map(() => 0);
  // Ensure no NaN/Inf — replace with 0
  return normalized.map((v) => (Number.isFinite(v) ? v : 0));
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function generateEmbedding(text: string): Promise<number[]> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const provider = resolveEmbeddingProvider();

  let embedding: number[];
  if (provider === "local") {
    embedding = generateMockEmbedding(text);
  } else {
    embedding = await generateOpenAIEmbedding(text);
  }

  setCachedEmbedding(text, embedding);
  return embedding;
}

export { EMBEDDING_DIMENSION };

function getEmbeddingApiKey(): string | undefined {
  return process.env["EMBEDDING_API_KEY"] || process.env["OPENAI_API_KEY"];
}

function resolveEmbeddingProvider(): "openai" | "local" {
  if (process.env["EMBEDDING_MOCK"] === "1") {
    return "local";
  }

  const configured = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase();
  if (configured === "local" || configured === "openai") {
    return configured;
  }

  if (configured) {
    throw new Error(`Invalid EMBEDDING_PROVIDER: ${configured}. Use "openai" or "local".`);
  }

  return getEmbeddingApiKey() ? "openai" : "local";
}
