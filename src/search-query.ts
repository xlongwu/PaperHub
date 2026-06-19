/**
 * Query analysis and lexical relevance helpers — v2 revision.
 *
 * Key changes from v1:
 *   - No more hard concept-hit filtering (minimumLexicalMatches removed).
 *   - Full SearchQueryAnalysis with exact/strict/broad FTS queries.
 *   - Chinese CJK n-gram generation for queries against English documents.
 *   - English normalisation: singular/plural, hyphen, case.
 *   - Query pattern recognition (exact title, model name, etc.).
 *   - Uses the centralised alias dictionary from search-aliases.ts.
 */

import {
  CANONICAL_BY_ALIAS,
  PHRASE_CONCEPTS,
  toSingular,
  normaliseHyphens,
  mapChineseToken,
  isCJK,
  allAlternatives,
  findChineseConcepts,
} from "@/search-aliases";
import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchConcept {
  canonical: string;
  alternatives: string[];
}

/** Recognised query pattern — influences recall-path weights */
export type QueryPattern =
  | "exact_title"
  | "model_name"
  | "multi_concept"
  | "single_concept"
  | "author_search"
  | "natural_language"
  | "chinese_topic"
  | "filtered"
  | "default";

export interface SearchQueryAnalysis {
  original: string;
  normalized: string;
  language: "zh" | "en" | "mixed";
  /** Raw tokens after normalisation */
  terms: string[];
  /** Multi-word phrases detected in the query */
  phrases: string[];
  /** Canonical concepts (collapsed phrases + normalised terms) */
  concepts: SearchConcept[];
  /** Aliases of canonical concepts for OR expansions */
  aliases: string[];
  /** Exact title match query (AND of all concepts, no stemming) */
  exactTitleQuery: string;
  /** Strict FTS query (AND of core concepts with stemming) */
  strictFtsQuery: string;
  /** Broad FTS query (OR of concepts + aliases) */
  broadFtsQuery: string;
  /** Chinese CJK substrings for n-gram matching (null if not CJK) */
  cjkNgrams: string[] | null;
  /** Query pattern classification */
  pattern: QueryPattern;
}

export interface LexicalRelevance {
  score: number;
  coverage: number;
  matchedConcepts: number;
  titleMatches: number;
  tagMatches: number;
  summaryMatches: number;
}

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

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
  "is",
  "it",
  "be",
  "as",
  "at",
  "by",
  "do",
  "we",
  "how",
  "what",
  "which",
  "can",
  "should",
]);

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export function analyzeSearchQuery(query: string): SearchQueryAnalysis {
  const original = query.trim();

  // --- Tokenisation ---
  const allTokens = tokenize(original);
  const meaningfulTokens = allTokens.filter((t) => !STOP_WORDS.has(t));
  const tokens = meaningfulTokens.length > 0 ? meaningfulTokens : allTokens;

  // --- Language detection ---
  const language = detectLanguage(tokens, original);

  const normalisedTokens = tokens.map(normaliseEnglish);
  const concepts =
    language === "en"
      ? collapseKnownPhrases(normalisedTokens)
      : buildMixedLanguageConcepts(original, normalisedTokens);

  // --- Collect all aliases for OR query expansion ---
  const aliases: string[] = [];
  for (const c of concepts) {
    for (const alt of c.alternatives) {
      if (!aliases.includes(alt)) aliases.push(alt);
    }
  }

  // --- Build FTS queries ---
  const exactTitleQuery = buildExactTitleQuery(concepts);
  const strictFtsQuery = buildStrictFtsQuery(concepts);
  const broadFtsQuery = buildBroadFtsQuery(concepts, aliases);

  // --- CJK n-grams ---
  const cjkNgrams = language !== "en" ? generateCjkNgrams(original) : null;

  // --- Pattern detection ---
  const pattern = detectQueryPattern(original, concepts, language);

  return {
    original,
    normalized: concepts.map((concept) => concept.canonical).join(" "),
    language,
    terms: tokens,
    phrases: concepts
      .flatMap((concept) => concept.alternatives)
      .filter((alternative) => alternative.includes(" ")),
    concepts,
    aliases,
    exactTitleQuery,
    strictFtsQuery,
    broadFtsQuery,
    cjkNgrams,
    pattern,
  };
}

/**
 * Score a document against the query analysis.
 * No hard filtering — this score feeds into ranking.
 */
export function scoreDocumentAgainstQuery(
  document: Document,
  analysis: SearchQueryAnalysis,
): LexicalRelevance {
  if (analysis.concepts.length === 0) {
    return { score: 0, coverage: 0, matchedConcepts: 0, titleMatches: 0, tagMatches: 0, summaryMatches: 0 };
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
  const tagCoverage = tagMatches / conceptCount;
  const abstractCoverage = abstractMatches / conceptCount;
  const summaryCoverage = summaryMatches / conceptCount;

  const phraseBoost =
    analysis.normalized.length > 0 &&
    (title.normalized.includes(analysis.normalized) || abstract.normalized.includes(analysis.normalized))
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

  return { score, coverage, matchedConcepts, titleMatches, tagMatches, summaryMatches };
}

// ---------------------------------------------------------------------------
// Tokenisation & normalisation
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .replace(/(?<=\p{L})-(?=\p{N})/gu, "")
      .replace(/-/g, " ")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * English normalisation: singular → plural, hyphen collapse.
 */
function normaliseEnglish(word: string): string {
  let w = word.toLowerCase();
  // Hyphens: "gpt-4" → "gpt4" for matching
  w = w.replace(/-/g, "");
  // Singular for common plurals
  w = toSingular(w);
  return w;
}

/**
 * Detect query language (zh / en / mixed).
 */
function detectLanguage(tokens: string[], _original: string): "zh" | "en" | "mixed" {
  const cjkCount = tokens.filter(isCJK).length;
  if (cjkCount === 0) return "en";
  if (cjkCount === tokens.length) return "zh";
  return "mixed";
}

// ---------------------------------------------------------------------------
// Chinese CJK n-gram generation
// ---------------------------------------------------------------------------

/**
 * Generate 2-gram and 3-gram substrings from a CJK query.
 * This compensates for FTS5's lack of a CJK tokenizer.
 *
 * Example: "医学图像扩散模型" →
 *   2-grams: 医学, 学图, 图像, 像扩, 扩散, 散模, 模型
 *   3-grams: 医学图, 学图像, 图像扩, 像扩散, 扩散模, 散模型
 */
function generateCjkNgrams(text: string): string[] {
  // Extract CJK character runs
  const cjkChars = [...text].filter(isCJK);
  if (cjkChars.length < 2) return cjkChars;

  const ngrams = new Set<string>();
  ngrams.add(cjkChars.join("")); // Full string as one query term

  // 2-grams
  for (let i = 0; i < cjkChars.length - 1; i++) {
    ngrams.add(cjkChars[i]! + cjkChars[i + 1]!);
  }

  // 3-grams
  if (cjkChars.length >= 3) {
    for (let i = 0; i < cjkChars.length - 2; i++) {
      ngrams.add(cjkChars[i]! + cjkChars[i + 1]! + cjkChars[i + 2]!);
    }
  }

  return [...ngrams];
}

// ---------------------------------------------------------------------------
// Phrase collapsing & concept resolution
// ---------------------------------------------------------------------------

function collapseKnownPhrases(tokens: string[]): SearchConcept[] {
  const concepts: SearchConcept[] = [];

  for (let index = 0; index < tokens.length; ) {
    const phrase = PHRASE_CONCEPTS.find((candidate) =>
      candidate.tokens.every((choices, offset) =>
        choices.some((c) => c === tokens[index + offset] || c.replace(/-/g, "") === tokens[index + offset]),
      ),
    );

    if (phrase) {
      concepts.push(createConcept(phrase.canonical));
      index += phrase.tokens.length;
      continue;
    }

    concepts.push(createConcept(tokens[index]!));
    index++;
  }

  // Deduplicate by canonical
  const deduplicated = new Map<string, SearchConcept>();
  for (const concept of concepts) {
    deduplicated.set(concept.canonical, concept);
  }
  return [...deduplicated.values()];
}

function createConcept(value: string): SearchConcept {
  // Try CJK → English mapping first
  const mapped = mapChineseToken(value);
  const key = mapped ?? value;

  // Check if there's a known canonical form
  const canonical = CANONICAL_BY_ALIAS.get(normaliseHyphens(key)) ?? key;

  return {
    canonical,
    alternatives: allAlternatives(canonical),
  };
}

function buildMixedLanguageConcepts(original: string, normalizedTokens: string[]): SearchConcept[] {
  const chineseConcepts = findChineseConcepts(original).map(createConcept);
  const latinTokens = normalizedTokens.filter((token) => !isCJK(token));
  const latinConcepts = collapseKnownPhrases(latinTokens);

  const concepts = [...chineseConcepts, ...latinConcepts];
  if (concepts.length === 0) {
    concepts.push(createConcept(original.trim()));
  }
  return [...new Map(concepts.map((concept) => [concept.canonical, concept])).values()];
}

// ---------------------------------------------------------------------------
// FTS query builders
// ---------------------------------------------------------------------------

/**
 * Exact title query: AND of all concepts as quoted phrases.
 * Intended for the "exact title" recall path with the highest weight.
 */
function buildExactTitleQuery(concepts: SearchConcept[]): string {
  return concepts
    .map((c) => quoteFtsPhrase(c.canonical))
    .filter(Boolean)
    .join(" AND ");
}

/**
 * Strict FTS query: across concepts AND, within concept OR all alternatives.
 * Example: concepts [synthetic, data, llm] →
 *   ("synthetic"*) AND ("data"*) AND ("llm"* OR "large language model"*)
 */
function buildStrictFtsQuery(concepts: SearchConcept[]): string {
  return concepts
    .map((c) => {
      const clauses = c.alternatives.map(quoteFtsPhrase).filter(Boolean);
      if (clauses.length === 1) return clauses[0]!;
      return `(${clauses.join(" OR ")})`;
    })
    .join(" AND ");
}

/**
 * Broad FTS query: OR of all alternative forms.
 * High recall, lower precision — used for the broad recall path.
 */
function buildBroadFtsQuery(concepts: SearchConcept[], aliases: string[]): string {
  const clauses = aliases.map((a) => quoteFtsPhrase(a)).filter(Boolean);
  if (clauses.length === 0) return "";
  return clauses.join(" OR ");
}

function quoteFtsPhrase(value: string): string {
  const cleaned = value.replace(/"/g, '""').trim();
  return cleaned.length > 0 ? `"${cleaned}"*` : "";
}

// ---------------------------------------------------------------------------
// Query pattern recognition
// ---------------------------------------------------------------------------

/**
 * Classify the query so recall paths can be weighted differently per type.
 */
function detectQueryPattern(original: string, concepts: SearchConcept[], language: string): QueryPattern {
  const text = original.toLowerCase().trim();

  if (language === "zh" || language === "mixed") return "chinese_topic";

  // Short queries (1-2 words) that look like model names
  if (concepts.length <= 2) {
    const modelPatterns = /^(gpt|claude|gemini|llama|mistral|deepseek|bert|t5|flan|palm|chinchilla)/i;
    if (modelPatterns.test(text)) return "model_name";
  }

  // Multi-concept queries (3+ distinct concepts)
  if (concepts.length >= 3) return "multi_concept";

  // Single concept query
  if (concepts.length === 1) return "single_concept";

  // Author-like pattern (initials + surname)
  if (/^[a-z]\.?\s+[a-z]+$/i.test(text) || (/^[a-z]+$/i.test(text) && text.length > 10)) {
    return "author_search";
  }

  // Natural language / question-like
  if (text.length > 30 && /\b(what|how|why|when|which|can|should|does|is|are|compar)\b/i.test(text)) {
    return "natural_language";
  }

  return "default";
}

// ---------------------------------------------------------------------------
// Field matching helpers
// ---------------------------------------------------------------------------

function searchableField(value: string): { normalized: string; tokens: string[] } {
  const normalized = normalizeSearchText(value);
  return { normalized, tokens: normalized.split(" ").filter(Boolean) };
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
      const normKey = normaliseHyphens(normalizedAlternative);
      return field.tokens.some((t) => normaliseHyphens(t) === normKey);
    }
    return field.tokens.some((token) => token.startsWith(normalizedAlternative));
  });
}

// ---------------------------------------------------------------------------
// Re-exports from aliases (for backward compat)
// ---------------------------------------------------------------------------

export { isCJK } from "@/search-aliases";
