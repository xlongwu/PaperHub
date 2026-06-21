// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/ui/app/App";

vi.mock("@/report", () => ({
  callLlm: vi.fn(async () => "Phase 6 generated memo"),
}));

import {
  hotRecommendationsResponse,
  listDocumentsResponse,
  personalizedRecommendationsResponse,
  rebuildUserMemoryResponse,
  searchResponse,
  userMemoryResponse,
} from "@/api/server";
import { getDbPath } from "@/config";
import { getDocumentById, insertDocument } from "@/db/documents";
import { closeDb, initDatabase } from "@/db/index";
import { countDocumentsByTag, getDocumentsByTag, getTagCloud, refreshTagStats } from "@/db/tags";
import {
  addFavorite,
  countFavorites,
  countHistory,
  getFavorites,
  getHistory,
  getUserPreferences,
  initDefaultPreferences,
  recordHistory,
  removeFavorite,
  setUserPreference,
} from "@/db/user";
import { rebuildUserMemoryFromDigests, refreshHotRecommendations } from "@/recommendation";
import {
  createPhase6FixtureDocuments,
  PHASE6_DEFAULT_PREFERENCES,
  PHASE6_FIXTURE_NOW,
} from "@/test-support/phase6-fixtures";

const TEST_DATA_DIR = path.resolve(process.cwd(), ".tmp", "phase6-release-test");

beforeEach(() => {
  process.env["PAPERHUB_DATA_DIR"] = TEST_DATA_DIR;
  seedPhase6State();
  vi.stubGlobal("fetch", vi.fn(handleFetch));
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

describe("phase6 release smoke", () => {
  it("home page surfaces the release candidate data set", async () => {
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "热门看板" })).toBeInTheDocument();
    expect((await screen.findAllByText("Agent Memory Systems in Production")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "为你推荐" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "最新收录" })).toBeInTheDocument();
  });

  it("search reaches document detail and profile reflects read and favorite actions", async () => {
    renderApp("/search");
    fireEvent.click(screen.getByRole("tab", { name: "本地知识库" }));

    fireEvent.change(screen.getByLabelText("查询"), { target: { value: "multimodal ops" } });
    fireEvent.change(screen.getByLabelText("模式"), { target: { value: "keyword" } });
    fireEvent.click(screen.getByRole("button", { name: "执行搜索" }));

    expect(await screen.findByText("Multimodal Ops Playbook")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Multimodal Ops Playbook" }));

    expect(await screen.findByRole("heading", { name: "Multimodal Ops Playbook" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(await screen.findByRole("button", { name: "取消收藏" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已标记已读" })).toBeDisabled();
    });

    fireEvent.click(screen.getByRole("link", { name: "个人" }));
    expect(await screen.findByRole("heading", { name: "个人设置" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "doc-e2e-multimodal-ops" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "doc-e2e-rag-systems" })).toBeInTheDocument();

    const interestTags = screen.getByLabelText("兴趣标签");
    await waitFor(() => {
      expect(interestTags).toHaveValue("Agents, RAG, Multimodal");
    });
    fireEvent.change(interestTags, { target: { value: "Agents, RAG, Planning" } });
    expect(interestTags).toHaveValue("Agents, RAG, Planning");
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(interestTags).toHaveValue("Agents, RAG, Planning");
      expect(getUserPreferences().interest_tags).toBe(JSON.stringify(["Agents", "RAG", "Planning"]));
    });
  });

  it("search api respects the release-candidate date filter window", async () => {
    const response = await fetch(
      "http://paperhub.test/api/search?q=agent&mode=keyword&limit=20&offset=0&from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T23%3A59%3A59.999Z",
    );
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        total: number;
        results: Array<{
          document: {
            id: string;
            publishedAt: string;
          };
        }>;
      };
    };

    expect(payload.success).toBeTruthy();
    expect(payload.data?.total).toBeGreaterThan(0);

    const documentIds = payload.data?.results.map((item) => item.document.id) ?? [];
    expect(documentIds).toContain("doc-e2e-agent-memory");
    expect(documentIds).not.toContain("doc-e2e-year-2025");

    for (const result of payload.data?.results ?? []) {
      expect(result.document.publishedAt >= "2026-06-01T00:00:00.000Z").toBeTruthy();
      expect(result.document.publishedAt <= "2026-06-30T23:59:59.999Z").toBeTruthy();
    }
  });

  it("tags page supports category browsing, sorting, and pagination", async () => {
    renderApp("/tags");

    expect(await screen.findByRole("heading", { name: "标签图谱" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "领域" }));
    fireEvent.click(await screen.findByRole("link", { name: /Agents/ }));

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(await screen.findByText("Page 1 / 2")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "relevance" } });
    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));

    expect(await screen.findByText("Page 2 / 2")).toBeInTheDocument();
    expect(screen.getByText("Agent Archive Note 5")).toBeInTheDocument();
    expect(screen.queryByText("Agent Archive Note 10")).not.toBeInTheDocument();
  });
});

function renderApp(initialEntry: string) {
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
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function handleFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = toRequest(input, init);
  const url = new URL(request.url);

  if (url.pathname === "/api/recommendations/hot" && request.method === "GET") {
    const payload = hotRecommendationsResponse({ limit: 10 });
    return jsonResponse(payload.data, payload.meta);
  }

  if (url.pathname === "/api/recommendations/personalized" && request.method === "GET") {
    const payload = await personalizedRecommendationsResponse({ limit: 10 });
    return jsonResponse(payload.data, payload.meta);
  }

  if (url.pathname === "/api/documents" && request.method === "GET") {
    const payload = listDocumentsResponse({
      limit: Number.parseInt(url.searchParams.get("limit") ?? "20", 10),
      offset: Number.parseInt(url.searchParams.get("offset") ?? "0", 10),
      source: url.searchParams.get("source") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    return jsonResponse(payload.data, payload.meta);
  }

  if (url.pathname.startsWith("/api/documents/") && request.method === "GET") {
    const id = decodeURIComponent(url.pathname.replace("/api/documents/", ""));
    const document = getDocumentById(id);
    if (!document) {
      return errorResponse(404, "Document not found");
    }
    return jsonResponse(document);
  }

  if (url.pathname === "/api/search" && request.method === "GET") {
    const payload = await searchResponse({
      query: url.searchParams.get("q") ?? "",
      mode: asMode(url.searchParams.get("mode")),
      limit: Number.parseInt(url.searchParams.get("limit") ?? "12", 10),
      offset: Number.parseInt(url.searchParams.get("offset") ?? "0", 10),
      sources: splitCsv(url.searchParams.get("sources")),
      tags: splitCsv(url.searchParams.get("tags")),
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    return jsonResponse(payload);
  }

  if (url.pathname === "/api/tags" && request.method === "GET") {
    return jsonResponse(
      getTagCloud({
        category: url.searchParams.get("category") ?? undefined,
      }),
    );
  }

  if (
    url.pathname.startsWith("/api/tags/") &&
    url.pathname.endsWith("/documents") &&
    request.method === "GET"
  ) {
    const tag = decodeURIComponent(
      url.pathname.replace("/api/tags/", "").replace("/documents", "").replace(/\/$/, ""),
    );
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "12", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const page = Math.floor(offset / limit) + 1;
    return jsonResponse(
      getDocumentsByTag(tag, {
        limit,
        offset,
        sortBy: url.searchParams.get("sortBy") === "relevance" ? "relevance" : "time",
      }),
      {
        total: countDocumentsByTag(tag),
        limit,
        page,
      },
    );
  }

  if (url.pathname === "/api/user/preferences" && request.method === "GET") {
    return jsonResponse(getUserPreferences());
  }

  if (url.pathname === "/api/user/preferences" && request.method === "POST") {
    const body = (await request.json()) as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      setUserPreference(key, value);
    }
    return jsonResponse(getUserPreferences());
  }

  if (url.pathname === "/api/user/memory" && request.method === "GET") {
    const payload = userMemoryResponse({
      limit: Number.parseInt(url.searchParams.get("limit") ?? "24", 10),
    });
    return jsonResponse(payload.data, payload.meta);
  }

  if (url.pathname === "/api/user/memory/rebuild" && request.method === "POST") {
    return jsonResponse(rebuildUserMemoryResponse({ maxDays: 30, maxTerms: 24 }));
  }

  if (url.pathname === "/api/user/history" && request.method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    return jsonResponse(getHistory({ limit, offset }), {
      total: countHistory(),
      limit,
      page: Math.floor(offset / limit) + 1,
    });
  }

  if (url.pathname === "/api/user/history" && request.method === "POST") {
    const body = (await request.json()) as { document_id: string };
    recordHistory(body.document_id);
    return jsonResponse({ document_id: body.document_id, recorded: true });
  }

  if (url.pathname === "/api/user/favorites" && request.method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    return jsonResponse(getFavorites({ limit, offset }), {
      total: countFavorites(),
      limit,
      page: Math.floor(offset / limit) + 1,
    });
  }

  if (url.pathname === "/api/user/favorites" && request.method === "POST") {
    const body = (await request.json()) as { document_id: string };
    addFavorite(body.document_id);
    return jsonResponse({ document_id: body.document_id, favorited: true });
  }

  if (url.pathname.startsWith("/api/user/favorites/") && request.method === "DELETE") {
    const id = decodeURIComponent(url.pathname.replace("/api/user/favorites/", ""));
    removeFavorite(id);
    return jsonResponse({ document_id: id, favorited: false });
  }

  throw new Error(`Unhandled fetch: ${request.method} ${request.url}`);
}

function seedPhase6State() {
  const dbPath = getDbPath();

  closeDb();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });

  initDatabase();
  initDefaultPreferences();

  for (const document of createPhase6FixtureDocuments()) {
    insertDocument(document);
  }

  for (const [key, value] of Object.entries(PHASE6_DEFAULT_PREFERENCES)) {
    setUserPreference(key, value);
  }

  recordHistory("doc-e2e-agent-memory");
  addFavorite("doc-e2e-rag-systems");

  refreshTagStats();
  rebuildUserMemoryFromDigests({
    maxDays: 30,
    maxTerms: 24,
    now: new Date(PHASE6_FIXTURE_NOW),
  });
  refreshHotRecommendations({
    limit: 12,
    includeRead: true,
    now: new Date(PHASE6_FIXTURE_NOW),
  });
}

function toRequest(input: string | URL | Request, init?: RequestInit): Request {
  if (input instanceof Request) {
    return input;
  }

  if (input instanceof URL) {
    return new Request(input.toString(), init);
  }

  return new Request(new URL(input, "http://paperhub.test").toString(), init);
}

function jsonResponse(data: unknown, meta?: { total?: number; limit?: number; page?: number }): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      meta,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function splitCsv(value: string | null): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function asMode(value: string | null): "keyword" | "semantic" | "hybrid" | undefined {
  if (value === "keyword" || value === "semantic" || value === "hybrid") {
    return value;
  }

  return undefined;
}
