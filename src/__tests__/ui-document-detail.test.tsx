// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DocumentPage } from "@/ui/pages/DocumentPage";
import { SummaryLanguageProvider } from "@/ui/summary-language";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DocumentPage", () => {
  it("records read history only after the explicit action", async () => {
    let historyPostCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = getUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/documents/doc-1")) {
          return jsonResponse(makeDocument("doc-1", "Readable agents"));
        }

        if (url.includes("/api/user/favorites")) {
          return jsonResponse([]);
        }

        if (url.includes("/api/user/history") && method === "GET") {
          return jsonResponse([]);
        }

        if (url.endsWith("/api/user/history") && method === "POST") {
          historyPostCount += 1;
          return jsonResponse({ document_id: "doc-1", recorded: true });
        }

        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/documents/doc-1"]}>
          <Routes>
            <Route element={<DocumentPage />} path="/documents/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Readable agents")).toBeInTheDocument();
    expect(historyPostCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));

    await waitFor(() => {
      expect(historyPostCount).toBe(1);
    });
    expect(await screen.findByRole("button", { name: "Marked as read" })).toBeDisabled();
  });

  it("generates a missing selected-language summary once and refreshes the detail", async () => {
    localStorage.setItem("paperhub:summary_lang", "en");
    let summarizePostCount = 0;
    let summarizeBody = "";
    const initialDocument = {
      ...makeDocument("doc-2", "Bilingual agents"),
      summaryEn: undefined,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = getUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/documents/doc-2")) {
          return jsonResponse(initialDocument);
        }
        if (url.endsWith("/api/user/preferences")) {
          return jsonResponse({ default_language: "zh" });
        }
        if (url.includes("/api/user/favorites") || url.includes("/api/user/history")) {
          return jsonResponse([]);
        }
        if (url.endsWith("/api/summarize") && method === "POST") {
          summarizePostCount += 1;
          summarizeBody = String(init?.body ?? "");
          return jsonResponse({
            document_id: "doc-2",
            lang: "en",
            summarized: true,
            document: {
              ...initialDocument,
              summaryEn: "Generated English summary",
            },
          });
        }

        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }),
    );

    renderDocumentPage("doc-2", true);

    expect(await screen.findByText("Generated English summary")).toBeInTheDocument();
    expect(summarizePostCount).toBe(1);
    expect(summarizeBody).toContain('"lang":"en"');
  });

  it("shows a retry action when on-demand generation fails", async () => {
    localStorage.setItem("paperhub:summary_lang", "en");
    let summarizePostCount = 0;
    const initialDocument = {
      ...makeDocument("doc-3", "Retryable agents"),
      summaryEn: undefined,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = getUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/documents/doc-3")) {
          return jsonResponse(initialDocument);
        }
        if (url.endsWith("/api/user/preferences")) {
          return jsonResponse({ default_language: "zh" });
        }
        if (url.includes("/api/user/favorites") || url.includes("/api/user/history")) {
          return jsonResponse([]);
        }
        if (url.endsWith("/api/summarize") && method === "POST") {
          summarizePostCount += 1;
          if (summarizePostCount === 1) {
            return errorResponse(500, "Summarization failed");
          }
          return jsonResponse({
            document_id: "doc-3",
            lang: "en",
            summarized: true,
            document: {
              ...initialDocument,
              summaryEn: "Summary after retry",
            },
          });
        }

        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }),
    );

    renderDocumentPage("doc-3", true);

    expect(await screen.findByText("English summary generation failed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Summary after retry")).toBeInTheDocument();
    expect(summarizePostCount).toBe(2);
  });
});

function renderDocumentPage(id: string, withLanguageProvider = false): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const page = (
    <MemoryRouter initialEntries={[`/documents/${id}`]}>
      <Routes>
        <Route element={<DocumentPage />} path="/documents/:id" />
      </Routes>
    </MemoryRouter>
  );

  render(
    <QueryClientProvider client={queryClient}>
      {withLanguageProvider ? <SummaryLanguageProvider>{page}</SummaryLanguageProvider> : page}
    </QueryClientProvider>,
  );
}

function getUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

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

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
