/**
 * Claude Blog collector — fetches Anthropic blog via sitemap + page content.
 * Reuses web.ts sitemap parsing logic.
 */

import { parseSitemapUrls, isSitemapIndex, extractTitle, extractText, urlCategory } from "@/web";
import type { RawDocument, ContentCollector } from "@/collectors/types";
import { documentExists } from "@/db/documents";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SITEMAP_URL = "https://www.anthropic.com/sitemap.xml";
const PREFIXES = ["/news/", "/research/", "/engineering/", "/learn/"];
const MAX_CONTENT_LENGTH = 2000;
const FETCH_TIMEOUT_MS = 10000;
const FETCH_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const WEB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PaperHub/1.0)",
  Accept: "text/html,application/xml,text/xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function httpGet(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: WEB_HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// URL discovery
// ---------------------------------------------------------------------------

async function discoverUrls(): Promise<Array<{ loc: string; lastmod?: string }>> {
  const xml = await httpGet(SITEMAP_URL);

  if (isSitemapIndex(xml)) {
    // Sitemap index — fetch sub-sitemaps
    const results: Array<{ loc: string; lastmod?: string }> = [];
    const sitemaps = parseSitemapUrls(xml);
    for (const { loc } of sitemaps) {
      try {
        const subXml = await httpGet(loc);
        results.push(...parseSitemapUrls(subXml));
        await sleep(100);
      } catch (err) {
        console.error(`[collector/claude-blog] Sub-sitemap failed: ${loc} — ${err}`);
      }
    }
    return results;
  }

  // Single sitemap
  const all = parseSitemapUrls(xml);
  return all.filter(({ loc }) => {
    try {
      return PREFIXES.some((p) => new URL(loc).pathname.startsWith(p));
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export const claudeBlogCollector: ContentCollector = {
  id: "claude_blog",
  name: "Anthropic Blog",
  sourceTag: "Claude Blog",
  interval: 30 * 60 * 1000, // 30 minutes

  async fetch(): Promise<RawDocument[]> {
    console.log("[collector/claude-blog] Discovering URLs from sitemap...");

    let allDiscovered: Array<{ loc: string; lastmod?: string }>;
    try {
      allDiscovered = await discoverUrls();
    } catch (err) {
      console.error(`[collector/claude-blog] Sitemap discovery failed: ${err}`);
      return [];
    }

    console.log(`[collector/claude-blog] Discovered ${allDiscovered.length} URLs`);

    // Sort newest first
    allDiscovered.sort((a, b) => {
      if (!a.lastmod && !b.lastmod) return 0;
      if (!a.lastmod) return 1;
      if (!b.lastmod) return -1;
      return b.lastmod.localeCompare(a.lastmod);
    });

    // Filter to new URLs only
    const newUrls = allDiscovered.filter(({ loc }) => !documentExists(loc));

    // Cap to avoid excessive fetching
    const toFetch = newUrls.slice(0, 25);
    console.log(`[collector/claude-blog] ${newUrls.length} new URLs, fetching ${toFetch.length}`);

    const results: RawDocument[] = [];
    for (const { loc, lastmod } of toFetch) {
      try {
        const html = await httpGet(loc);
        const title = extractTitle(html);
        const content = extractText(html);

        results.push({
          title: title || loc.split("/").pop() || "Untitled",
          source: "claude_blog",
          url: loc,
          publishedAt: lastmod ? new Date(lastmod).toISOString() : new Date().toISOString(),
          authors: [],
          abstract: content.slice(0, MAX_CONTENT_LENGTH),
          content: content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : undefined,
          language: "en",
          metadata: {
            category: urlCategory(loc),
          },
        });
      } catch (err) {
        console.error(`[collector/claude-blog] Failed to fetch ${loc}: ${err}`);
      }
      await sleep(FETCH_DELAY_MS);
    }

    console.log(`[collector/claude-blog] ${results.length} new articles fetched.`);
    return results;
  },
};
