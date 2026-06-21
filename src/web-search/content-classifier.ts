import type { WebSearchContentType } from "./types";

const OFFICIAL_DOMAINS = new Set([
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "ai.google",
  "huggingface.co",
  "microsoft.com",
  "meta.com",
]);

export function classifyWebContent(
  urlValue: string,
  title: string,
  explicitType?: string,
): WebSearchContentType | "other" {
  const url = safeUrl(urlValue);
  const domain = url?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
  const path = url?.pathname.toLowerCase() ?? "";
  const text = `${title} ${explicitType ?? ""}`.toLowerCase();

  if (domain === "github.com" || domain === "gitlab.com" || /\brepositor(?:y|ies)\b/.test(text)) {
    return "repository";
  }
  if (
    /(^|\.)(docs?|developer|developers)\./.test(domain) ||
    /\/docs?(?:\/|$)|\/documentation(?:\/|$)|\b(api reference|documentation)\b/.test(`${path} ${text}`)
  ) {
    return "documentation";
  }
  if (
    [...OFFICIAL_DOMAINS].some((official) => domain === official || domain.endsWith(`.${official}`)) &&
    (/\/(blog|news|research)(?:\/|$)/.test(path) ||
      /\b(blog|announcement|release notes?|product update)\b/.test(text))
  ) {
    return "official_blog";
  }
  if (
    domain === "arxiv.org" ||
    domain === "doi.org" ||
    /\b(paper|preprint|proceedings|journal)\b/.test(text)
  ) {
    return "paper";
  }
  return "technical_article";
}

export function normalizeDomain(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return "";
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return candidate.replace(/^www\./, "").replace(/\/.*$/, "");
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
