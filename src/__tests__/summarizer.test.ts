import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/types";

const { mockCallLlm, mockUpdateDocument, mockGetUserPreference } = vi.hoisted(() => ({
  mockCallLlm: vi.fn<(prompt: string, maxTokens: number) => Promise<string>>(),
  mockUpdateDocument: vi.fn(),
  mockGetUserPreference: vi.fn<(key: string) => string | null>(),
}));

vi.mock("@/report", () => ({ callLlm: mockCallLlm }));
vi.mock("@/db/documents", () => ({ updateDocument: mockUpdateDocument }));
vi.mock("@/db/user", () => ({
  getUserPreference: mockGetUserPreference,
}));

import {
  getConfiguredSummaryLanguage,
  getConfiguredSummaryLevel,
  needsSummary,
  summarizeDocument,
} from "@/summarizer";

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: "summary-doc",
    title: "A Paper",
    source: "arxiv",
    url: "https://example.com/paper",
    publishedAt: "2026-06-19T00:00:00Z",
    authors: ["Alice"],
    abstract: "ABSTRACT_MARKER",
    language: "en",
    domainTags: ["ML"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
    isSummarized: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockCallLlm.mockReset();
  mockUpdateDocument.mockReset();
  mockGetUserPreference.mockReset();
  mockGetUserPreference.mockImplementation((key) => {
    if (key === "summary_length") return "short";
    if (key === "interest_tags") return '["LLM"]';
    return null;
  });
});

describe("summarizer pipeline", () => {
  it("uses the short output budget and persists the summary level", async () => {
    mockCallLlm.mockResolvedValueOnce("short summary");

    const result = await summarizeDocument(makeDoc({ fullText: "FULL_TEXT_MARKER" }), "zh");

    expect(result).toBe("short summary");
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(mockCallLlm.mock.calls[0]?.[0]).toContain("FULL_TEXT_MARKER");
    expect(mockCallLlm.mock.calls[0]?.[1]).toBe(1_800);
    expect(mockUpdateDocument).toHaveBeenCalledWith("summary-doc", {
      isSummarized: true,
      summaryZh: "short summary",
      summaryZhLevel: "short",
    });
  });

  it("uses the detailed output budget", async () => {
    mockCallLlm.mockResolvedValueOnce("detailed summary");

    await summarizeDocument(makeDoc(), "en", { summaryLevel: "detailed" });

    expect(mockCallLlm.mock.calls[0]?.[1]).toBe(6_000);
    expect(mockUpdateDocument).toHaveBeenCalledWith("summary-doc", {
      isSummarized: true,
      summaryEn: "detailed summary",
      summaryEnLevel: "detailed",
    });
  });

  it("extracts every long-document chunk before final synthesis", async () => {
    const fullText = [
      "# Introduction",
      `INTRO_MARKER ${"A".repeat(34_000)}`,
      "# Conclusion",
      "FINAL_SOURCE_MARKER",
    ].join("\n\n");
    mockCallLlm.mockImplementation(async (prompt) =>
      prompt.includes("论文证据抽取器") ? "evidence" : "final summary",
    );

    const result = await summarizeDocument(makeDoc({ fullText }), "zh", { summaryLevel: "detailed" });

    const extractionPrompts = mockCallLlm.mock.calls
      .map(([prompt]) => prompt)
      .filter((prompt) => prompt.includes("论文证据抽取器"));
    expect(extractionPrompts.length).toBeGreaterThan(1);
    expect(extractionPrompts.join("\n")).toContain("INTRO_MARKER");
    expect(extractionPrompts.join("\n")).toContain("FINAL_SOURCE_MARKER");
    expect(mockCallLlm.mock.calls.at(-1)?.[1]).toBe(6_000);
    expect(result).toBe("final summary");
  });

  it("regenerates only when the requested level differs", () => {
    const doc = makeDoc({
      summaryZh: "existing",
      summaryZhLevel: "short",
      isSummarized: true,
    });
    expect(needsSummary(doc, "zh", "short")).toBe(false);
    expect(needsSummary(doc, "zh", "detailed")).toBe(true);
    expect(needsSummary(doc, "en", "short")).toBe(true);
  });

  it("reads the configured summary level defensively", () => {
    mockGetUserPreference.mockReturnValueOnce("detailed");
    expect(getConfiguredSummaryLevel()).toBe("detailed");
    mockGetUserPreference.mockReturnValueOnce("unexpected");
    expect(getConfiguredSummaryLevel()).toBe("short");
  });

  it("reads the configured summary language defensively", () => {
    mockGetUserPreference.mockReturnValueOnce("en");
    expect(getConfiguredSummaryLanguage()).toBe("en");
    mockGetUserPreference.mockReturnValueOnce("unexpected");
    expect(getConfiguredSummaryLanguage()).toBe("zh");
  });
});
