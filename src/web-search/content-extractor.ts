export interface ExtractedWebContent {
  title?: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  text: string;
}

const MAX_EXTRACTED_CHARS = 120_000;

export function extractHtmlContent(html: string, sourceUrl: string): ExtractedWebContent {
  const title =
    findMeta(html, "property", "og:title") ||
    findMeta(html, "name", "twitter:title") ||
    decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const author =
    findMeta(html, "name", "author") || findMeta(html, "property", "article:author") || undefined;
  const publishedAt =
    findMeta(html, "property", "article:published_time") ||
    findMeta(html, "name", "date") ||
    html.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1];
  const canonicalHref =
    html.match(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] ??
    html.match(/<link\b(?=[^>]*href=["']([^"']+)["'])[^>]*rel=["']canonical["'][^>]*>/i)?.[1];
  const canonicalUrl = canonicalHref ? safeAbsoluteUrl(decodeEntities(canonicalHref), sourceUrl) : undefined;
  const main =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|iframe|noscript|svg|canvas|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS);
  return {
    title: title || undefined,
    author,
    publishedAt: normalizeDate(publishedAt),
    canonicalUrl,
    text,
  };
}

function findMeta(html: string, key: "name" | "property", value: string): string | undefined {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*${key}=["']${escaped}["'])[^>]*content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b(?=[^>]*content=["']([^"']*)["'])[^>]*${key}=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1];
    if (value) return decodeEntities(value).trim();
  }
  return undefined;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function safeAbsoluteUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
