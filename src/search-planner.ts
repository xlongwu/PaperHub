import { resolveKnownSearchTags } from "@/db/search-tags";
import {
  analyzeSearchQuery,
  buildSearchQueryAnalysis,
  type SearchConcept,
  type SearchQueryAnalysis,
} from "@/search-query";
import {
  SearchContractError,
  type SearchFallbackPolicy,
  type SearchIntent,
  type SearchQueryPlan,
} from "@/search-contract";

export interface SearchPlanInput {
  query: string;
  sources?: string[];
  tags?: string[];
  tagMatchMode?: "any" | "all";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  mustConcepts?: string[];
  shouldConcepts?: string[];
  excludeConcepts?: string[];
  dateRange?: { start: string; end: string };
  fallbackPolicy?: SearchFallbackPolicy;
}

export interface BuiltSearchPlan {
  queryPlan: SearchQueryPlan;
  recallAnalysis: SearchQueryAnalysis;
  mustAnalysis: SearchQueryAnalysis;
}

export function buildSearchQueryPlan(input: SearchPlanInput): BuiltSearchPlan {
  const rawQuery = input.query.trim();
  if (!rawQuery) {
    throw new SearchContractError("INVALID_QUERY", "Search query must not be empty.");
  }
  const dateRange = validateDateRange(input.dateRange);

  const legacyTags = cleanList(input.tags);
  const allTagInputs = [...cleanList(input.allTags), ...(input.tagMatchMode === "any" ? [] : legacyTags)];
  const anyTagInputs = [...cleanList(input.anyTags), ...(input.tagMatchMode === "any" ? legacyTags : [])];
  const excludeTagInputs = cleanList(input.excludeTags);

  const allTags = resolveTagGroup(allTagInputs);
  const anyTags = resolveTagGroup(anyTagInputs);
  const excludeTags = resolveTagGroup(excludeTagInputs);
  const unknownTags = [...allTags.unknownTags, ...anyTags.unknownTags, ...excludeTags.unknownTags];
  if (unknownTags.length > 0) {
    throw new SearchContractError(
      "UNKNOWN_TAG",
      `Unknown tag${unknownTags.length > 1 ? "s" : ""}: ${unknownTags.join(", ")}`,
      { unknownTags },
    );
  }

  const effectiveAnyTags = anyTags.canonicalTags.filter(
    (tag) => !allTags.canonicalTags.includes(tag),
  );
  const positiveTags = new Set([...allTags.canonicalTags, ...effectiveAnyTags]);
  const conflicts = excludeTags.canonicalTags.filter((tag) => positiveTags.has(tag));
  if (conflicts.length > 0) {
    throw new SearchContractError(
      "FILTER_CONFLICT",
      `Tags cannot be both included and excluded: ${conflicts.join(", ")}`,
      { conflictingTags: conflicts },
    );
  }

  const partitioned = partitionNaturalLanguageQuery(rawQuery);
  const explicitMust = conceptsFromInputs(input.mustConcepts);
  const explicitShould = conceptsFromInputs(input.shouldConcepts);
  const explicitExclude = conceptsFromInputs(input.excludeConcepts);
  const must =
    explicitMust.length > 0 ? explicitMust : analyzeSearchQuery(partitioned.mustQuery || rawQuery).concepts;
  const should = dedupeConcepts([
    ...explicitShould,
    ...(partitioned.shouldQuery ? analyzeSearchQuery(partitioned.shouldQuery).concepts : []),
  ]).filter((concept) => !must.some((item) => item.canonical === concept.canonical));
  const exclude = explicitExclude.filter(
    (concept) => !must.some((item) => item.canonical === concept.canonical),
  );

  const recallConcepts = dedupeConcepts([...must, ...should]);
  const recallAnalysis = buildSearchQueryAnalysis(rawQuery, recallConcepts);
  const mustAnalysis = buildSearchQueryAnalysis(
    partitioned.mustQuery || rawQuery,
    must.length > 0 ? must : recallConcepts,
  );
  const queryPlan: SearchQueryPlan = {
    rawQuery,
    normalizedQuery: recallAnalysis.normalized,
    filters: {
      allTags: allTags.canonicalTags,
      anyTags: effectiveAnyTags,
      excludeTags: excludeTags.canonicalTags,
      sources: cleanList(input.sources),
      dateRange,
    },
    concepts: {
      must,
      should,
      exclude,
    },
    intent: resolveIntent(recallAnalysis, must),
    fallbackPolicy: input.fallbackPolicy ?? "strict",
  };

  return { queryPlan, recallAnalysis, mustAnalysis };
}

function resolveTagGroup(values: string[]): ReturnType<typeof resolveKnownSearchTags> {
  return resolveKnownSearchTags(values);
}

function cleanList(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function validateDateRange(
  dateRange?: SearchPlanInput["dateRange"],
): SearchQueryPlan["filters"]["dateRange"] {
  if (!dateRange) return undefined;
  const start = dateRange.start.trim();
  const end = dateRange.end.trim();
  if (!start || !end) {
    throw new SearchContractError(
      "INVALID_QUERY",
      "Date range requires both start and end values.",
      { dateRange },
    );
  }

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new SearchContractError("INVALID_QUERY", "Date range contains an invalid date.", {
      dateRange,
    });
  }
  if (startTime > endTime) {
    throw new SearchContractError(
      "FILTER_CONFLICT",
      "Date range start must not be later than its end.",
      { dateRange: { start, end } },
    );
  }
  return { start, end };
}

function conceptsFromInputs(values?: string[]): SearchConcept[] {
  return dedupeConcepts(cleanList(values).flatMap((value) => analyzeSearchQuery(value).concepts));
}

function dedupeConcepts(concepts: SearchConcept[]): SearchConcept[] {
  return [...new Map(concepts.map((concept) => [concept.canonical, concept])).values()];
}

function partitionNaturalLanguageQuery(query: string): {
  mustQuery: string;
  shouldQuery: string;
} {
  const preference = /\b(?:preferably|ideally|prefer|if possible)\b|最好|优先|尽量/iu.exec(query);
  if (!preference || preference.index <= 0) {
    return { mustQuery: query, shouldQuery: "" };
  }
  return {
    mustQuery: query
      .slice(0, preference.index)
      .replace(/[，,;；]+$/u, "")
      .trim(),
    shouldQuery: query
      .slice(preference.index + preference[0].length)
      .replace(/^[，,;；\s]+/u, "")
      .trim(),
  };
}

function resolveIntent(analysis: SearchQueryAnalysis, must: SearchConcept[]): SearchIntent {
  if (analysis.pattern === "exact_title" || analysis.pattern === "model_name") return "exact_lookup";
  if (analysis.pattern === "author_search") return "author_search";
  if (analysis.pattern === "natural_language") return "natural_language";
  if (must.length > 1) return "concept_intersection";
  return "topic_search";
}
