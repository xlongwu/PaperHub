/**
 * ArXiv collector — wraps the legacy arxiv.ts implementation into ContentCollector interface.
 */

import { fetchArxivData, type ArxivPaper } from "@/arxiv";
import type { RawDocument, ContentCollector } from "@/collectors/types";
import { documentExists } from "@/db/documents";

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export const arxivCollector: ContentCollector = {
  id: "arxiv",
  name: "arXiv AI Papers",
  sourceTag: "arXiv",
  interval: 6 * 60 * 60 * 1000, // 6 hours in ms

  async fetch(): Promise<RawDocument[]> {
    console.log("[collector/arxiv] Fetching papers...");
    // Scheduler fetches last 48h to avoid ArXiv's ~1-day publishing delay
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const data = await fetchArxivData({ fromDate: twoDaysAgo });

    if (!data.fetchSuccess || data.papers.length === 0) {
      console.log("[collector/arxiv] No papers fetched.");
      return [];
    }

    const results: RawDocument[] = [];
    for (const paper of data.papers) {
      // Skip if already exists by URL
      if (documentExists(paper.url)) {
        continue;
      }

      results.push(mapArxivPaper(paper));
    }

    console.log(`[collector/arxiv] ${results.length} new papers after dedup.`);
    return results;
  },
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapArxivPaper(paper: ArxivPaper): RawDocument {
  return {
    title: paper.title,
    source: "arxiv",
    url: paper.url,
    publishedAt: paper.published,
    authors: paper.authors,
    abstract: paper.summary,
    language: "en",
    metadata: {
      categories: paper.categories,
      pdfUrl: paper.pdfUrl,
      updated: paper.updated,
    },
  };
}
