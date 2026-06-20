/**
 * Summarizer pipeline: direct template summarization for normal documents and
 * section-aware map/reduce extraction for long full text.
 */

import { callLlm } from "@/report";
import {
  buildChunkExtractionPrompt,
  buildEvidenceMergePrompt,
  buildSummaryPrompt,
} from "./prompt";
import { chunkPaperContent, packEvidenceNotes } from "./chunking";
import { updateDocument } from "@/db/documents";
import { getUserPreference } from "@/db/user";
import type {
  Document,
  DocumentLanguage,
  SummaryLevel,
} from "@/types";

const DIRECT_CONTENT_CHAR_LIMIT = 32_000;
const EVIDENCE_MERGE_CHAR_LIMIT = 24_000;
const SHORT_OUTPUT_TOKENS = 1_800;
const DETAILED_OUTPUT_TOKENS = 6_000;
const SHORT_EXTRACTION_TOKENS = 1_200;
const DETAILED_EXTRACTION_TOKENS = 2_000;
const SHORT_DOCUMENT_TIMEOUT_MS = 180_000;
const DETAILED_DOCUMENT_TIMEOUT_MS = 600_000;

export interface SummarizeOptions {
  summaryLevel?: SummaryLevel;
  readerProfile?: string;
  focusTopics?: string[];
}

export function getConfiguredSummaryLevel(): SummaryLevel {
  try {
    return getUserPreference("summary_length") === "detailed"
      ? "detailed"
      : "short";
  } catch {
    return "short";
  }
}

export function getConfiguredSummaryLanguage(): DocumentLanguage {
  try {
    return getUserPreference("default_language") === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function getConfiguredFocusTopics(): string[] {
  try {
    const raw = getUserPreference("interest_tags");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function needsSummary(
  doc: Document,
  lang: DocumentLanguage,
  summaryLevel: SummaryLevel,
): boolean {
  const summary = lang === "zh" ? doc.summaryZh : doc.summaryEn;
  const storedLevel =
    lang === "zh" ? doc.summaryZhLevel : doc.summaryEnLevel;
  return !summary || storedLevel !== summaryLevel;
}

export async function summarizeDocument(
  doc: Document,
  lang: DocumentLanguage = "zh",
  options: SummarizeOptions = {},
): Promise<string> {
  const summaryLevel = options.summaryLevel ?? getConfiguredSummaryLevel();
  const existing = lang === "zh" ? doc.summaryZh : doc.summaryEn;
  if (!needsSummary(doc, lang, summaryLevel) && existing) {
    return existing;
  }

  const fullText = doc.fullText?.trim();
  const content = fullText || doc.abstract || "";
  const inputScope = fullText ? "full_text" : "abstract_only";
  const focusTopics = options.focusTopics ?? getConfiguredFocusTopics();
  const maxTokens =
    summaryLevel === "detailed"
      ? DETAILED_OUTPUT_TOKENS
      : SHORT_OUTPUT_TOKENS;

  let finalContent = content;
  let processingNote: string | undefined;

  if (fullText && fullText.length > DIRECT_CONTENT_CHAR_LIMIT) {
    finalContent = await extractLongDocumentEvidence(
      doc,
      fullText,
      lang,
      summaryLevel,
    );
    processingNote =
      lang === "zh"
        ? "PaperHub 处理说明：以下内容是覆盖完整正文全部分块后形成的结构化证据笔记。原文未被直接截断；最终总结应视为基于全文，但具体表述必须受证据笔记约束。"
        : "PaperHub processing note: the content below is structured evidence extracted from every chunk of the complete full text. The source was not directly truncated; treat the final summary as full-text based and remain bounded by these notes.";
  }

  const prompt = buildSummaryPrompt(doc, {
    lang,
    summaryLevel,
    content: finalContent,
    inputScope,
    readerProfile: options.readerProfile,
    focusTopics,
    processingNote,
  });
  const summary = await callLlm(prompt, maxTokens);

  const updates: Partial<Document> = { isSummarized: true };
  if (lang === "zh") {
    updates.summaryZh = summary;
    updates.summaryZhLevel = summaryLevel;
  } else {
    updates.summaryEn = summary;
    updates.summaryEnLevel = summaryLevel;
  }
  updateDocument(doc.id, updates);

  return summary;
}

export async function summarizeBatch(
  docs: Document[],
  lang: DocumentLanguage = "zh",
  onProgress?: (done: number, total: number) => void,
  options: SummarizeOptions = {},
): Promise<void> {
  const summaryLevel = options.summaryLevel ?? getConfiguredSummaryLevel();
  const focusTopics = options.focusTopics ?? getConfiguredFocusTopics();
  const pending = docs.filter((doc) => needsSummary(doc, lang, summaryLevel));
  const total = pending.length;

  if (total === 0) {
    console.log("[summarizer] No pending documents to summarize.");
    return;
  }

  console.log(
    `[summarizer] Summarizing ${total} documents at ${summaryLevel} level...`,
  );
  let done = 0;
  const concurrency = 3;
  const queue = [...pending];
  const timeoutMs =
    summaryLevel === "detailed"
      ? DETAILED_DOCUMENT_TIMEOUT_MS
      : SHORT_DOCUMENT_TIMEOUT_MS;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const doc = queue.shift()!;
      try {
        await Promise.race([
          summarizeDocument(doc, lang, {
            ...options,
            summaryLevel,
            focusTopics,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout: ${doc.id}`)),
              timeoutMs,
            ),
          ),
        ]);
        done++;
        onProgress?.(done, total);
      } catch (err) {
        console.error(`[summarizer] Failed for ${doc.id}: ${err}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[summarizer] Done: ${done}/${total} documents summarized.`);
}

async function extractLongDocumentEvidence(
  doc: Document,
  content: string,
  lang: DocumentLanguage,
  summaryLevel: SummaryLevel,
): Promise<string> {
  const chunks = chunkPaperContent(content);
  const extractionTokens =
    summaryLevel === "detailed"
      ? DETAILED_EXTRACTION_TOKENS
      : SHORT_EXTRACTION_TOKENS;
  let notes = await mapWithConcurrency(chunks, 3, (chunk, index) =>
    callLlm(
      buildChunkExtractionPrompt({
        doc,
        lang,
        summaryLevel,
        chunk: chunk.content,
        chunkIndex: index,
        chunkCount: chunks.length,
        sectionLabel: chunk.sectionLabel,
      }),
      extractionTokens,
    ),
  );

  let mergeRounds = 0;
  while (notes.join("\n\n").length > EVIDENCE_MERGE_CHAR_LIMIT) {
    mergeRounds++;
    if (mergeRounds > 6) {
      throw new Error(
        `Long-document evidence could not be compressed safely for ${doc.id}`,
      );
    }
    const groups = packEvidenceNotes(notes, EVIDENCE_MERGE_CHAR_LIMIT);
    notes = await mapWithConcurrency(groups, 3, (group, index) =>
      callLlm(
        buildEvidenceMergePrompt({
          doc,
          lang,
          summaryLevel,
          notes: group,
          batchIndex: index,
          batchCount: groups.length,
        }),
        extractionTokens,
      ),
    );
  }

  return notes.join("\n\n---\n\n");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}
