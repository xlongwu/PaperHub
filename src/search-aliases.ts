/**
 * Search aliases backed by the canonical tag registry.
 *
 * Query expansion, SQL filters, in-memory checks and tag statistics now share
 * the same canonical ids instead of maintaining separate alias dictionaries.
 */

import {
  CANONICAL_TAGS,
  getCanonicalTagAlternatives,
  getCanonicalTagId,
  normalizeCanonicalAlias,
} from "@/canonical-tags";

export interface ConceptEntry {
  canonical: string;
  aliases: string[];
  chinese?: string[];
}

export const CONCEPT_ALIASES: ConceptEntry[] = CANONICAL_TAGS.filter(
  (definition) => !["source", "type", "year"].includes(definition.category),
).map((definition) => ({
  canonical: definition.id,
  aliases: [definition.id, definition.displayName, ...definition.aliases],
  chinese: definition.chineseAliases,
}));

export interface PhraseConcept {
  tokens: string[][];
  canonical: string;
}

export const PHRASE_CONCEPTS: PhraseConcept[] = [
  { tokens: [["large"], ["language"], ["model", "models"]], canonical: "llm" },
  { tokens: [["vision", "visual"], ["language"], ["model", "models"]], canonical: "vlm" },
  { tokens: [["retrieval"], ["augmented"], ["generation"]], canonical: "rag" },
  { tokens: [["natural"], ["language"], ["processing"]], canonical: "nlp" },
  { tokens: [["computer"], ["vision"]], canonical: "cv" },
  { tokens: [["artificial"], ["intelligence"]], canonical: "ai" },
  { tokens: [["machine"], ["learning"]], canonical: "ml" },
  { tokens: [["chain"], ["of"], ["thought", "thoughts"]], canonical: "cot" },
  {
    tokens: [["reinforcement"], ["learning"], ["from", "with"], ["human"], ["feedback"]],
    canonical: "rlhf",
  },
  { tokens: [["direct"], ["preference"], ["optimization", "optimisation"]], canonical: "dpo" },
  { tokens: [["mixture"], ["of"], ["experts"]], canonical: "moe" },
  { tokens: [["supervised"], ["fine"], ["tuning", "tune", "tuned"]], canonical: "sft" },
  { tokens: [["automatic"], ["speech"], ["recognition"]], canonical: "asr" },
  { tokens: [["text"], ["to"], ["speech"]], canonical: "tts" },
  { tokens: [["diffusion"], ["model", "models"]], canonical: "diffusion" },
  { tokens: [["multi"], ["agent", "agents", "agentic"]], canonical: "multi-agent" },
  { tokens: [["multi"], ["modal", "modality"]], canonical: "multimodal" },
  { tokens: [["medical"], ["image", "images", "imaging"]], canonical: "medical-imaging" },
  {
    tokens: [["synthetic"], ["data", "dataset", "datasets", "corpus", "corpora"]],
    canonical: "synthetic-data",
  },
  { tokens: [["data"], ["synthesis"]], canonical: "synthetic-data" },
];

export const ALIAS_BY_CANONICAL = new Map(CONCEPT_ALIASES.map((entry) => [entry.canonical, entry]));

export const CANONICAL_BY_ALIAS = new Map<string, string>();
export const CANONICAL_BY_CHINESE = new Map<string, string>();

for (const entry of CONCEPT_ALIASES) {
  for (const alias of entry.aliases) {
    CANONICAL_BY_ALIAS.set(normalizeCanonicalAlias(alias), entry.canonical);
  }
  for (const chinese of entry.chinese ?? []) {
    CANONICAL_BY_CHINESE.set(chinese, entry.canonical);
  }
}

export function allAlternatives(canonical: string): string[] {
  return getCanonicalTagAlternatives(canonical);
}

const PLURAL_TO_SINGULAR: Record<string, string> = {
  agents: "agent",
  models: "model",
  embeddings: "embedding",
  transformers: "transformer",
  thoughts: "thought",
  images: "image",
  memories: "memory",
  evals: "eval",
};

export function toSingular(word: string): string {
  return PLURAL_TO_SINGULAR[word] ?? word;
}

export function normaliseHyphens(word: string): string {
  return normalizeCanonicalAlias(word);
}

export function mapChineseToken(token: string): string | null {
  return CANONICAL_BY_CHINESE.get(token) ?? null;
}

export function findChineseConcepts(text: string): string[] {
  const matches = [...CANONICAL_BY_CHINESE.entries()]
    .filter(([surface]) => text.includes(surface))
    .sort((a, b) => b[0].length - a[0].length);

  const selected: Array<{ surface: string; canonical: string }> = [];
  for (const [surface, canonical] of matches) {
    if (selected.some((item) => item.canonical === canonical || item.surface.includes(surface))) {
      continue;
    }
    selected.push({ surface, canonical });
  }
  return [...new Set(selected.map((item) => item.canonical))];
}

export function isCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

export function canonicalizeSearchConcept(value: string): string {
  return getCanonicalTagId(value);
}
