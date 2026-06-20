export type EmbeddingProviderName = "openai" | "ollama" | "mock";

export type EmbeddingErrorCode =
  | "EMBEDDING_UNCONFIGURED"
  | "EMBEDDING_RUNTIME_UNRESOLVED"
  | "EMBEDDING_INVALID_RESPONSE"
  | "EMBEDDING_DIMENSION_MISMATCH"
  | "EMBEDDING_EMPTY"
  | "EMBEDDING_TIMEOUT"
  | "OLLAMA_UNREACHABLE"
  | "OLLAMA_MODEL_NOT_FOUND"
  | "OLLAMA_TIMEOUT"
  | "OLLAMA_INVALID_RESPONSE"
  | "OLLAMA_DIMENSION_MISMATCH"
  | "OLLAMA_EMPTY_EMBEDDING";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly cause?: unknown;

  constructor(code: EmbeddingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export interface EmbeddingRuntime {
  provider: EmbeddingProviderName;
  model: string;
  baseUrl?: string;
  dimensions: number;
  signature: string;
  truncate: boolean;
  keepAlive?: string;
  timeoutMs: number;
  batchSize: number;
  maxInputChars: number;
}

export interface EmbeddingProbeResult {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  reachable: boolean;
}

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;

  embed(input: string): Promise<number[]>;

  embedBatch(input: string[]): Promise<number[][]>;

  probe(): Promise<EmbeddingProbeResult>;
}

export interface EmbeddingConfiguration {
  provider: EmbeddingProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  expectedDimensions?: number;
  truncate: boolean;
  keepAlive?: string;
  timeoutMs: number;
  batchSize: number;
  maxInputChars: number;
}
