/**
 * RSS/Atom feed parser — lightweight, no external XML dependency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  content?: string;
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  let content = m[1]!.trim();
  // Handle CDATA
  content = content.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return content;
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]!.trim());
  }
  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// RSS 2.0 parser
// ---------------------------------------------------------------------------

function parseRss20(xml: string): RssItem[] {
  const items = extractAllTags(xml, "item");
  return items.map((itemXml) => {
    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const pubDate = extractTag(itemXml, "pubDate");
    const description = stripHtml(extractTag(itemXml, "description"));
    const content = stripHtml(extractTag(itemXml, "content:encoded"));
    const categoryTags = extractAllTags(itemXml, "category");

    return {
      title,
      link,
      pubDate: parseDate(pubDate),
      description,
      content: content || description,
      categories: categoryTags.length > 0 ? categoryTags : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Atom parser
// ---------------------------------------------------------------------------

function parseAtom(xml: string): RssItem[] {
  const entries = extractAllTags(xml, "entry");
  return entries.map((entryXml) => {
    const title = extractTag(entryXml, "title");
    const linkMatch = entryXml.match(/<link[^>]+href="([^"]+)"[^>]*>/i);
    const link = linkMatch ? linkMatch[1]! : "";
    const pubDate = extractTag(entryXml, "updated") || extractTag(entryXml, "published");
    const summary = stripHtml(extractTag(entryXml, "summary"));
    const content = stripHtml(extractTag(entryXml, "content"));
    const categoryTags = extractAllTags(entryXml, "category");

    return {
      title,
      link,
      pubDate: parseDate(pubDate),
      description: summary || content,
      content: content || summary,
      categories: categoryTags.length > 0 ? categoryTags : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function parseRss(xml: string): RssItem[] {
  if (/<feed\b/i.test(xml) && /<entry\b/i.test(xml)) {
    return parseAtom(xml);
  }
  return parseRss20(xml);
}

export async function fetchRssFeed(url: string): Promise<RssItem[]> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "PaperHub/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });

  if (!resp.ok) {
    throw new Error(`RSS fetch failed: HTTP ${resp.status}`);
  }

  const xml = await resp.text();
  return parseRss(xml);
}
