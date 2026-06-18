import { describe, expect, it } from "vitest";
import { parseLlmSettingsUpdate, sanitizePreferences } from "@/api/server";

describe("settings request validation", () => {
  it("accepts the preference keys used by the profile UI", () => {
    expect(
      sanitizePreferences({
        interest_tags: '["Agents"]',
        default_language: "zh",
        summary_length: "short",
        daily_recommend_count: "10",
        database_path: "must-not-pass",
      }),
    ).toEqual({
      interest_tags: '["Agents"]',
      default_language: "zh",
      summary_length: "short",
      daily_recommend_count: "10",
    });
  });

  it("parses valid LLM settings without accepting extra fields", () => {
    expect(
      parseLlmSettingsUpdate({
        provider: "openai",
        apiKey: "  sk-local-test  ",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        ignored: "value",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "sk-local-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("rejects unsupported providers and unsafe URL protocols", () => {
    expect(() => parseLlmSettingsUpdate({ provider: "unknown" })).toThrow("Unsupported LLM provider");
    expect(() => parseLlmSettingsUpdate({ provider: "openai", baseUrl: "file:///tmp/key" })).toThrow(
      "baseUrl must use HTTP or HTTPS",
    );
  });
});
