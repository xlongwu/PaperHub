import { describe, expect, it } from "vitest";
import { createLlmConnectionInputFromPreset, parseLlmConnectionInput } from "@/providers/connections";
import { extractJsonPath, renderJsonTemplate, renderTemplateString } from "@/providers/template";

describe("LLM declarative templates", () => {
  it("renders typed exact placeholders and interpolated strings", () => {
    const variables = { prompt: "hello", model: "model-a", maxTokens: 128 };
    expect(
      renderJsonTemplate(
        {
          model: "{{model}}",
          max_tokens: "{{maxTokens}}",
          label: "using-{{model}}",
          messages: [{ content: "{{prompt}}" }],
        },
        variables,
      ),
    ).toEqual({
      model: "model-a",
      max_tokens: 128,
      label: "using-model-a",
      messages: [{ content: "hello" }],
    });
    expect(renderTemplateString("/models/{{model}}", variables)).toBe("/models/model-a");
  });

  it("extracts indexed and wildcard JSON paths without eval", () => {
    const payload = {
      choices: [{ message: { content: "ok" } }],
      data: [{ id: "a" }, { id: "b" }],
    };
    expect(extractJsonPath(payload, "$.choices[0].message.content")).toBe("ok");
    expect(extractJsonPath(payload, "$.data[*].id")).toEqual(["a", "b"]);
  });

  it("rejects credential placeholders, scripts, and credential headers", () => {
    const preset = createLlmConnectionInputFromPreset("deepseek");
    expect(() =>
      parseLlmConnectionInput({
        ...preset,
        request: {
          ...preset.request,
          body: { token: "{{apiKey}}" },
        },
      }),
    ).toThrow("unsupported placeholder");
    expect(() =>
      parseLlmConnectionInput({
        ...preset,
        request: {
          ...preset.request,
          headers: { Authorization: "secret" },
        },
      }),
    ).toThrow("configure them through auth");
    expect(() =>
      parseLlmConnectionInput({
        ...preset,
        request: { ...preset.request, path: "https://evil.example/chat" },
      }),
    ).toThrow("relative path");
  });
});
