/**
 * PaperHub search engine — v2.
 *
 * 5-path recall → RRF fusion → feature re-ranking → stable pagination.
 * Activated via PAPERHUB_SEARCH_ENGINE=v2.
 */

import {
  searchFts5Exact,
  searchFts5Strict,
  searchFts5Broad,
  searchCjkNgram,
  searchVectorAdaptive,
  matchesSearchFilters,
  hasIndexedSearchTag,
  type RecallOptions,
} from "@/db/search";
import { analyzeSearchQuery, type SearchQueryAnalysis } from "@/search-query";
import { reciprocalRankFusion } from "@/search-fusion";
import type { Document } from "@/types";

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
  dateRange?: { start: string; end: string };
}

export interface SearchResultV2 {
  document: Document;
  score: number;
  matchReason: string;
  snippet?: string;
}

export interface SearchResponseV2 {
  results: SearchResultV2[];
  returned: number;
  candidateTotal: number;
  hasMore: boolean;
  nextOffset?: number;
  nextCursor?: string;
  modeUsed: "keyword" | "semantic" | "hybrid" | "keyword_fallback";
  degraded?: boolean;
  reason?: string;
  analysis?: {
    language: string;
    concepts: string[];
    pattern: string;
  };
  appliedTags?: string[];
  topicTerms?: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function hybridSearchV2(options: SearchOptions): Promise<SearchResponseV2> {
  const originalQuery = options.query.trim();
  if (!originalQuery) {
    return { results: [], returned: 0, candidateTotal: 0, hasMore: false, modeUsed: "keyword" };
  }

  const limit = Math.min(options.limit ?? 12, 100);
  const cursorOffset = options.cursor ? decodeCursor(options.cursor, originalQuery) : undefined;
  const offset = Math.max(cursorOffset ?? options.offset ?? 0, 0);
  const mode = options.mode ?? "hybrid";
  const { appliedTags, topicTerms } = resolveTagInputs(options.tags);
  const query = appendTopicTerms(originalQuery, topicTerms);

  // 1. Query analysis
  const analysis = analyzeSearchQuery(query);

  // 2. Build recall options
  const recallOptions: RecallOptions = {
    limit: Math.min(limit * 4, 300),
    sources: options.sources,
    tags: appliedTags,
    tagMatchMode: options.tagMatchMode,
    dateRange: options.dateRange,
  };

  // 3. Multi-path recall (parallel where possible)
  const rankedLists = new Map<string, Awaited<ReturnType<typeof searchFts5Strict>>>();

  if (mode !== "semantic") {
    rankedLists.set("exact", searchFts5Exact(analysis.exactTitleQuery, { ...recallOptions, limit: 50 }));
  }

  // Path 2: Strict FTS (keyword + hybrid mode)
  if (mode !== "semantic") {
    rankedLists.set("strict", searchFts5Strict(analysis.strictFtsQuery, { ...recallOptions, limit: 100 }));
  }

  // Path 3: Broad FTS (keyword + hybrid mode, using wide query)
  if (mode !== "semantic") {
    rankedLists.set("broad", searchFts5Broad(analysis.broadFtsQuery, { ...recallOptions, limit: 300 }));
  }

  // Path 4: CJK n-gram (if query has CJK characters)
  if (mode !== "semantic" && analysis.cjkNgrams && analysis.cjkNgrams.length > 0) {
    rankedLists.set("cjk", searchCjkNgram(analysis.cjkNgrams, { ...recallOptions, limit: 150 }));
  }

  // Path 5: Vector semantic recall (semantic + hybrid mode)
  let modeUsed: SearchResponseV2["modeUsed"] =
    mode === "semantic" ? "semantic" : mode === "hybrid" ? "keyword_fallback" : "keyword";
  let degraded = false;
  let degradedReason: string | undefined;
  if (mode === "semantic" || mode === "hybrid") {
    try {
      const vectorResults = await searchVectorAdaptive(query, {
        ...recallOptions,
        limit: Math.min(limit * 4, 300),
        threshold: mode === "semantic" ? 0.5 : 0.58,
      });
      if (vectorResults.length > 0) {
        rankedLists.set("vector", vectorResults);
        modeUsed = mode === "semantic" ? "semantic" : "hybrid";
      } else {
        modeUsed = mode === "semantic" ? "semantic" : "keyword_fallback";
        degraded = true;
        degradedReason = "embedding_index_empty";
      }
    } catch (error) {
      modeUsed = mode === "semantic" ? "semantic" : "keyword_fallback";
      degraded = true;
      degradedReason = error instanceof Error ? error.message : "embedding_unavailable";
    }
  }

  // 4. RRF fusion
  const snippets = new Map<string, string>();
  for (const candidates of rankedLists.values()) {
    for (const candidate of candidates) {
      if (candidate.snippet && !snippets.has(candidate.document.id)) {
        snippets.set(candidate.document.id, candidate.snippet);
      }
    }
  }
  const fused = reciprocalRankFusion(rankedLists, analysis).filter((candidate) =>
    matchesSearchFilters(candidate.document, recallOptions),
  );

  // 5. Pagination (cursor-style stable page)
  const page = fused.slice(offset, offset + limit);

  // 6. Build response
  const results: SearchResultV2[] = page.map((f) => ({
    document: f.document,
    score: f.finalScore,
    matchReason: f.matchReason,
    snippet: snippets.get(f.document.id) ?? buildSnippetV2(f.document, analysis),
  }));

  const candidateTotal = fused.length;
  const hasMore = offset + limit < candidateTotal;

  return {
    results,
    returned: results.length,
    candidateTotal,
    hasMore,
    nextOffset: hasMore ? offset + limit : undefined,
    nextCursor: hasMore ? encodeCursor(originalQuery, offset + limit) : undefined,
    modeUsed,
    degraded,
    reason: degradedReason,
    analysis: {
      language: analysis.language,
      concepts: analysis.concepts.map((c) => c.canonical),
      pattern: analysis.pattern,
    },
    appliedTags,
    topicTerms,
  };
}

function resolveTagInputs(tags?: string[]): {
  appliedTags: string[];
  topicTerms: string[];
} {
  const appliedTags: string[] = [];
  const topicTerms: string[] = [];

  for (const rawTag of tags ?? []) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (hasIndexedSearchTag(tag)) {
      appliedTags.push(tag);
    } else {
      topicTerms.push(tag);
    }
  }

  return { appliedTags, topicTerms };
}

function appendTopicTerms(query: string, topicTerms: string[]): string {
  const normalizedQuery = query.toLocaleLowerCase();
  const additions = topicTerms.filter((term) => !normalizedQuery.includes(term.toLocaleLowerCase()));
  return additions.length > 0 ? `${query} ${additions.join(" ")}` : query;
}

function encodeCursor(query: string, offset: number): string {
  return Buffer.from(JSON.stringify({ query, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, query: string): number | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      query?: unknown;
      offset?: unknown;
    };
    if (value.query !== query || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
      return undefined;
    }
    return Number(value.offset);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Zero-result auto-relaxation
// ---------------------------------------------------------------------------

/**
 * When the initial search returns zero results, try broader strategies.
 * Returns the best non-empty result set, or the original empty set.
 */
export async function relaxedSearch(
  options: SearchOptions & { maxRelaxations?: number },
): Promise<SearchResponseV2> {
  return hybridSearchV2(options);
}

// ---------------------------------------------------------------------------
// Snippet generation
// ---------------------------------------------------------------------------

function buildSnippetV2(document: Document, analysis: SearchQueryAnalysis): string {
  const terms = [...analysis.concepts.map((c) => c.canonical), ...analysis.terms];
  const source = document.abstract || document.title;

  // Simple keyword-based snippet: find first match and show context
  for (const term of terms) {
    const lowerSource = source.toLowerCase();
    const idx = lowerSource.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(source.length, idx + term.length + 60);
      let snippet = source.slice(start, end);
      if (start > 0) snippet = "…" + snippet;
      if (end < source.length) snippet = snippet + "…";
      return snippet;
    }
  }

  // Fallback: first 120 chars of abstract
  const abstract = document.abstract || "";
  return abstract.length > 120 ? abstract.slice(0, 120) + "…" : abstract;
}
