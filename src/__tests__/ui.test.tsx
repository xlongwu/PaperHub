// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HomePage } from "@/ui/pages/HomePage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HomePage", () => {
  it("renders recommendation and latest sections from the API layer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/api/recommendations/hot")) {
          return jsonResponse([makeRecommendation("hot-1", "Hot agents")]);
        }

        if (url.includes("/api/recommendations/personalized")) {
          return jsonResponse([makeRecommendation("personal-1", "Personalized planning")]);
        }

        if (url.includes("/api/documents?limit=8")) {
          return jsonResponse([makeDocument("latest-1", "Latest memory systems")]);
        }

        throw new Error(`Unhandled fetch: ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("热门").length).toBeGreaterThan(0);
    expect(await screen.findByText("Hot agents")).toBeInTheDocument();
    expect(await screen.findByText("Personalized planning")).toBeInTheDocument();
    expect(await screen.findByText("Latest memory systems")).toBeInTheDocument();
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      meta: {
        total: Array.isArray(data) ? data.length : 1,
        limit: Array.isArray(data) ? data.length : 1,
        page: 1,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function makeRecommendation(id: string, title: string) {
  return {
    document: makeDocument(id, title),
    score: 0.91,
    reason: {
      kind: "personalized",
      matchedTags: ["Agents"],
      factors: ["match:Agents", "recently_published"],
    },
  };
}

function makeDocument(id: string, title: string) {
  return {
    id,
    title,
    source: "arxiv",
    url: `https://example.com/${id}`,
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
  };
}
