import crypto from "node:crypto";
import type { EmbeddingProvider, EmbeddingProbeResult } from "../types";

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock" as const;

  constructor(
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  async embed(input: string): Promise<number[]> {
    return generateMockEmbedding(input, this.dimensions);
  }

  async embedBatch(input: string[]): Promise<number[][]> {
    return Promise.all(input.map((value) => this.embed(value)));
  }

  async probe(): Promise<EmbeddingProbeResult> {
    return {
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
      reachable: true,
    };
  }
}

export function generateMockEmbedding(text: string, dimensions: number): number[] {
  // Structural labels help real embedding models, but allowing the same
  // labels to dominate a feature-hash test vector makes unrelated documents
  // look artificially similar.
  const normalized = text
    .replace(/^(Title|Abstract|Summary Zh|Summary En|Domain Tags|Model Tags|Full Text):\s*/gim, "")
    .normalize("NFKC")
    .toLowerCase();
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

  const vector = Array<number>(dimensions).fill(0);
  for (const feature of features) {
    const digest = crypto.createHash("sha256").update(feature).digest();
    const position = digest.readUInt32LE(0) % dimensions;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[position] = (vector[position] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}
