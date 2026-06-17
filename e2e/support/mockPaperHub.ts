import fs from "node:fs";
import path from "node:path";
import type { Page, Route } from "@playwright/test";
import {
  hotRecommendationsResponse,
  listDocumentsResponse,
  personalizedRecommendationsResponse,
  rebuildUserMemoryResponse,
  searchResponse,
  userMemoryResponse,
} from "@/api/server";
import { initDatabase } from "@/db/index";
import { getDocumentById } from "@/db/documents";
import { countDocumentsByTag, getDocumentsByTag, getTagCloud } from "@/db/tags";
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

const distDir = path.resolve(process.cwd(), "dist-ui");
const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf-8");
let bootstrapped = false;

export async function installMockPaperHub(page: Page): Promise<void> {
  bootstrapHarness();

  await page.route("http://paperhub.test/**", async (route) => {
    await handleRoute(route);
  });
}

function bootstrapHarness(): void {
  if (bootstrapped) {
    return;
  }

  initDatabase();
  initDefaultPreferences();
  bootstrapped = true;
}

async function handleRoute(route: Route): Promise<void> {
  const url = new URL(route.request().url());

  if (url.pathname.startsWith("/api/")) {
    await fulfillApi(route, url);
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const assetPath = path.join(distDir, url.pathname);
    await route.fulfill({
      status: 200,
      body: fs.readFileSync(assetPath),
      contentType: getContentType(assetPath),
    });
    return;
  }

  await route.fulfill({
    status: 200,
    body: indexHtml,
    contentType: "text/html; charset=utf-8",
  });
}

async function fulfillApi(route: Route, url: URL): Promise<void> {
  const method = route.request().method();

  if (url.pathname === "/api/recommendations/hot" && method === "GET") {
    const payload = hotRecommendationsResponse({ limit: 10 });
    return json(route, payload.data, payload.meta);
  }

  if (url.pathname === "/api/recommendations/personalized" && method === "GET") {
    const payload = await personalizedRecommendationsResponse({ limit: 10 });
    return json(route, payload.data, payload.meta);
  }

  if (url.pathname === "/api/documents" && method === "GET") {
    const payload = listDocumentsResponse({
      limit: Number.parseInt(url.searchParams.get("limit") ?? "20", 10),
      offset: Number.parseInt(url.searchParams.get("offset") ?? "0", 10),
      source: url.searchParams.get("source") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    return json(route, payload.data, payload.meta);
  }

  if (url.pathname.startsWith("/api/documents/") && method === "GET") {
    const id = decodeURIComponent(url.pathname.replace("/api/documents/", ""));
    const document = getDocumentById(id);
    if (!document) {
      return route.fulfill({
        status: 404,
        body: JSON.stringify({ success: false, error: "Document not found" }),
        contentType: "application/json; charset=utf-8",
      });
    }
    return json(route, document);
  }

  if (url.pathname === "/api/search" && method === "GET") {
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
    return json(route, payload);
  }

  if (url.pathname === "/api/tags" && method === "GET") {
    const payload = getTagCloud({
      category: url.searchParams.get("category") ?? undefined,
    });
    return json(route, payload);
  }

  if (url.pathname.startsWith("/api/tags/") && url.pathname.endsWith("/documents") && method === "GET") {
    const tag = decodeURIComponent(url.pathname.replace("/api/tags/", "").replace("/documents", "").replace(/\/$/, ""));
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "12", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const page = Math.floor(offset / limit) + 1;
    const payload = getDocumentsByTag(tag, {
      limit,
      offset,
      sortBy: url.searchParams.get("sortBy") === "relevance" ? "relevance" : "time",
    });
    return json(route, payload, {
      total: countDocumentsByTag(tag),
      limit,
      page,
    });
  }

  if (url.pathname === "/api/user/preferences" && method === "GET") {
    return json(route, getUserPreferences());
  }

  if (url.pathname === "/api/user/preferences" && method === "POST") {
    const body = route.request().postDataJSON() as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      setUserPreference(key, value);
    }
    return json(route, getUserPreferences());
  }

  if (url.pathname === "/api/user/memory" && method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
    const payload = userMemoryResponse({ limit });
    return json(route, payload.data, payload.meta);
  }

  if (url.pathname === "/api/user/memory/rebuild" && method === "POST") {
    const payload = rebuildUserMemoryResponse({ maxDays: 30, maxTerms: 24 });
    return json(route, payload);
  }

  if (url.pathname === "/api/user/history" && method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const page = Math.floor(offset / limit) + 1;
    const payload = getHistory({ limit, offset });
    return json(route, payload, {
      total: countHistory(),
      limit,
      page,
    });
  }

  if (url.pathname === "/api/user/history" && method === "POST") {
    const body = route.request().postDataJSON() as { document_id: string };
    recordHistory(body.document_id);
    return json(route, { document_id: body.document_id, recorded: true });
  }

  if (url.pathname === "/api/user/favorites" && method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const page = Math.floor(offset / limit) + 1;
    const payload = getFavorites({ limit, offset });
    return json(route, payload, {
      total: countFavorites(),
      limit,
      page,
    });
  }

  if (url.pathname === "/api/user/favorites" && method === "POST") {
    const body = route.request().postDataJSON() as { document_id: string };
    addFavorite(body.document_id);
    return json(route, { document_id: body.document_id, favorited: true });
  }

  if (url.pathname.startsWith("/api/user/favorites/") && method === "DELETE") {
    const id = decodeURIComponent(url.pathname.replace("/api/user/favorites/", ""));
    removeFavorite(id);
    return json(route, { document_id: id, favorited: false });
  }

  await route.fulfill({
    status: 404,
    body: JSON.stringify({ success: false, error: `Unhandled route ${method} ${url.pathname}` }),
    contentType: "application/json; charset=utf-8",
  });
}

function json(route: Route, data: unknown, meta?: { total?: number; limit?: number; page?: number }) {
  return route.fulfill({
    status: 200,
    body: JSON.stringify({
      success: true,
      data,
      meta,
    }),
    contentType: "application/json; charset=utf-8",
  });
}

function splitCsv(value: string | null): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function asMode(value: string | null): "keyword" | "semantic" | "hybrid" | undefined {
  if (value === "keyword" || value === "semantic" || value === "hybrid") {
    return value;
  }

  return undefined;
}

function getContentType(filePath: string): string {
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (filePath.endsWith(".png")) {
    return "image/png";
  }
  return "application/octet-stream";
}
