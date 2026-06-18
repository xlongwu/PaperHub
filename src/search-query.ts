/**
 * Query analysis and lexical relevance helpers shared by keyword and hybrid
 * search. Search terms are treated as concepts so common AI abbreviations can
 * match their expanded forms without an LLM rewrite.
 */

import type { Document } from "@/types";

export interface SearchConcept {
  canonical: string;
  alternatives: string[];
}

export interface SearchQueryAnalysis {
  concepts: SearchConcept[];
  ftsQuery: string;
  normalizedPhrase: string;
  minimumLexicalMatches: number;
  minimumHybridMatches: number;
}

export interface LexicalRelevance {
  score: number;
  coverage: number;
  matchedConcepts: number;
  titleMatches: number;
  tagMatches: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "using",
  "via",
  "with",
]);

const CONCEPT_ALIASES: Record<string, string[]> = {
  ai: ["ai", "artificial intelligence"],
  llm: ["llm", "large language model"],
  rag: ["rag", "retrieval augmented generation"],
  vlm: ["vlm", "vision language model"],
};

const CONCEPT_CANONICAL_FORMS: Record<string, string> = {
  llms: "llm",
  vlms: "vlm",
};

const PHRASE_CONCEPTS: Array<{ tokens: string[][]; canonical: string }> = [
  {
    tokens: [["large"], ["language"], ["model", "models"]],
    canonical: "llm",
  },
  {
    tokens: [["retrieval"], ["augmented"], ["generation"]],
    canonical: "rag",
  },
  {
    tokens: [["vision"], ["language"], ["model", "models"]],
    canonical: "vlm",
  },
  {
    tokens: [["artificial"], ["intelligence"]],
    canonical: "ai",
  },
];

export function analyzeSearchQuery(query: string): SearchQueryAnalysis {
  const allTokens = tokenize(query);
  const meaningfulTokens = allTokens.filter((token) => !STOP_WORDS.has(token));
  const tokens = meaningfulTokens.length > 0 ? meaningfulTokens : allTokens;
  const concepts = collapseKnownPhrases(tokens);
  const conceptCount = concepts.length;

  return {
    concepts,
    ftsQuery: concepts.map(buildFtsConceptClause).join(" OR "),
    normalizedPhrase: normalizeSearchText(tokens.join(" ")),
    minimumLexicalMatches: conceptCount <= 3 ? conceptCount : Math.ceil(conceptCount * 0.75),
    minimumHybridMatches: conceptCount <= 1 ? conceptCount : Math.ceil(conceptCount * 0.6),
  };
}

export function scoreDocumentAgainstQuery(
  document: Document,
  analysis: SearchQueryAnalysis,
): LexicalRelevance {
  if (analysis.concepts.length === 0) {
    return {
      score: 0,
      coverage: 0,
      matchedConcepts: 0,
      titleMatches: 0,
      tagMatches: 0,
    };
  }

  const title = searchableField(document.title);
  const abstract = searchableField(document.abstract);
  const tags = searchableField(
    [...document.domainTags, ...document.modelTags, document.sourceTag, document.typeTag].join(" "),
  );
  const summaries = searchableField([document.summaryZh, document.summaryEn].filter(Boolean).join(" "));

  let matchedConcepts = 0;
  let titleMatches = 0;
  let abstractMatches = 0;
  let tagMatches = 0;
  let summaryMatches = 0;

  for (const concept of analysis.concepts) {
    const inTitle = fieldContainsConcept(title, concept);
    const inAbstract = fieldContainsConcept(abstract, concept);
    const inTags = fieldContainsConcept(tags, concept);
    const inSummaries = fieldContainsConcept(summaries, concept);

    if (inTitle || inAbstract || inTags || inSummaries) matchedConcepts++;
    if (inTitle) titleMatches++;
    if (inAbstract) abstractMatches++;
    if (inTags) tagMatches++;
    if (inSummaries) summaryMatches++;
  }

  const conceptCount = analysis.concepts.length;
  const coverage = matchedConcepts / conceptCount;
  const titleCoverage = titleMatches / conceptCount;
  const abstractCoverage = abstractMatches / conceptCount;
  const tagCoverage = tagMatches / conceptCount;
  const summaryCoverage = summaryMatches / conceptCount;
  const phraseBoost =
    analysis.normalizedPhrase.length > 0 &&
    (title.normalized.includes(analysis.normalizedPhrase) ||
      abstract.normalized.includes(analysis.normalizedPhrase))
      ? 0.12
      : 0;

  const score = Math.min(
    1,
    coverage * 0.5 +
      titleCoverage * 0.22 +
      tagCoverage * 0.12 +
      abstractCoverage * 0.08 +
      summaryCoverage * 0.04 +
      phraseBoost,
  );

  return {
    score,
    coverage,
    matchedConcepts,
    titleMatches,
    tagMatches,
  };
}

function tokenize(query: string): string[] {
  return (
    query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function collapseKnownPhrases(tokens: string[]): SearchConcept[] {
  const concepts: SearchConcept[] = [];

  for (let index = 0; index < tokens.length; ) {
    const phrase = PHRASE_CONCEPTS.find((candidate) =>
      candidate.tokens.every((choices, offset) => choices.includes(tokens[index + offset] ?? "")),
    );

    if (phrase) {
      concepts.push(createConcept(phrase.canonical));
      index += phrase.tokens.length;
      continue;
    }

    concepts.push(createConcept(tokens[index]!));
    index++;
  }

  const deduplicated = new Map<string, SearchConcept>();
  for (const concept of concepts) {
    deduplicated.set(concept.canonical, concept);
  }
  return [...deduplicated.values()];
}

function createConcept(value: string): SearchConcept {
  const canonical = CONCEPT_CANONICAL_FORMS[value] ?? value;
  return {
    canonical,
    alternatives: CONCEPT_ALIASES[canonical] ?? [canonical],
  };
}

function buildFtsConceptClause(concept: SearchConcept): string {
  const alternatives = concept.alternatives.map((alternative) => quoteFtsPhrase(alternative)).filter(Boolean);

  return alternatives.length === 1 ? alternatives[0]! : `(${alternatives.join(" OR ")})`;
}

function quoteFtsPhrase(value: string): string {
  const cleaned = value.replace(/"/g, '""').trim();
  return cleaned.length > 0 ? `"${cleaned}"*` : "";
}

function searchableField(value: string): { normalized: string; tokens: string[] } {
  const normalized = normalizeSearchText(value);
  return {
    normalized,
    tokens: normalized.split(" ").filter(Boolean),
  };
}

function normalizeSearchText(value: string): string {
  return tokenize(value).join(" ");
}

function fieldContainsConcept(
  field: { normalized: string; tokens: string[] },
  concept: SearchConcept,
): boolean {
  return concept.alternatives.some((alternative) => {
    const normalizedAlternative = normalizeSearchText(alternative);
    if (normalizedAlternative.includes(" ")) {
      return field.normalized.includes(normalizedAlternative);
    }

    if (normalizedAlternative.length <= 3) {
      return field.tokens.includes(normalizedAlternative);
    }

    return field.tokens.some((token) => token.startsWith(normalizedAlternative));
  });
}
