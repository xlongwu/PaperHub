import { EmbeddingError, type EmbeddingProvider, type EmbeddingProbeResult } from "../types";
import { validateEmbeddings } from "../validate";

interface OllamaEmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  truncate: boolean;
  keepAlive?: string;
  expectedDimensions?: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  private readonly baseUrl: string;
  private readonly displayEndpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly truncate: boolean;
  private readonly keepAlive?: string;
  private readonly expectedDimensions?: number;

  constructor(options: OllamaEmbeddingProviderOptions) {
    const url = normalizeOllamaBaseUrl(options.baseUrl);
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.displayEndpoint = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.truncate = options.truncate;
    this.keepAlive = options.keepAlive;
    this.expectedDimensions = options.expectedDimensions;
  }

  async embed(input: string): Promise<number[]> {
    return (await this.embedBatch([input]))[0]!;
  }

  async embedBatch(input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input,
          truncate: this.truncate,
          ...(this.keepAlive ? { keep_alive: this.keepAlive } : {}),
          ...(this.expectedDimensions ? { dimensions: this.expectedDimensions } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        if (response.status === 404 || /model.+not found|pull model/i.test(detail)) {
          throw new EmbeddingError(
            "OLLAMA_MODEL_NOT_FOUND",
            `Ollama model ${this.model} was not found. Run: ollama pull ${this.model}`,
          );
        }
        throw new EmbeddingError(
          "OLLAMA_INVALID_RESPONSE",
          `Ollama embedding request failed with HTTP ${response.status}: ${detail}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new EmbeddingError("OLLAMA_INVALID_RESPONSE", "Ollama returned invalid JSON.", {
          cause: error,
        });
      }

      const embeddings =
        payload && typeof payload === "object" ? (payload as { embeddings?: unknown }).embeddings : undefined;

      return validateEmbeddings(embeddings, input.length, this.expectedDimensions, {
        invalidResponse: "OLLAMA_INVALID_RESPONSE",
        dimensionMismatch: "OLLAMA_DIMENSION_MISMATCH",
        emptyEmbedding: "OLLAMA_EMPTY_EMBEDDING",
      });
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (controller.signal.aborted) {
        throw new EmbeddingError(
          "OLLAMA_TIMEOUT",
          `Ollama embedding request timed out after ${this.timeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new EmbeddingError(
        "OLLAMA_UNREACHABLE",
        `Unable to connect to Ollama at ${this.displayEndpoint}. Confirm Ollama is running and the endpoint is correct.`,
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

export function normalizeOllamaBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.replace(/\/+$/, ""));
  } catch (error) {
    throw new EmbeddingError("EMBEDDING_UNCONFIGURED", "OLLAMA_BASE_URL must be a valid URL.", {
      cause: error,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EmbeddingError(
      "EMBEDDING_UNCONFIGURED",
      "OLLAMA_BASE_URL must use the http or https protocol.",
    );
  }
  return parsed;
}
