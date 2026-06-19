/**
 * ArXiv AI papers fetched via the ArXiv API (Atom feed).
 *
 * Strategy: query cs.AI + cs.CL + cs.LG categories for the newest papers,
 * sorted by submission date, filtered to last 48h.
 */

import { loadPaperHubConfig } from "@/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  url: string;
  pdfUrl: string;
}

export interface ArxivData {
  papers: ArxivPaper[];
  fetchSuccess: boolean;
}

export interface ArxivFetchOptions {
  /** Maximum results per category fetch (default: config value, max 2000) */
  maxResults?: number;
  /** Only return papers published on or after this date (ISO 8601) */
  fromDate?: string;
  /** Only return papers published on or before this date (ISO 8601) */
  toDate?: string;
  /** Specific categories to fetch (overrides config) */
  categories?: string[];
  /** Starting offset for paginated results */
  startIndex?: number;
  /** Maximum pages per category (default 10). */
  maxPages?: number;
}

/** ArXiv categories to search — driven by PaperHub config. */
function getCategories(): string[] {
  try {
    return loadPaperHubConfig().arxivCategories;
  } catch {
    return ["cs.AI", "cs.CL", "cs.LG"];
  }
}

/** Default max results from config, capped at 2000. */
function getDefaultMaxResults(): number {
  try {
    return Math.min(loadPaperHubConfig().arxivMaxResults, 2000);
  } catch {
    return 50;
  }
}

/** Delay between requests (ArXiv asks for 3s). */
const REQUEST_DELAY_MS = 3000;
const API_URL = "https://export.arxiv.org/api/query";

// ---------------------------------------------------------------------------
// XML helpers (lightweight, no dependency)
// ---------------------------------------------------------------------------

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1]!.trim() : "";
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]!.trim());
  }
  return results;
}

function extractAttr(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]!);
  }
  return results;
}

function extractLinkHref(xml: string, rel: string): string {
  const re = new RegExp(`<link[^>]*rel="${rel}"[^>]*href="([^"]*)"[^>]*/?>`, "g");
  const m = re.exec(xml);
  return m ? m[1]! : "";
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function parseEntry(entryXml: string): ArxivPaper | null {
  const id = extractTag(entryXml, "id");
  if (!id) return null;

  const title = extractTag(entryXml, "title").replace(/\s+/g, " ");
  const summary = extractTag(entryXml, "summary").replace(/\s+/g, " ");
  const authors = extractAllTags(entryXml, "name");
  const published = extractTag(entryXml, "published");
  const updated = extractTag(entryXml, "updated");
  const categories = extractAttr(entryXml, "category", "term");

  const url = id; // ArXiv id IS the URL (e.g. http://arxiv.org/abs/...)
  const pdfUrl = extractLinkHref(entryXml, "related") || id.replace("/abs/", "/pdf/");

  return { id, title, summary, authors, published, updated, categories, url, pdfUrl };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchArxivData(options?: ArxivFetchOptions): Promise<ArxivData> {
  const categories = options?.categories ?? getCategories();
  const maxResults = options?.maxResults ?? getDefaultMaxResults();
  const seen = new Map<string, ArxivPaper>();

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    if (i > 0) await sleep(REQUEST_DELAY_MS);

    try {
      // Build query with optional date range.
      let searchQuery = `cat:${cat}`;
      if (options?.fromDate) {
        const from = options.fromDate.replace(/T.*/, "").replace(/-/g, "");
        searchQuery += ` AND submittedDate:[${from}0000 TO 999912312359]`;
      }
      if (options?.toDate) {
        const to = options.toDate.replace(/T.*/, "").replace(/-/g, "");
        searchQuery += ` AND submittedDate:[000000000000 TO ${to}2359]`;
      }

      const pageSize = Math.max(1, Math.min(maxResults, 2000));
      const maxPages = Math.max(1, options?.maxPages ?? 10);
      let start = Math.max(0, options?.startIndex ?? 0);

      for (let page = 0; page < maxPages; page++) {
        if (page > 0) await sleep(REQUEST_DELAY_MS);
        const params = new URLSearchParams({
          search_query: searchQuery,
          sortBy: "submittedDate",
          sortOrder: "descending",
          max_results: String(pageSize),
          start: String(start),
        });

        const resp = await fetch(`${API_URL}?${params}`, {
          headers: { "User-Agent": "paperhub/1.0 (local research reader)" },
        });
        if (!resp.ok) {
          console.error(`  [arxiv] ${cat}: HTTP ${resp.status}`);
          break;
        }

        const xml = await resp.text();
        const entryBlocks = xml.split("<entry>").slice(1);
        for (const block of entryBlocks) {
          const paper = parseEntry("<entry>" + block);
          if (paper && !seen.has(paper.id)) {
            seen.set(paper.id, paper);
          }
        }
        console.log(`  [arxiv] ${cat} page ${page + 1}: ${entryBlocks.length} papers`);
        if (entryBlocks.length < pageSize) break;
        start += entryBlocks.length;
      }
    } catch (err) {
      console.error(`  [arxiv] ${cat}: ${err}`);
    }
  }

  const papers = [...seen.values()].sort(
    (a, b) => new Date(b.published).getTime() - new Date(a.published).getTime(),
  );

  console.log(`  [arxiv] ${papers.length} papers (from ${seen.size} unique)`);
  return { papers, fetchSuccess: papers.length > 0 };
}
