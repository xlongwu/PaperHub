/**
 * LLM-based domain tag classification for blog articles.
 * Uses few-shot prompting with a predefined tag tree.
 */

import { callLlm } from "@/report";
import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Tag candidates
// ---------------------------------------------------------------------------

const DOMAIN_TAGS = [
  "Foundation Models",
  "LLM",
  "Agents",
  "RAG",
  "Prompt Engineering",
  "Safety & Alignment",
  "Multimodal",
  "Training & Fine-Tuning",
  "Inference & Deployment",
  "NLP",
  "Vision-Language",
  "Robotics",
  "Tools & Engineering",
  "Research",
];

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildTagPrompt(title: string, abstract: string): string {
  return `You are an AI research assistant. Given a blog article title and excerpt, classify it into the most relevant domain tags from the following list.

Available tags: ${DOMAIN_TAGS.join(", ")}

Rules:
1. Select 1-3 most relevant tags only.
2. Return ONLY a JSON array of tag strings, e.g., ["Agents", "Safety & Alignment"]
3. Do not include any explanation or markdown formatting.

Title: ${title}

Excerpt: ${abstract.slice(0, 800)}

Tags:`;
}

// ---------------------------------------------------------------------------
// Cache (in-memory, per-process)
// ---------------------------------------------------------------------------

const tagCache = new Map<string, string[]>();

function cacheKey(title: string, abstract: string): string {
  return `${title.slice(0, 50)}:${abstract.slice(0, 100)}`;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export async function classifyBlogTags(title: string, abstract: string): Promise<string[]> {
  const key = cacheKey(title, abstract);
  const cached = tagCache.get(key);
  if (cached) return cached;

  try {
    const prompt = buildTagPrompt(title, abstract);
    const response = await callLlm(prompt, 1024);

    const tags = parseTagResponse(response);
    tagCache.set(key, tags);
    return tags;
  } catch (err) {
    console.error(`[tagger/llm] Classification failed: ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseTagResponse(response: string): string[] {
  // Try to extract JSON array
  const jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        const validTags = parsed
          .filter((t): t is string => typeof t === "string")
          .filter((t) => DOMAIN_TAGS.includes(t));
        return validTags;
      }
    } catch {
      // Fall through to line parsing
    }
  }

  // Fallback: parse line-by-line
  return response
    .split(/\n|,/)
    .map((s) =>
      s
        .trim()
        .replace(/^[-*\d.\s]+/, "")
        .replace(/["']/g, ""),
    )
    .filter((s) => s.length > 0 && DOMAIN_TAGS.includes(s));
}

// ---------------------------------------------------------------------------
// Batch classifier for documents
// ---------------------------------------------------------------------------

export async function classifyDocument(
  doc: Document,
): Promise<{ domainTags: string[]; modelTags: string[] }> {
  const domainTags = await classifyBlogTags(doc.title, doc.abstract);
  return { domainTags, modelTags: [] }; // modelTags extracted separately
}
