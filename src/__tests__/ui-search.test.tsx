// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { SearchPage } from "@/ui/pages/SearchPage";

afterEach(() => {
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

        if (offset === "12") {
          return searchResponse("Second page result", 24);
        }

        return searchResponse("First page result", 24);
      }),
    );

    renderSearchPage("/search");

    fireEvent.change(screen.getByLabelText("Query"), { target: { value: "agents" } });
    fireEvent.change(screen.getByLabelText("Published within"), { target: { value: "30d" } });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    expect(await screen.findByText("First page result")).toBeInTheDocument();
    expect(requests.at(-1)).toContain("from=");
    expect(requests.at(-1)).toContain("to=");
    expect(requests.at(-1)).toContain("limit=12");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Second page result")).toBeInTheDocument();
    expect(requests.at(-1)).toContain("offset=12");
    expect(screen.getByText("Page 2 / 2")).toBeInTheDocument();
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
