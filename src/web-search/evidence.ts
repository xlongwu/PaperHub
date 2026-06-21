import { createHash } from "node:crypto";
import type { EvidenceChunk, EvidenceType, WebSearchResult } from "./types";

const MAX_CHUNK_CHARS = 2_400;
const MAX_PAGE_CHUNKS = 3;

export function buildEvidenceChunks(
  result: WebSearchResult,
  pageText?: string,
  fetchedAt = new Date().toISOString(),
): EvidenceChunk[] {
  const chunks: EvidenceChunk[] = [];
  const providerId = result.providerEvidence[0]?.providerId ?? "unknown";
  addChunk(chunks, result, providerId, "abstract", result.abstract, fetchedAt);
  if (result.snippet && result.snippet.trim() !== result.abstract?.trim()) {
    addChunk(chunks, result, providerId, "provider_snippet", result.snippet, fetchedAt);
  }
  addChunk(
    chunks,
    result,
    providerId,
    "metadata",
    [
      `Title: ${result.title}`,
      result.authors.length ? `Authors: ${result.authors.join(", ")}` : "",
      result.publishedAt ? `Published: ${result.publishedAt}` : "",
      result.origin.venue ? `Venue: ${result.origin.venue}` : "",
      result.identifiers.doi ? `DOI: ${result.identifiers.doi}` : "",
      result.identifiers.arxivId ? `arXiv: ${result.identifiers.arxivId}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    fetchedAt,
  );
  if (pageText?.trim()) {
    for (const excerpt of selectPageExcerpts(pageText).slice(0, MAX_PAGE_CHUNKS)) {
      addChunk(chunks, result, providerId, "page_excerpt", excerpt, fetchedAt);
    }
  }
  return chunks;
}

function addChunk(
  chunks: EvidenceChunk[],
  result: WebSearchResult,
  providerId: string,
  evidenceType: EvidenceType,
  rawText: string | undefined,
  fetchedAt: string,
): void {
  const text = rawText?.replace(/\s+/g, " ").trim().slice(0, MAX_CHUNK_CHARS);
  if (!text) return;
  const contentHash = createHash("sha256").update(text).digest("hex");
  if (chunks.some((chunk) => chunk.contentHash === contentHash)) return;
  chunks.push({
    id: `ev_${createHash("sha256")
      .update(`${result.id}:${evidenceType}:${contentHash}`)
      .digest("hex")
      .slice(0, 24)}`,
    resultId: result.id,
    title: result.title,
    url: result.url,
    text,
    providerId,
    evidenceType,
    fetchedAt,
    contentHash,
  });
}

function selectPageExcerpts(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?。！？])\s+(?=[A-Z\u4e00-\u9fff])/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 40)
    .reduce<string[]>((groups, part) => {
      const last = groups.at(-1);
      if (last && last.length + part.length < MAX_CHUNK_CHARS) {
        groups[groups.length - 1] = `${last} ${part}`;
      } else {
        groups.push(part.slice(0, MAX_CHUNK_CHARS));
      }
      return groups;
    }, []);
}
