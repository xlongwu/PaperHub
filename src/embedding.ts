/**
 * Embedding service — generates vector embeddings for text.
 * Default: OpenAI text-embedding-3-small (1536 dims).
 * Fallback: local mock for testing.
 */

import { getCacheDir } from "@/config";
import { getStoredLlmProviderSettings } from "@/db/llm-settings";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSION = 1536;
const EMBEDDING_MODEL = "text-embedding-3-small";

export interface EmbeddingRuntime {
  provider: "openai" | "mock";
  model: string;
  signature: string;
}

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

function cacheKey(text: string, signature: string): string {
  return crypto.createHash("sha256").update(`${signature}\n${text}`).digest("hex").slice(0, 24) + ".json";
}

function getCachedEmbedding(text: string, signature: string): number[] | null {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return null;

  const file = path.join(dir, cacheKey(text, signature));
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as number[];
    if (data.length === EMBEDDING_DIMENSION) return data;
    return null;
  } catch {
    return null;
  }
}

function setCachedEmbedding(text: string, signature: string, embedding: number[]): void {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return;

  const file = path.join(dir, cacheKey(text, signature));
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
  // Deterministic feature hashing preserves lexical neighbourhoods, unlike a
  // random vector per whole string. This makes offline semantic tests useful.
  const normalized = text.normalize("NFKC").toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const features = new Set(words);

  for (let index = 0; index < words.length - 1; index++) {
    features.add(`${words[index]}_${words[index + 1]}`);
  }
  const cjk = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  for (let index = 0; index < cjk.length - 1; index++) {
    features.add(cjk[index]! + cjk[index + 1]!);
  }
  for (let index = 0; index < cjk.length - 2; index++) {
    features.add(cjk[index]! + cjk[index + 1]! + cjk[index + 2]!);
  }

  const vector = Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const feature of features) {
    const digest = crypto.createHash("sha256").update(feature).digest();
    const position = digest.readUInt32LE(0) % EMBEDDING_DIMENSION;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[position] = (vector[position] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function generateEmbedding(text: string): Promise<number[]> {
  const runtime = getEmbeddingRuntime();
  const cached = getCachedEmbedding(text, runtime.signature);
  if (cached) return cached;

  let embedding: number[];
  if (runtime.provider === "mock") {
    embedding = generateMockEmbedding(text);
  } else {
    embedding = await generateOpenAIEmbedding(text);
  }

  setCachedEmbedding(text, runtime.signature, embedding);
  return embedding;
}

export { EMBEDDING_DIMENSION };

function getEmbeddingApiKey(): string | undefined {
  const environmentKey = process.env["EMBEDDING_API_KEY"] || process.env["OPENAI_API_KEY"];
  if (environmentKey) {
    return environmentKey;
  }

  try {
    return getStoredLlmProviderSettings("openai")?.apiKey ?? undefined;
  } catch {
    return undefined;
  }
}

export function getEmbeddingRuntime(): EmbeddingRuntime {
  if (process.env["EMBEDDING_MOCK"] === "1") {
    return {
      provider: "mock",
      model: "feature-hash-test-vector-v2",
      signature: `mock:feature-hash-test-vector-v2:${EMBEDDING_DIMENSION}`,
    };
  }

  const configured = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase();
  if (configured === "local") {
    throw new Error(
      'EMBEDDING_PROVIDER="local" is not implemented yet. Configure OpenAI embeddings instead.',
    );
  }

  if (configured && configured !== "openai") {
    throw new Error(`Invalid EMBEDDING_PROVIDER: ${configured}. Use "openai".`);
  }

  if (!getEmbeddingApiKey()) {
    throw new Error(
      "Semantic search is unavailable until OPENAI_API_KEY, EMBEDDING_API_KEY, or an OpenAI key in LLM settings is configured.",
    );
  }

  return {
    provider: "openai",
    model: EMBEDDING_MODEL,
    signature: `openai:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSION}`,
  };
}
