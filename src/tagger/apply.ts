import type { Document, RawDocument } from "@/types";
import { mapArxivCategories } from "@/tagger/arxiv-mapping";
import { classifyBlogTags } from "@/tagger/llm-classify";
import { extractModelTags } from "@/tagger/model-extract";

export async function applyDocumentTags(doc: Document, raw: Pick<RawDocument, "metadata">): Promise<void> {
  if (doc.source === "arxiv" && Array.isArray(raw.metadata?.categories)) {
    doc.domainTags = mapArxivCategories(raw.metadata.categories as string[]);
  }

  if (
    doc.source === "gpt_blog" ||
    doc.source === "claude_blog" ||
    doc.source === "web"
  ) {
    doc.domainTags = await classifyBlogTags(doc.title, doc.abstract);
  }

  doc.modelTags = extractModelTags(`${doc.title} ${doc.abstract}`);
}
