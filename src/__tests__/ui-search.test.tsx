// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { SearchPage } from "@/ui/pages/SearchPage";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SearchPage", () => {
  it("keeps URL parameters as the single source of truth when navigation clears filters", async () => {
    const requests: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = getUrl(input);
        requests.push(url);

        if (url.includes("q=agents")) {
          return searchResponse("Agents result", 1);
        }

        if (url.includes("q=memory")) {
          return searchResponse("Memory result", 1);
        }

        throw new Error(`Unhandled fetch: ${url}`);
      }),
    );

    renderSearchPage("/search?q=agents&mode=hybrid&tags=Agents", true);

    expect(await screen.findByText("Agents result")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Navigate to plain search" }));

    expect(await screen.findByText("Memory result")).toBeInTheDocument();
    expect(requests.at(-1)).toContain("q=memory");
    expect(requests.at(-1)).not.toContain("tags=Agents");
  });

  it("submits time filters and paginates through the result set", async () => {
    const requests: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = getUrl(input);
        requests.push(url);
        const offset = new URL(url, "http://localhost").searchParams.get("offset");

        if (offset === "10") {
          return searchResponse("Second page result", 24);
        }

        return searchResponse("First page result", 24);
      }),
    );

    renderSearchPage("/search");
    fireEvent.click(screen.getByRole("tab", { name: "本地知识库" }));

    fireEvent.change(screen.getByLabelText("查询"), { target: { value: "agents" } });
    fireEvent.change(screen.getByLabelText("发布时间"), { target: { value: "30d" } });
    fireEvent.click(screen.getByRole("button", { name: "执行搜索" }));

    expect(await screen.findByText("First page result")).toBeInTheDocument();
    expect(requests.at(-1)).toContain("from=");
    expect(requests.at(-1)).toContain("to=");
    expect(requests.at(-1)).toContain("limit=10");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("Second page result")).toBeInTheDocument();
    expect(requests.at(-1)).toContain("offset=10");
    expect(screen.getByText("Page 2 / 3")).toBeInTheDocument();
  });

  it("opens Web Search by default and restores the created session", async () => {
    let createdRequest: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = getUrl(input);
        if (url.endsWith("/api/web-search") && init?.method === "POST") {
          createdRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                sessionId: "ws_ui",
                status: "created",
                eventsUrl: "/api/web-search/ws_ui/events",
                expiresAt: "2026-06-21T00:00:00Z",
              },
            }),
            { status: 202, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/web-search/ws_ui")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: "ws_ui",
                request: { query: "agent memory", scope: "academic" },
                status: "completed",
                providerRuns: [{ providerId: "arxiv", status: "success", resultCount: 1, latencyMs: 12 }],
                results: [
                  {
                    id: "wr_ui",
                    sessionId: "ws_ui",
                    title: "Web-only Agent Memory",
                    url: "https://arxiv.org/abs/2501.12345",
                    authors: ["Alice"],
                    publishedAt: "2026-06-18T00:00:00Z",
                    contentType: "paper",
                    abstract: "A temporary Web Search result.",
                    identifiers: { arxivId: "2501.12345" },
                    origin: { domain: "arxiv.org", sourceName: "arXiv" },
                    providerEvidence: [],
                    ranking: {
                      aggregateScore: 1,
                      providerRrfScore: 1,
                      conceptCoverageScore: 1,
                      freshnessScore: 1,
                      sourceQualityScore: 1,
                      metadataQualityScore: 1,
                    },
                    match: { matchedConcepts: [], matchedFields: [], missingMustConcepts: [] },
                    localState: { status: "not_saved" },
                    createdAt: "2026-06-20T00:00:00Z",
                    expiresAt: "2026-06-21T00:00:00Z",
                  },
                ],
                createdAt: "2026-06-20T00:00:00Z",
                updatedAt: "2026-06-20T00:00:01Z",
                expiresAt: "2026-06-21T00:00:00Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unhandled fetch: ${url}`);
      }),
    );

    renderSearchPage("/search");

    expect(screen.getByRole("tab", { name: "Web 搜索" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("搜索词"), { target: { value: "agent memory" } });
    fireEvent.change(screen.getByLabelText("结果数量"), { target: { value: "37" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索网络" }));

    expect(await screen.findByText("Web-only Agent Memory")).toBeInTheDocument();
    expect(createdRequest?.maxResults).toBe(37);
    expect(screen.getByText("Temporary")).toBeInTheDocument();
    expect(screen.getByText(/success · 1 results/)).toBeInTheDocument();
  });

  it("restores the latest Web Search session after returning without URL parameters", async () => {
    localStorage.setItem(
      "paperhub.web-search.state.v1",
      JSON.stringify({
        query: "restored query",
        scope: "academic",
        from: "2024-01-01",
        to: "2026-06-21",
        includeDomains: "",
        excludeDomains: "",
        searchBudget: "balanced",
        maxResults: 25,
        autoSummarize: true,
        includeSearchMcp: false,
        sessionId: "ws_restored",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = getUrl(input);
        if (!url.endsWith("/api/web-search/ws_restored")) {
          throw new Error(`Unhandled fetch: ${url}`);
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "ws_restored",
              request: { query: "restored query", scope: "academic", maxResults: 25 },
              status: "completed",
              providerRuns: [],
              results: [],
              createdAt: "2026-06-20T00:00:00Z",
              updatedAt: "2026-06-20T00:00:01Z",
              expiresAt: "2026-06-22T00:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    renderSearchPage("/search");

    expect(await screen.findByDisplayValue("restored query")).toBeInTheDocument();
    expect(screen.getByDisplayValue("25")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "completed" })).toBeInTheDocument();
    expect(screen.getByText(/0 temporary results/)).toBeInTheDocument();
  });
});

function renderSearchPage(initialEntry: string, includeNavigator = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {includeNavigator ? <SearchNavigator /> : null}
        <Routes>
          <Route element={<SearchPage />} path="/search" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function SearchNavigator(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/search?q=memory")} type="button">
      Navigate to plain search
    </button>
  );
}

function getUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function searchResponse(title: string, total: number): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        results: [makeSearchResult(title)],
        total,
        mode: "hybrid",
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function makeSearchResult(title: string) {
  return {
    document: {
      id: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      source: "arxiv",
      url: "https://example.com/search-result",
      publishedAt: "2026-06-16T00:00:00Z",
      authors: ["Alice"],
      abstract: `${title} abstract`,
      language: "en",
      domainTags: ["Agents"],
      sourceTag: "arXiv",
      typeTag: "paper",
      yearTag: 2026,
      modelTags: ["GPT-4"],
      createdAt: "2026-06-16T00:00:00Z",
      updatedAt: "2026-06-16T00:00:00Z",
      isSummarized: true,
      summaryZh: `${title} summary`,
      summaryEn: `${title} summary`,
    },
    score: 0.95,
    matchType: "hybrid",
    snippet: `${title} snippet`,
  };
}
