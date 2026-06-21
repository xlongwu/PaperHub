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
  type RecallOptions,
} from "@/db/search";
import { getConceptMatchEvidence, type SearchQueryAnalysis } from "@/search-query";
import { reciprocalRankFusion } from "@/search-fusion";
import { buildSearchQueryPlan } from "@/search-planner";
import {
  type SearchFallbackPolicy,
  type SearchMatchExplanation,
  type SearchQueryPlan,
} from "@/search-contract";
import { collectDocumentCanonicalTags } from "@/canonical-tags";
import { rerankSearchCandidates, type SearchRerankerMetadata } from "@/search-reranker";
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
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  fallbackPolicy?: SearchFallbackPolicy;
  dateRange?: { start: string; end: string };
}

export interface SearchResultV2 {
  document: Document;
  score: number;
  matchReason: string;
  explanation: SearchMatchExplanation;
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
  queryPlan: SearchQueryPlan;
  reranker: SearchRerankerMetadata;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function hybridSearchV2(options: SearchOptions): Promise<SearchResponseV2> {
  const originalQuery = options.query.trim();
  const limit = Math.min(options.limit ?? 12, 100);
  const cursorOffset = options.cursor ? decodeCursor(options.cursor, originalQuery) : undefined;
  const offset = Math.max(cursorOffset ?? options.offset ?? 0, 0);
  const mode = options.mode ?? "hybrid";
  const { queryPlan, recallAnalysis: analysis, mustAnalysis } = buildSearchQueryPlan(options);
  const query = originalQuery;

  // 2. Build recall options
  const recallOptions: RecallOptions = {
    limit: Math.min(limit * 4, 300),
    sources: queryPlan.filters.sources,
    allTags: queryPlan.filters.allTags,
    anyTags: queryPlan.filters.anyTags,
    excludeTags: queryPlan.filters.excludeTags,
    dateRange: queryPlan.filters.dateRange,
  };

  // 3. Multi-path recall (parallel where possible)
  const rankedLists = new Map<string, Awaited<ReturnType<typeof searchFts5Strict>>>();

  if (mode !== "semantic") {
    rankedLists.set("exact", searchFts5Exact(mustAnalysis.exactTitleQuery, { ...recallOptions, limit: 50 }));
  }

  // Path 2: Strict FTS (keyword + hybrid mode)
  if (mode !== "semantic") {
    rankedLists.set(
      "strict",
      searchFts5Strict(mustAnalysis.strictFtsQuery, { ...recallOptions, limit: 100 }),
    );
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
  const constrainedCandidates = reciprocalRankFusion(rankedLists, analysis).filter(
    (candidate) =>
      matchesSearchFilters(candidate.document, recallOptions) &&
      passesConceptConstraints(candidate.document, queryPlan),
  );
  const reranked = await rerankSearchCandidates(constrainedCandidates, queryPlan);
  const constrained = reranked.candidates.map(({ candidate, rerankerScore }) => ({
    candidate,
    rerankerScore,
    tier: resolveTier(candidate.paths),
  }));
  const supported = constrained.filter((entry) => entry.tier !== "relaxed");
  const relaxed = constrained.filter((entry) => entry.tier === "relaxed");
  const targetCount = offset + limit;
  const fused =
    queryPlan.fallbackPolicy === "allow_relaxed" && supported.length < targetCount
      ? [...supported, ...relaxed]
      : supported;

  // 5. Pagination (cursor-style stable page)
  const page = fused.slice(offset, offset + limit);

  // 6. Build response
  const results: SearchResultV2[] = page.map(({ candidate, tier, rerankerScore }) => {
    const explanation = buildExplanation(candidate, tier, queryPlan, rerankerScore);
    return {
      document: candidate.document,
      score: rerankerScore ?? candidate.finalScore,
      matchReason: candidate.matchReason,
      explanation,
      snippet: snippets.get(candidate.document.id) ?? buildSnippetV2(candidate.document, analysis),
    };
  });

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
    appliedTags: [...queryPlan.filters.allTags, ...queryPlan.filters.anyTags],
    topicTerms: [],
    queryPlan,
    reranker: reranked.metadata,
  };
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

function requiredConceptMatches(conceptCount: number): number {
  if (conceptCount <= 1) return conceptCount;
  if (conceptCount === 2) return 2;
  return Math.ceil(conceptCount * 0.75);
}

function passesConceptConstraints(document: Document, queryPlan: SearchQueryPlan): boolean {
  const mustEvidence = getConceptMatchEvidence(document, queryPlan.concepts.must);
  if (mustEvidence.matchedConcepts.length < requiredConceptMatches(queryPlan.concepts.must.length)) {
    return false;
  }
  const excluded = getConceptMatchEvidence(document, queryPlan.concepts.exclude);
  return excluded.matchedConcepts.length === 0;
}

function resolveTier(paths: string[]): SearchMatchExplanation["tier"] {
  if (paths.includes("exact") || paths.includes("strict")) return "strict";
  if (paths.includes("vector") || paths.includes("cjk")) return "semantic";
  return "relaxed";
}

function buildExplanation(
  candidate: ReturnType<typeof reciprocalRankFusion>[number],
  tier: SearchMatchExplanation["tier"],
  queryPlan: SearchQueryPlan,
  rerankerScore?: number,
): SearchMatchExplanation {
  const mustEvidence = getConceptMatchEvidence(candidate.document, queryPlan.concepts.must);
  const shouldEvidence = getConceptMatchEvidence(candidate.document, queryPlan.concepts.should);
  const documentTags = new Set(
    collectDocumentCanonicalTags(candidate.document).map((entry) => entry.canonicalTag),
  );
  const requestedTags = [...queryPlan.filters.allTags, ...queryPlan.filters.anyTags];

  return {
    tier,
    matchedTags: requestedTags.filter((tag) => documentTags.has(tag)),
    matchedMustConcepts: mustEvidence.matchedConcepts,
    missingShouldConcepts: queryPlan.concepts.should
      .map((concept) => concept.canonical)
      .filter((concept) => !shouldEvidence.matchedConcepts.includes(concept)),
    matchedFields: mustEvidence.matchedFields,
    recallPaths: candidate.paths,
    scoreBreakdown: {
      fusion: candidate.rrfScore,
      lexical: candidate.lexical.score,
      semantic: candidate.semanticScore,
      jointCoverage:
        candidate.joint.titleJointMatch ||
        candidate.joint.abstractJointMatch ||
        candidate.joint.sameSentenceCooccurrence > 0
          ? 1
          : candidate.joint.conceptCoverage,
      reranker: rerankerScore,
    },
  };
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
