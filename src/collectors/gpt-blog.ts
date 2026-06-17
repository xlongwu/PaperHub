/**
 * GPT Blog collector — fetches OpenAI blog via RSS feed.
 */

import { fetchRssFeed, type RssItem } from "@/utils/rss";
import type { RawDocument, ContentCollector } from "@/collectors/types";
import { documentExists } from "@/db/documents";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RSS_URL = "https://openai.com/news/rss.xml";
const MAX_CONTENT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export const gptBlogCollector: ContentCollector = {
  id: "gpt_blog",
  name: "OpenAI Blog",
  sourceTag: "GPT Blog",
  interval: 30 * 60 * 1000, // 30 minutes

  async fetch(): Promise<RawDocument[]> {
    console.log("[collector/gpt-blog] Fetching RSS feed...");

    let items: RssItem[];
    try {
      items = await fetchRssFeed(RSS_URL);
    } catch (err) {
      console.error(`[collector/gpt-blog] RSS fetch failed: ${err}`);
      // Fallback: try alternative URL
      try {
        items = await fetchRssFeed("https://openai.com/blog/rss.xml");
      } catch (fallbackErr) {
        console.error(`[collector/gpt-blog] Fallback RSS also failed: ${fallbackErr}`);
        return [];
      }
    }

    console.log(`[collector/gpt-blog] ${items.length} items from RSS.`);

    const results: RawDocument[] = [];
    for (const item of items) {
      if (documentExists(item.link)) {
        continue;
      }

      const raw = mapRssItem(item);
      results.push(raw);
    }

    console.log(`[collector/gpt-blog] ${results.length} new articles after dedup.`);
    return results;
  },
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapRssItem(item: RssItem): RawDocument {
  const content = item.content || item.description || "";
  const abstract = content.slice(0, MAX_CONTENT_LENGTH);

  return {
    title: item.title,
    source: "gpt_blog",
    url: item.link,
    publishedAt: item.pubDate,
    authors: [], // RSS typically doesn't include authors
    abstract,
    content: content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : undefined,
    language: "en",
    metadata: {
      categories: item.categories,
    },
  };
}
