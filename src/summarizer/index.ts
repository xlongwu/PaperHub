/**
 * Summarizer pipeline — generates LLM summaries for documents.
 */

import { callLlm } from "@/report";
import { buildSummaryPrompt } from "./prompt";
import { updateDocument } from "@/db/documents";
import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Single document summarization
// ---------------------------------------------------------------------------

export async function summarizeDocument(doc: Document, lang: "zh" | "en" = "zh"): Promise<string> {
  if (doc.isSummarized) {
    const existing = lang === "zh" ? doc.summaryZh : doc.summaryEn;
    if (existing) return existing;
  }

  const prompt = buildSummaryPrompt(doc, lang);
  const summary = await callLlm(prompt, 2048);

  // Store result
  const updates: Partial<Document> = {};
  if (lang === "zh") {
    updates.summaryZh = summary;
  } else {
    updates.summaryEn = summary;
  }
  updates.isSummarized = true;
  updateDocument(doc.id, updates);

  return summary;
}

// ---------------------------------------------------------------------------
// Batch summarization with concurrency control
// ---------------------------------------------------------------------------

export async function summarizeBatch(
  docs: Document[],
  lang: "zh" | "en" = "zh",
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const pending = docs.filter((d) => !d.isSummarized);
  const total = pending.length;

  if (total === 0) {
    console.log("[summarizer] No pending documents to summarize.");
    return;
  }

  console.log(`[summarizer] Summarizing ${total} documents...`);
  let done = 0;

  // Process with limited concurrency (reusing report.ts LLM_CONCURRENCY)
  const concurrency = 3;
  const queue = [...pending];

  // Per-document timeout to prevent a hanging LLM call from starving the
  // worker pool.  If summarizeDocument hangs (network partition, unresponsive
  // endpoint), the worker progresses to the next document after 90 s.
  const DOCUMENT_TIMEOUT_MS = 90_000;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const doc = queue.shift()!;
      try {
        await Promise.race([
          summarizeDocument(doc, lang),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: ${doc.id}`)), DOCUMENT_TIMEOUT_MS),
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
