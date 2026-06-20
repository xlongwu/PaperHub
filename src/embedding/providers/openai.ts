import { EmbeddingError, type EmbeddingProvider, type EmbeddingProbeResult } from "../types";
import { validateEmbeddings } from "../validate";

interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  expectedDimensions?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly expectedDimensions?: number;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.expectedDimensions = options.expectedDimensions;
  }

  async embed(input: string): Promise<number[]> {
    return (await this.embedBatch([input]))[0]!;
  }

  async embedBatch(input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    if (!this.apiKey) {
      throw new EmbeddingError(
        "EMBEDDING_UNCONFIGURED",
        "OpenAI semantic search requires OPENAI_API_KEY, EMBEDDING_API_KEY, or a saved OpenAI key.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          ...(this.expectedDimensions ? { dimensions: this.expectedDimensions } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new EmbeddingError(
          "EMBEDDING_INVALID_RESPONSE",
          `OpenAI embedding request failed with HTTP ${response.status}: ${detail}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new EmbeddingError("EMBEDDING_INVALID_RESPONSE", "OpenAI returned an invalid JSON response.", {
          cause: error,
        });
      }

      const data =
        payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: Array<{ embedding?: unknown }> }).data.map((item) => item.embedding)
          : undefined;

      return validateEmbeddings(data, input.length, this.expectedDimensions, {
        invalidResponse: "EMBEDDING_INVALID_RESPONSE",
        dimensionMismatch: "EMBEDDING_DIMENSION_MISMATCH",
        emptyEmbedding: "EMBEDDING_EMPTY",
      });
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (controller.signal.aborted) {
        throw new EmbeddingError(
          "EMBEDDING_TIMEOUT",
          `OpenAI embedding request timed out after ${this.timeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new EmbeddingError(
        "EMBEDDING_INVALID_RESPONSE",
        `OpenAI embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async probe(): Promise<EmbeddingProbeResult> {
    const embedding = await this.embed("PaperHub embedding probe");
    return {
      provider: this.name,
      model: this.model,
      dimensions: embedding.length,
      reachable: true,
    };
  }
}
