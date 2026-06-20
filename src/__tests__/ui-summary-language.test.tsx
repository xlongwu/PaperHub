// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DocumentCard } from "@/ui/components";
import { SummaryLanguageProvider, useSummaryLanguage } from "@/ui/summary-language";
import type { Document } from "@/types";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("summary language context", () => {
  it("ignores the legacy abstract value and falls back to the user preference", async () => {
    localStorage.setItem("paperhub:summary_lang", "abstract");
    stubPreferences("en");

    renderSummarySurface();

    await waitFor(() => {
      expect(screen.getByTestId("active-language")).toHaveTextContent("en");
    });
    expect(localStorage.getItem("paperhub:summary_lang")).toBeNull();
  });

  it("updates cards immediately and never falls back to the other summary language", async () => {
    localStorage.setItem("paperhub:summary_lang", "zh");
    const fetchMock = stubPreferences("zh");

    renderSummarySurface();

    expect(await screen.findByText("中文卡片总结")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "switch-en" }));

    expect(await screen.findByText("Original abstract")).toBeInTheDocument();
    expect(screen.queryByText("中文卡片总结")).not.toBeInTheDocument();
    expect(localStorage.getItem("paperhub:summary_lang")).toBe("en");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function renderSummarySurface(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SummaryLanguageProvider>
          <LanguageProbe />
          <DocumentCard document={makeDocument()} />
        </SummaryLanguageProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LanguageProbe(): JSX.Element {
  const { language, setLanguage } = useSummaryLanguage();
  return (
    <div>
      <span data-testid="active-language">{language}</span>
      <button onClick={() => setLanguage("en")} type="button">
        switch-en
      </button>
    </div>
  );
}

function stubPreferences(defaultLanguage: "zh" | "en") {
  const fetchMock = vi.fn(async () =>
    jsonResponse({
      default_language: defaultLanguage,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDocument(): Document {
  return {
    id: "summary-language-card",
    title: "Summary language card",
    source: "arxiv",
    url: "https://example.com/summary-language-card",
    publishedAt: "2026-06-20T00:00:00Z",
    authors: ["Alice"],
    abstract: "Original abstract",
    language: "en",
    domainTags: ["Agents"],
    sourceTag: "arXiv",
    typeTag: "paper",
    yearTag: 2026,
    modelTags: [],
    summaryZh: "中文卡片总结",
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    isSummarized: true,
  };
}
