/**
 * Model extraction tests.
 */

import { describe, it, expect } from "vitest";
import { extractModelTags } from "@/tagger/model-extract";

describe("extractModelTags", () => {
  it("extracts GPT-4 from text", () => {
    const tags = extractModelTags("We evaluate GPT-4 on reasoning tasks.");
    expect(tags).toContain("GPT-4");
  });

  it("extracts Claude 3 from text", () => {
    const tags = extractModelTags("Claude 3 Opus shows strong performance.");
    expect(tags).toContain("Claude 3");
  });

  it("extracts multiple models", () => {
    const tags = extractModelTags("Comparing GPT-4, Claude 3, and Llama 3.");
    expect(tags).toContain("GPT-4");
    expect(tags).toContain("Claude 3");
    expect(tags).toContain("Llama 3");
  });

  it("extracts LangChain", () => {
    const tags = extractModelTags("Built with LangChain and AutoGPT.");
    expect(tags).toContain("LangChain");
    expect(tags).toContain("AutoGPT");
  });

  it("returns empty for text without models", () => {
    const tags = extractModelTags("This is a general article about cooking.");
    expect(tags.length).toBe(0);
  });
});
