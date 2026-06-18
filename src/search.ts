/**
 * Search orchestration layer — hybrid search combining FTS5 + vector.
 */

import { searchFts5, searchVector, matchesSearchFilters, type SearchResult } from "@/db/search";
import { callLlm } from "@/report";
import { analyzeSearchQuery, scoreDocumentAgainstQuery } from "@/search-query";

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
        threshold: mode === "hybrid" ? 0.58 : 0.5,
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
  const merged = mergeResults(ftsResults, vecResults, mode, options.query);

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

function mergeResults(fts: SearchResult[], vec: SearchResult[], mode: string, query: string): SearchResult[] {
  if (mode === "keyword") return [...fts].sort((a, b) => b.score - a.score);
  if (mode === "semantic") return [...vec].sort((a, b) => b.score - a.score);

  const analysis = analyzeSearchQuery(query);
  const ftsById = new Map(fts.map((result) => [result.document.id, result]));
  const vecById = new Map(vec.map((result) => [result.document.id, result]));
  const documentIds = new Set([...ftsById.keys(), ...vecById.keys()]);
  const merged: SearchResult[] = [];

  for (const documentId of documentIds) {
    const keywordResult = ftsById.get(documentId);
    const vectorResult = vecById.get(documentId);
    const base = keywordResult ?? vectorResult;
    if (!base) continue;

    const lexical = scoreDocumentAgainstQuery(base.document, analysis);
    if (
      !keywordResult &&
      analysis.concepts.length > 1 &&
      lexical.matchedConcepts < analysis.minimumHybridMatches
    ) {
      continue;
    }

    const keywordScore = keywordResult?.score ?? 0;
    const vectorScore = vectorResult?.score ?? 0;
    const overlapBonus = keywordResult && vectorResult ? 0.08 : 0;
    const score = Math.min(1, keywordScore * 0.52 + vectorScore * 0.28 + lexical.score * 0.2 + overlapBonus);

    merged.push({
      ...base,
      score,
      matchType: keywordResult && vectorResult ? "hybrid" : base.matchType,
      snippet: keywordResult?.snippet ?? base.snippet,
    });
  }

  return merged.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// LLM report generation
// ---------------------------------------------------------------------------

async function generateSearchReport(results: SearchResult[], query: string): Promise<string> {
  const summaries = results
    .map(
      (r, i) =>
        `${i + 1}. ${r.document.title}\n   ${r.document.abstract.slice(0, 200)}...\n   来源: ${r.document.sourceTag}`,
    )
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
