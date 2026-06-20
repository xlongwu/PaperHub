import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocument, getDocumentsByTag, searchDocuments, summarizeDocument } from "@/ui/lib/api";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ui api client", () => {
  it("builds search requests with pagination and time filters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T00:00:00Z"));

    let requestUrl = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestUrl = getUrl(input);
        return jsonResponse({
          results: [],
          total: 0,
          mode: "hybrid",
        });
      }),
    );

    await searchDocuments({
      query: "agents",
      mode: "hybrid",
      sources: ["arxiv"],
      tags: ["Agents"],
      timeRange: "30d",
      page: 2,
      limit: 12,
    });

    expect(requestUrl).toContain("/api/search?");
    expect(requestUrl).toContain("limit=12");
    expect(requestUrl).toContain("offset=12");
    expect(requestUrl).toContain("sources=arxiv");
    expect(requestUrl).toContain("tags=Agents");
    expect(requestUrl).toContain("from=2026-05-17T00%3A00%3A00.000Z");
    expect(requestUrl).toContain("to=2026-06-16T00%3A00%3A00.000Z");
  });

  it("builds tag document requests with pagination and sort", async () => {
    let requestUrl = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestUrl = getUrl(input);
        return jsonResponse([], { total: 24, limit: 12, page: 2 });
      }),
    );

    const payload = await getDocumentsByTag("Agents", { page: 2, limit: 12, sortBy: "relevance" });

    expect(requestUrl).toContain("/api/tags/Agents/documents?");
    expect(requestUrl).toContain("sortBy=relevance");
    expect(requestUrl).toContain("offset=12");
    expect(payload.page).toBe(2);
    expect(payload.total).toBe(24);
  });

  it("throws when the API returns an error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: "Document not found",
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    await expect(getDocument("missing")).rejects.toThrow("Document not found");
  });

  it("requests one document summary in the selected language", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return jsonResponse({
          document_id: "doc-1",
          lang: "en",
          summarized: true,
          document: { id: "doc-1", summaryEn: "Generated summary" },
        });
      }),
    );

    const result = await summarizeDocument("doc-1", "en");

    expect(requestBody).toContain('"document_id":"doc-1"');
    expect(requestBody).toContain('"lang":"en"');
    expect(result.document.summaryEn).toBe("Generated summary");
  });
});

function getUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(data: unknown, meta?: { total?: number; limit?: number; page?: number }): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      meta: {
        total: meta?.total ?? (Array.isArray(data) ? data.length : 1),
        limit: meta?.limit ?? (Array.isArray(data) ? data.length : 1),
        page: meta?.page ?? 1,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
