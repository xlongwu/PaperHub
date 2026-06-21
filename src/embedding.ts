/**
 * Public embedding service.
 *
 * This compatibility entry keeps the original imports stable while routing
 * OpenAI, Ollama, and deterministic mock embeddings through one runtime.
 */

import { getCachedEmbedding, setCachedEmbedding } from "./embedding/cache";
import {
  createEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  getEmbeddingConfiguration,
  getEmbeddingConfigurationSource,
  getEmbeddingRuntime,
  probeEmbeddingConfiguration,
  resetEmbeddingRuntime,
  resolveEmbeddingRuntime,
} from "./embedding/runtime";
import { EmbeddingError, type EmbeddingRuntime } from "./embedding/types";
import { validateEmbeddings } from "./embedding/validate";

export async function generateEmbedding(text: string): Promise<number[]> {
  return (await generateEmbeddings([text]))[0]!;
}

export async function generateEmbeddings(input: string[]): Promise<number[][]> {
  if (input.length === 0) return [];

  const runtime = await resolveEmbeddingRuntime();
  const results: Array<number[] | undefined> = input.map(
    (text) => getCachedEmbedding(text, runtime) ?? undefined,
  );
  const missingIndexes = results
    .map((embedding, index) => (embedding ? -1 : index))
    .filter((index) => index >= 0);

  if (missingIndexes.length > 0) {
    const provider = createEmbeddingProvider(getEmbeddingConfiguration(), runtime.dimensions);
    const missingInput = missingIndexes.map((index) => input[index]!);
    const generated = validateEmbeddings(
      await provider.embedBatch(missingInput),
      missingInput.length,
      runtime.dimensions,
      {
        invalidResponse: "EMBEDDING_INVALID_RESPONSE",
        dimensionMismatch: "EMBEDDING_DIMENSION_MISMATCH",
        emptyEmbedding: "EMBEDDING_EMPTY",
      },
    );

    generated.forEach((embedding, generatedIndex) => {
      const inputIndex = missingIndexes[generatedIndex]!;
      results[inputIndex] = embedding;
      setCachedEmbedding(input[inputIndex]!, runtime, embedding);
    });
  }

  if (results.some((embedding) => !embedding)) {
    throw new EmbeddingError(
      "EMBEDDING_INVALID_RESPONSE",
      "Embedding generation returned incomplete results.",
    );
  }
  return results as number[][];
}

// Backward-compatible constant. New vector-table code must use runtime.dimensions.
export const EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSIONS;

export {
  getEmbeddingConfiguration,
  getEmbeddingConfigurationSource,
  getEmbeddingRuntime,
  probeEmbeddingConfiguration,
  resetEmbeddingRuntime,
  resolveEmbeddingRuntime,
};
export {
  buildDocumentEmbeddingText,
  buildDocumentEmbeddingTextForRuntime,
  buildTagEmbeddingText,
  buildTitleAbstractEmbeddingText,
} from "./embedding/document";
export { EmbeddingError } from "./embedding/types";
export type {
  EmbeddingConfiguration,
  EmbeddingErrorCode,
  EmbeddingProbeResult,
  EmbeddingProvider,
  EmbeddingProviderName,
  EmbeddingRuntime,
} from "./embedding/types";

export function validateEmbeddingForRuntime(embedding: number[], runtime: EmbeddingRuntime): number[] {
  return validateEmbeddings([embedding], 1, runtime.dimensions, {
    invalidResponse: "EMBEDDING_INVALID_RESPONSE",
    dimensionMismatch: "EMBEDDING_DIMENSION_MISMATCH",
    emptyEmbedding: "EMBEDDING_EMPTY",
  })[0]!;
}
