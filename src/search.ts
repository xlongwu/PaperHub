/**
 * Search orchestration layer — hybrid search combining FTS5 + vector.
 *
 * V2 engine (5-path recall + RRF fusion) is activated via
 * PAPERHUB_SEARCH_ENGINE=v2 or searchEngine="v2" in config.
 */

import { searchFts5, searchVector, matchesSearchFilters, type SearchResult } from "@/db/search";
import { callLlm } from "@/report";
import { analyzeSearchQuery, scoreDocumentAgainstQuery } from "@/search-query";
import type { SearchFallbackPolicy, SearchMatchExplanation, SearchQueryPlan } from "@/search-contract";
import type { SearchRerankerMetadata } from "@/search-reranker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  mode?: "keyword" | "semantic" | "hybrid";
  limit?: number;
  offset?: number;
  cursor?: string;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  fallbackPolicy?: SearchFallbackPolicy;
  dateRange?: { start: string; end: string };
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  mode: string;
  report?: string;
  /** V2 fields (populated when v2 engine is active) */
  hasMore?: boolean;
  candidateTotal?: number;
  modeUsed?: string;
  matchReasons?: string[];
  returned?: number;
  nextCursor?: string;
  appliedTags?: string[];
  topicTerms?: string[];
  explanations?: SearchMatchExplanation[];
  queryPlan?: SearchQueryPlan;
  reranker?: SearchRerankerMetadata;
  degraded?: boolean;
  reason?: string;
}
// ---------------------------------------------------------------------------

export interface HybridSearchOptions {
  query: string;
  mode?: "keyword" | "semantic" | "hybrid";
  limit?: number;
  offset?: number;
  cursor?: string;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  fallbackPolicy?: SearchFallbackPolicy;
  dateRange?: { start: string; end: string };
}

export interface HybridSearchResponse {
  results: SearchResult[];
  total: number;
  mode: string;
  report?: string;
  hasMore?: boolean;
  candidateTotal?: number;
  modeUsed?: string;
  matchReasons?: string[];
  returned?: number;
  nextCursor?: string;
  appliedTags?: string[];
  topicTerms?: string[];
  explanations?: SearchMatchExplanation[];
  queryPlan?: SearchQueryPlan;
  reranker?: SearchRerankerMetadata;
  degraded?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResponse> {
  // V2 engine switch: PAPERHUB_SEARCH_ENGINE=v2 activates the new pipeline
  const ENGINE = process.env["PAPERHUB_SEARCH_ENGINE"]?.trim() ?? "v2";
  if (ENGINE === "v2") {
    return hybridSearchV2Wrapper(options);
  }

  // ── V1 path (original implementation) ────────────────────────────
  const mode = options.mode ?? "hybrid";
  const limit = Math.min(options.limit ?? 20, 100);
  const offset = options.offset ?? 0;
  const candidateLimit = Math.min(1000, Math.max(offset + limit, limit * 5, 100));

  let ftsResults: SearchResult[] = [];
  let vecResults: SearchResult[] = [];
  let degradedReason: string | undefined;

  // Parallel execution
  if (mode === "keyword" || mode === "hybrid") {
    ftsResults = searchFts5({
      query: options.query,
      limit: candidateLimit,
      sources: options.sources,
      tags: options.tags,
      tagMatchMode: options.tagMatchMode,
      allTags: options.allTags,
      anyTags: options.anyTags,
      excludeTags: options.excludeTags,
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
        tagMatchMode: options.tagMatchMode,
        allTags: options.allTags,
        anyTags: options.anyTags,
        excludeTags: options.excludeTags,
        dateRange: options.dateRange,
      });
    } catch (e) {
      console.error("[search] Vector search failed:", e);
      degradedReason = e instanceof Error ? e.message : "embedding_unavailable";
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
      tagMatchMode: options.tagMatchMode,
      allTags: options.allTags,
      anyTags: options.anyTags,
      excludeTags: options.excludeTags,
      dateRange: options.dateRange,
    }),
  );

  // Total before pagination
  const total = filtered.length;

  // Pagination
  const page = filtered.slice(offset, offset + limit);

  // Report generation moved to POST /api/search/report — no blocking here.
  return {
    results: page,
    total,
    mode: degradedReason ? "keyword_fallback" : mode,
    degraded: Boolean(degradedReason),
    reason: degradedReason,
  };
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
    // No hard concept-hit floor for hybrid.  Concept coverage feeds into
    // the lexical score, which is part of the ranking formula — low-coverage
    // documents naturally score lower and sink to the bottom of the list.

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
// LLM report generation (exported for async /api/search/report endpoint)
// ---------------------------------------------------------------------------

export async function generateSearchReport(
  results: SearchResult[],
  query: string,
  maxTokens = 8_192,
): Promise<string> {
  const count = results.length;
  const catalog = results
    .slice(0, count)
    .map(
      (r, i) =>
        `${i + 1}. [${r.document.id}] ${r.document.title}\n   来源: ${r.document.sourceTag} | 发布: ${r.document.publishedAt?.slice(0, 10) ?? "未知"}\n   作者: ${(r.document.authors ?? []).slice(0, 5).join(", ")}${(r.document.authors ?? []).length > 5 ? " 等" : ""}\n   ${r.document.abstract?.slice(0, 400) ?? "无摘要"}`,
    )
    .join("\n\n");

  const prompt = `你是一位学术研究分析师。用户搜索主题: "${query}"

找到以下 ${count} 篇相关文档:

${catalog}

请用中文生成一份**按方法类型组织的深度研究综述报告**，结构如下：

1. **方法类型总览**：先用一个表格列出识别到的主要方法/技术类型，每行包含：方法类型、核心控制信号、主要目标、代表论文编号。
2. **各方法类型深度分析**（至少 2 个主要类型）：
   - 设计逻辑（为什么这种方法有效）
   - 方法论与具体流程（关键步骤）
   - 为什么有效（核心优势）
   - 实施中如何应用（工程建议）
3. **方法横向比较**：一个对比表，列维度包括：是否依赖种子、难度来源、正确性来源、诊断性、主要用途。
4. **核心结论**：3-5 条带引用编号的要点式结论。
5. **推荐的方法组合/实施建议**：3-5 条可操作建议。
6. **论文清单与链接**：按方法类型分组列出全部论文编号和标题。

要求：
- 不要逐篇复述摘要，要按方法族整合分析
- 每条结论引用论文编号，如 [1][3]
- 如果文档不足以分类，则按主题领域分组
- 控制在 2000 字以内
- 不要编造文档中未提及的信息`;

  try {
    const report = await callLlm(prompt, maxTokens);
    if (!report || report.trim().length === 0) {
      throw new Error("Empty response from LLM");
    }
    return report;
  } catch (e) {
    console.error("[search] Report generation failed:", e);
    return "Report generation failed. You can still browse individual results below.\n深度综述生成失败，您仍可浏览下方的各项结果。";
  }
}

// ---------------------------------------------------------------------------
// V2 engine wrapper — delegates to the 5-path recall + RRF pipeline
// ---------------------------------------------------------------------------

async function hybridSearchV2Wrapper(options: HybridSearchOptions): Promise<HybridSearchResponse> {
  const { relaxedSearch } = await import("@/search-v2");

  const v2Response = await relaxedSearch({
    query: options.query,
    mode: options.mode,
    limit: options.limit,
    offset: options.offset,
    cursor: options.cursor,
    sources: options.sources,
    tags: options.tags,
    tagMatchMode: options.tagMatchMode,
    allTags: options.allTags,
    anyTags: options.anyTags,
    excludeTags: options.excludeTags,
    mustConcepts: options.mustConcepts,
    shouldConcepts: options.shouldConcepts,
    excludeConcepts: options.excludeConcepts,
    fallbackPolicy: options.fallbackPolicy,
    dateRange: options.dateRange,
  });

  return {
    results: v2Response.results.map((r) => ({
      document: r.document,
      score: r.score,
      matchType: "hybrid",
      snippet: r.snippet,
      explanation: r.explanation,
    })),
    total: v2Response.candidateTotal,
    mode: v2Response.modeUsed,
    hasMore: v2Response.hasMore,
    candidateTotal: v2Response.candidateTotal,
    modeUsed: v2Response.modeUsed,
    matchReasons: v2Response.results.map((r) => r.matchReason),
    returned: v2Response.returned,
    nextCursor: v2Response.nextCursor,
    appliedTags: v2Response.appliedTags,
    topicTerms: v2Response.topicTerms,
    explanations: v2Response.results.map((r) => r.explanation),
    queryPlan: v2Response.queryPlan,
    reranker: v2Response.reranker,
    degraded: v2Response.degraded,
    reason: v2Response.reason,
  };
}
