import type { Document } from "@/types";
import type { EmbeddingRuntime } from "./types";

export function buildDocumentEmbeddingText(
  document: Document,
  maxInputChars = resolveMaxInputChars(),
): string {
  const sections = [
    ["Title", document.title],
    ["Abstract", document.abstract],
    ["Summary Zh", document.summaryZh],
    ["Summary En", document.summaryEn],
    ["Domain Tags", document.domainTags.join(", ")],
    ["Model Tags", document.modelTags.join(", ")],
  ] as const;

  let result = "";
  for (const [label, value] of sections) {
    if (!value) continue;
    result = appendWithinLimit(result, `${label}: ${value.trim()}`, maxInputChars);
    if (result.length >= maxInputChars) return result;
  }

  if (document.fullText) {
    result = appendWithinLimit(result, `Full Text: ${document.fullText.trim()}`, maxInputChars);
  }
  return result;
}

export function buildDocumentEmbeddingTextForRuntime(document: Document, runtime: EmbeddingRuntime): string {
  return buildDocumentEmbeddingText(document, runtime.maxInputChars);
}

function appendWithinLimit(current: string, value: string, limit: number): string {
  const separator = current ? "\n" : "";
  const remaining = limit - current.length - separator.length;
  if (remaining <= 0) return current;
  return current + separator + value.slice(0, remaining);
}

function resolveMaxInputChars(): number {
  const configured = Number(process.env["EMBEDDING_MAX_INPUT_CHARS"] ?? 24_000);
  return Number.isSafeInteger(configured) && configured >= 1_000 ? configured : 24_000;
}
