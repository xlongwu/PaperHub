/**
 * Search orchestration layer — hybrid search combining FTS5 + vector.
 */

import { searchFts5, searchVector, matchesSearchFilters, type SearchResult } from "@/db/search";
import { callLlm } from "@/report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HybridSearchOptions {
  query: string;
  mode?: "keyword" | "semantic" | "hybrid";
  limit?: number;
  offset?: number;
  sources?: string[];
  tags?: string[];
  dateRange?: { start: string; end: string };
}

export interface HybridSearchResponse {
  results: SearchResult[];
  total: number;
  mode: string;
  report?: string;
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResponse> {
  const mode = options.mode ?? "hybrid";
  const limit = Math.min(options.limit ?? 20, 100);
  const offset = options.offset ?? 0;
  const candidateLimit = Math.min(1000, Math.max(offset + limit, limit * 5, 100));

  let ftsResults: SearchResult[] = [];
  let vecResults: SearchResult[] = [];

  // Parallel execution
  if (mode === "keyword" || mode === "hybrid") {
    ftsResults = searchFts5({
      query: options.query,
      limit: candidateLimit,
      sources: options.sources,
      tags: options.tags,
      dateRange: options.dateRange,
    });
  }

  if (mode === "semantic" || mode === "hybrid") {
    try {
      vecResults = await searchVector({
        query: options.query,
        limit: candidateLimit,
        threshold: 0.5, // aligned with searchVector default
        sources: options.sources,
        tags: options.tags,
        dateRange: options.dateRange,
      });
    } catch (e) {
      console.error("[search] Vector search failed:", e);
      // Continue with FTS only
    }
  }

  // Merge and deduplicate
  const merged = mergeResults(ftsResults, vecResults, mode);

  // Apply a final defensive filter — delegates to the shared, single-source
  // predicate in db/search.ts so both branches stay in lockstep.
  const filtered = merged.filter((result) =>
    matchesSearchFilters(result.document, {
      sources: options.sources,
      tags: options.tags,
      dateRange: options.dateRange,
    }),
  );

  // Total before pagination
  const total = filtered.length;

  // Pagination
  const page = filtered.slice(offset, offset + limit);

  // Generate report if many results
  let report: string | undefined;
  if (page.length > 10 && mode === "hybrid") {
    report = await generateSearchReport(page.slice(0, 10), options.query);
  }

  return { results: page, total, mode, report };
}

// ---------------------------------------------------------------------------
// Merge & rank
// ---------------------------------------------------------------------------

function mergeResults(fts: SearchResult[], vec: SearchResult[], mode: string): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  // FTS scores are already normalized to [0,1]
  for (const r of fts) {
    seen.set(r.document.id, { ...r, score: r.score * (mode === "hybrid" ? 0.6 : 1.0) });
  }

  // Vector scores are cosine similarity [0,1]
  for (const r of vec) {
    const existing = seen.get(r.document.id);
    if (existing) {
      // Combine scores
      existing.score = existing.score + r.score * (mode === "hybrid" ? 0.4 : 1.0);
    } else {
      seen.set(r.document.id, { ...r, score: r.score * (mode === "hybrid" ? 0.4 : 1.0) });
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// LLM report generation
// ---------------------------------------------------------------------------

async function generateSearchReport(results: SearchResult[], query: string): Promise<string> {
  const summaries = results
    .map((r, i) => `${i + 1}. ${r.document.title}\n   ${r.document.abstract.slice(0, 200)}...\n   来源: ${r.document.sourceTag}`)
    .join("\n\n");

  const prompt = `用户搜索主题: "${query}"

找到以下相关文档:

${summaries}

请用中文生成一段 200-300 字的综述摘要，概括这些文档的核心内容和共同主题。不要编造文档中未提及的信息。`;

  try {
    const report = await callLlm(prompt, 2048);
    // If the call succeeded but returned empty text, treat as failure
    if (!report || report.trim().length === 0) {
      throw new Error("Empty response from LLM");
    }
    return report;
  } catch (e) {
    console.error("[search] Report generation failed:", e);
    return "Summary generation failed. You can still browse individual results below.\n综述生成失败，您仍可浏览下方的各项结果。";
  }
}
