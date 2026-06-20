import { afterEach, describe, expect, it } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { OllamaEmbeddingProvider, normalizeOllamaBaseUrl } from "@/embedding/providers/ollama";
import { EmbeddingError } from "@/embedding";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("OllamaEmbeddingProvider", () => {
  it("supports single and batch embeddings and normalizes a trailing slash", async () => {
    const requests: unknown[] = [];
    const baseUrl = await startServer(async (request, response) => {
      requests.push(await readJson(request));
      json(response, 200, {
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
        ].slice(0, Array.isArray((requests.at(-1) as { input?: unknown }).input) ? 2 : 1),
      });
    });
    const provider = new OllamaEmbeddingProvider({
      baseUrl: `${baseUrl}/`,
      model: "test-embedding",
      timeoutMs: 1_000,
      truncate: true,
      keepAlive: "5m",
      expectedDimensions: 3,
    });

    await expect(provider.embedBatch(["one", "two"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const body = requests[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-embedding",
      input: ["one", "two"],
      truncate: true,
      keep_alive: "5m",
      dimensions: 3,
    });
  });

  it("reports a missing model with an actionable error", async () => {
    const baseUrl = await startServer((_request, response) => {
      json(response, 404, { error: "model not found" });
    });
    const provider = createProvider(baseUrl);

    await expect(provider.embed("test")).rejects.toMatchObject({
      code: "OLLAMA_MODEL_NOT_FOUND",
    });
  });

  it.each([
    [{}, "OLLAMA_INVALID_RESPONSE"],
    [{ embeddings: [] }, "OLLAMA_INVALID_RESPONSE"],
    [{ embeddings: [[]] }, "OLLAMA_EMPTY_EMBEDDING"],
    [
      {
        embeddings: [
          [1, 2],
          [1, 2, 3],
        ],
      },
      "OLLAMA_DIMENSION_MISMATCH",
    ],
    [{ embeddings: [["not-a-number", 2, 3]] }, "OLLAMA_INVALID_RESPONSE"],
  ])("rejects malformed responses", async (payload, code) => {
    const baseUrl = await startServer((_request, response) => {
      json(response, 200, payload);
    });
    const provider = createProvider(baseUrl);
    const input =
      Array.isArray((payload as { embeddings?: unknown }).embeddings) &&
      (payload as { embeddings: unknown[] }).embeddings.length === 2
        ? ["one", "two"]
        : ["one"];

    await expect(provider.embedBatch(input)).rejects.toMatchObject({ code });
  });

  it("distinguishes timeout and unreachable errors", async () => {
    const baseUrl = await startServer(() => {
      // Intentionally leave the request open until AbortController fires.
    });
    const timeoutProvider = createProvider(baseUrl, 20);
    await expect(timeoutProvider.embed("test")).rejects.toMatchObject({ code: "OLLAMA_TIMEOUT" });

    const unreachableProvider = createProvider("http://127.0.0.1:1", 100);
    await expect(unreachableProvider.embed("test")).rejects.toMatchObject({
      code: "OLLAMA_UNREACHABLE",
    });
  });

  it("only accepts http and https base URLs", () => {
    expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/").toString()).toBe("http://127.0.0.1:11434/");
    expect(() => normalizeOllamaBaseUrl("file:///tmp/ollama")).toThrow(EmbeddingError);
  });
});

function createProvider(baseUrl: string, timeoutMs = 1_000): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider({
    baseUrl,
    model: "test-embedding",
    timeoutMs,
    truncate: true,
    expectedDimensions: 3,
  });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}
