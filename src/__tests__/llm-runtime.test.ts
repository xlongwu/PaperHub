import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmConnectionInputFromPreset, toTestableConnection } from "@/providers/connections";
import {
  callLlmConnection,
  discoverLlmModels,
  normalizeLlmRequestError,
  probeLlmConnection,
  redactSecrets,
} from "@/providers/runtime";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLM connection runtime", () => {
  it("calls OpenAI-compatible endpoints with bearer auth", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer local-secret");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "deepseek-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      });
      return jsonResponse({ choices: [{ message: { content: "openai-ok" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const connection = toTestableConnection({
      ...createLlmConnectionInputFromPreset("deepseek"),
      apiKey: "local-secret",
    });
    await expect(callLlmConnection(connection, "hello", 64)).resolves.toBe("openai-ok");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.deepseek.com/chat/completions");
  });

  it("supports Anthropic header auth and Gemini query auth", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("anthropic-key");
        expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
        return jsonResponse({ content: [{ type: "text", text: "anthropic-ok" }] });
      })
      .mockImplementationOnce(async (input: URL | RequestInfo) => {
        expect(String(input)).toContain("key=gemini-key");
        expect(String(input)).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }],
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callLlmConnection(
        toTestableConnection({
          ...createLlmConnectionInputFromPreset("anthropic"),
          apiKey: "anthropic-key",
        }),
        "hello",
        32,
      ),
    ).resolves.toBe("anthropic-ok");
    await expect(
      callLlmConnection(
        toTestableConnection({
          ...createLlmConnectionInputFromPreset("gemini"),
          apiKey: "gemini-key",
        }),
        "hello",
        32,
      ),
    ).resolves.toBe("gemini-ok");
  });

  it("discovers and normalizes model ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ models: [{ name: "models/gemini-b" }, { name: "models/gemini-a" }] }),
      ),
    );
    const connection = toTestableConnection(createLlmConnectionInputFromPreset("gemini"));
    await expect(discoverLlmModels(connection)).resolves.toEqual(["gemini-a", "gemini-b"]);
  });

  it("creates the StepFun preset with its OpenAI-compatible endpoint", () => {
    const connection = toTestableConnection(
      createLlmConnectionInputFromPreset("stepfun"),
    );

    expect(connection).toMatchObject({
      presetId: "stepfun",
      protocol: "openai_chat",
      baseUrl: "https://api.stepfun.com/v1",
      model: "step-3.7-flash",
      auth: { type: "bearer" },
      request: {
        method: "POST",
        path: "/chat/completions",
        responsePath: "$.choices[0].message.content",
      },
      models: null,
    });
  });

  it("gives reasoning models enough tokens during connection tests", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens: number;
        messages: Array<{ content: string }>;
      };
      expect(body.max_tokens).toBe(256);
      expect(body.messages[0]?.content).toBe(
        "Reply with exactly: PaperHub connection OK",
      );
      return jsonResponse({
        choices: [
          {
            message: {
              content: "PaperHub connection OK",
              reasoning_content: "Brief internal reasoning",
            },
            finish_reason: "stop",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const connection = toTestableConnection(
      createLlmConnectionInputFromPreset("stepfun"),
    );

    await expect(probeLlmConnection(connection)).resolves.toBe(
      "PaperHub connection OK",
    );
  });

  it("explains empty final text caused by the output token limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "The token budget was spent reasoning.",
              },
              finish_reason: "length",
            },
          ],
        }),
      ),
    );
    const connection = toTestableConnection(
      createLlmConnectionInputFromPreset("stepfun"),
    );

    await expect(callLlmConnection(connection, "hello", 32)).rejects.toThrow(
      "reached its output token limit before producing final text",
    );
  });

  it("does not follow redirects and redacts secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 302, headers: { location: "https://other.test" } })),
    );
    const connection = toTestableConnection({
      ...createLlmConnectionInputFromPreset("deepseek"),
      apiKey: "sk-super-secret-value",
    });
    await expect(callLlmConnection(connection, "hello", 16)).rejects.toThrow(
      "Redirect responses are not followed",
    );
    expect(redactSecrets("Bearer abcdefghijk and sk-super-secret-value", connection.apiKey)).not.toContain(
      "super-secret",
    );
  });

  it("turns nested fetch failures into actionable network errors", () => {
    const accessError = Object.assign(new Error("connect blocked"), { code: "EACCES" });
    const fetchError = new TypeError("fetch failed", {
      cause: new AggregateError([accessError]),
    });

    expect(normalizeLlmRequestError(fetchError).message).toContain(
      "LLM network request failed (EACCES)",
    );
    expect(normalizeLlmRequestError(fetchError).message).toContain("firewall");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
