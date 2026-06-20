import { getCacheDir } from "@/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmbeddingRuntime } from "./types";

interface EmbeddingCacheEntry {
  signature: string;
  dimensions: number;
  embedding: number[];
}

function ensureEmbeddingCacheDir(): string | null {
  try {
    const embeddingCacheDir = path.join(getCacheDir(), "embeddings");
    fs.mkdirSync(embeddingCacheDir, { recursive: true });
    return embeddingCacheDir;
  } catch {
    return null;
  }
}

export function getCachedEmbedding(text: string, runtime: EmbeddingRuntime): number[] | null {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return null;

  const file = path.join(dir, cacheKey(text, runtime.signature));
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as EmbeddingCacheEntry | number[];
    const entry: EmbeddingCacheEntry = Array.isArray(parsed)
      ? {
          signature: runtime.signature,
          dimensions: parsed.length,
          embedding: parsed,
        }
      : parsed;

    if (
      entry.signature === runtime.signature &&
      entry.dimensions === runtime.dimensions &&
      Array.isArray(entry.embedding) &&
      entry.embedding.length === runtime.dimensions &&
      entry.embedding.every(Number.isFinite)
    ) {
      return entry.embedding;
    }
  } catch {
    // Corrupt and stale cache files are ignored.
  }
  return null;
}

export function setCachedEmbedding(text: string, runtime: EmbeddingRuntime, embedding: number[]): void {
  const dir = ensureEmbeddingCacheDir();
  if (!dir) return;

  const file = path.join(dir, cacheKey(text, runtime.signature));
  try {
    const entry: EmbeddingCacheEntry = {
      signature: runtime.signature,
      dimensions: runtime.dimensions,
      embedding,
    };
    fs.writeFileSync(file, JSON.stringify(entry), "utf-8");
  } catch {
    // Cache writes are best-effort only.
  }
}

export function getEmbeddingCacheFilePath(text: string, signature: string): string | null {
  const dir = ensureEmbeddingCacheDir();
  return dir ? path.join(dir, cacheKey(text, signature)) : null;
}

function cacheKey(text: string, signature: string): string {
  return crypto.createHash("sha256").update(`${signature}\n${text}`).digest("hex").slice(0, 24) + ".json";
}
