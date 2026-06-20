import { EmbeddingError, type EmbeddingErrorCode } from "./types";

export interface EmbeddingValidationCodes {
  invalidResponse: EmbeddingErrorCode;
  dimensionMismatch: EmbeddingErrorCode;
  emptyEmbedding: EmbeddingErrorCode;
}

export function validateEmbeddings(
  value: unknown,
  expectedCount: number,
  expectedDimensions: number | undefined,
  codes: EmbeddingValidationCodes,
): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new EmbeddingError(
      codes.invalidResponse,
      `Embedding response count mismatch: expected ${expectedCount}, received ${
        Array.isArray(value) ? value.length : "an invalid value"
      }.`,
    );
  }

  let dimensions: number | undefined;
  const embeddings = value.map((candidate, index) => {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      throw new EmbeddingError(codes.emptyEmbedding, `Embedding ${index + 1} is empty.`);
    }

    if (dimensions === undefined) {
      dimensions = candidate.length;
    } else if (candidate.length !== dimensions) {
      throw new EmbeddingError(
        codes.dimensionMismatch,
        `Embedding dimensions are inconsistent: expected ${dimensions}, received ${candidate.length}.`,
      );
    }

    const embedding = candidate.map((entry) => Number(entry));
    if (embedding.some((entry) => !Number.isFinite(entry))) {
      throw new EmbeddingError(
        codes.invalidResponse,
        `Embedding ${index + 1} contains a non-finite numeric value.`,
      );
    }
    return embedding;
  });

  if (expectedDimensions !== undefined && dimensions !== expectedDimensions) {
    throw new EmbeddingError(
      codes.dimensionMismatch,
      `Embedding dimension mismatch: expected ${expectedDimensions}, received ${dimensions ?? 0}.`,
    );
  }

  return embeddings;
}

export function validateEmbeddingDimensions(dimensions: number): number {
  if (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 8192) {
    throw new EmbeddingError(
      "EMBEDDING_DIMENSION_MISMATCH",
      `Embedding dimensions must be an integer between 32 and 8192; received ${dimensions}.`,
    );
  }
  return dimensions;
}
