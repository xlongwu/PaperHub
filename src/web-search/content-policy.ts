export const WEB_CONTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_PREVIEW_MAX_CHARS = 600;
export const MAX_METADATA_EXPORT_ITEMS = 500;

export type WebContentPolicyReason = "content_allowed" | "paywall_detected" | "empty_content";

export interface WebContentPolicyDecision {
  allowFullText: boolean;
  reason: WebContentPolicyReason;
}

export function assessWebContent(html: string, text: string): WebContentPolicyDecision {
  if (!text.trim()) return { allowFullText: false, reason: "empty_content" };
  const combined = `${html.slice(0, 20_000)} ${text.slice(0, 20_000)}`.toLowerCase();
  const paywalled = [
    "subscribe to continue",
    "purchase access",
    "institutional access",
    "log in to access",
    "login to access",
    "paywall",
    "article access",
    "rent this article",
  ].some((needle) => combined.includes(needle));
  return paywalled
    ? { allowFullText: false, reason: "paywall_detected" }
    : { allowFullText: true, reason: "content_allowed" };
}

export function evidencePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= EVIDENCE_PREVIEW_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, EVIDENCE_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

export function assertWebExportAllowed(input: { itemCount: number; includeFullText?: boolean }): void {
  if (!Number.isInteger(input.itemCount) || input.itemCount < 1) {
    throw new Error("Export item count must be a positive integer.");
  }
  if (input.includeFullText) {
    throw new Error(
      "Batch export of fetched full text is not allowed; export metadata and source URLs only.",
    );
  }
  if (input.itemCount > MAX_METADATA_EXPORT_ITEMS) {
    throw new Error(`Metadata export is limited to ${MAX_METADATA_EXPORT_ITEMS} items per operation.`);
  }
}
