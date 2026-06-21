import type { SearchConcept } from "@/search-query";

export type SearchIntent =
  | "exact_lookup"
  | "topic_search"
  | "concept_intersection"
  | "natural_language"
  | "author_search";

export type SearchFallbackPolicy = "strict" | "allow_relaxed";

export interface SearchQueryPlan {
  rawQuery: string;
  normalizedQuery: string;
  filters: {
    allTags: string[];
    anyTags: string[];
    excludeTags: string[];
    sources: string[];
    dateRange?: {
      start: string;
      end: string;
    };
  };
  concepts: {
    must: SearchConcept[];
    should: SearchConcept[];
    exclude: SearchConcept[];
  };
  intent: SearchIntent;
  fallbackPolicy: SearchFallbackPolicy;
}

export interface JointRelevanceFeatures {
  conceptCoverage: number;
  titleJointMatch: boolean;
  abstractJointMatch: boolean;
  sameSentenceCooccurrence: number;
  sameParagraphCooccurrence: number;
  allTagMatch: boolean;
  strictPathHit: boolean;
  vectorLexicalAgreement: boolean;
}

export interface SearchMatchExplanation {
  tier: "strict" | "semantic" | "relaxed";
  matchedTags: string[];
  matchedMustConcepts: string[];
  missingShouldConcepts: string[];
  matchedFields: Array<"title" | "abstract" | "tags" | "summary" | "full_text">;
  recallPaths: string[];
  scoreBreakdown: {
    fusion: number;
    lexical: number;
    semantic: number;
    jointCoverage: number;
    reranker?: number;
  };
}

export type SearchContractErrorCode = "UNKNOWN_TAG" | "FILTER_CONFLICT" | "INVALID_QUERY";

export class SearchContractError extends Error {
  constructor(
    readonly code: SearchContractErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SearchContractError";
  }
}
