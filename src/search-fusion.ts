/**
 * Reciprocal Rank Fusion and deterministic feature re-ranking.
 */

import { scoreDocumentAgainstQuery, textContainsConcept } from "@/search-query";
import type { SearchQueryAnalysis, LexicalRelevance } from "@/search-query";
import type { JointRelevanceFeatures } from "@/search-contract";
import type { Document } from "@/types";

export interface RankedCandidate {
  document: Document;
  score: number;
  matchType: "fts" | "vector" | "hybrid";
  semanticScore?: number;
}

export interface FusionResult {
  document: Document;
  rrfScore: number;
  featureScore: number;
  finalScore: number;
  lexical: LexicalRelevance;
  joint: JointRelevanceFeatures;
  semanticScore: number;
  paths: string[];
  matchReason: string;
}

const RRF_K = 60;

export function reciprocalRankFusion(
  rankedLists: Map<string, RankedCandidate[]>,
  queryAnalysis: SearchQueryAnalysis,
): FusionResult[] {
  const docMap = new Map<
    string,
    {
      doc: Document;
      pathRanks: Record<string, number>;
      paths: string[];
      semanticScore: number;
    }
  >();

  for (const [pathName, candidates] of rankedLists) {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const semanticScore = candidate.semanticScore ?? (pathName === "vector" ? candidate.score : 0);
      const existing = docMap.get(candidate.document.id);
      if (existing) {
        existing.pathRanks[pathName] = index + 1;
        existing.paths.push(pathName);
        existing.semanticScore = Math.max(existing.semanticScore, semanticScore);
      } else {
        docMap.set(candidate.document.id, {
          doc: candidate.document,
          pathRanks: { [pathName]: index + 1 },
          paths: [pathName],
          semanticScore,
        });
      }
    }
  }

  const maxRrf =
    [...rankedLists.keys()].reduce(
      (sum, pathName) => sum + pathWeight(pathName, queryAnalysis) / (RRF_K + 1),
      0,
    ) || 1;
  const fused: FusionResult[] = [];

  for (const entry of docMap.values()) {
    const rawRrf = Object.entries(entry.pathRanks).reduce(
      (sum, [pathName, rank]) => sum + pathWeight(pathName, queryAnalysis) / (RRF_K + rank),
      0,
    );
    const rrfScore = rawRrf / maxRrf;
    const lexical = scoreDocumentAgainstQuery(entry.doc, queryAnalysis);
    const joint = computeJointRelevanceFeatures(
      entry.doc,
      queryAnalysis,
      lexical,
      entry.paths,
      entry.semanticScore,
    );
    const featureScore = computeFeatureScore(
      entry.doc,
      queryAnalysis,
      lexical,
      entry.paths,
      entry.semanticScore,
      joint,
    );

    const result = {
      document: entry.doc,
      rrfScore,
      featureScore,
      finalScore: rrfScore * 0.65 + featureScore * 0.35,
      lexical,
      joint,
      semanticScore: entry.semanticScore,
      paths: entry.paths,
      matchReason: buildMatchReason(entry.paths, lexical),
    };

    fused.push(result);
  }

  return fused.sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      b.document.publishedAt.localeCompare(a.document.publishedAt) ||
      a.document.id.localeCompare(b.document.id),
  );
}

function pathWeight(pathName: string, analysis: SearchQueryAnalysis): number {
  const baseWeights: Record<string, number> = {
    exact: 1.8,
    strict: 1.4,
    vector: 1.2,
    cjk: 1,
    broad: 0.65,
  };
  let weight = baseWeights[pathName] ?? 1;

  if (analysis.pattern === "chinese_topic" && pathName === "cjk") {
    weight *= 1.2;
  }
  if (analysis.pattern === "model_name" && pathName === "exact") {
    weight *= 1.15;
  }
  return weight;
}

function computeFeatureScore(
  document: Document,
  analysis: SearchQueryAnalysis,
  lexical: LexicalRelevance,
  paths: string[],
  semanticScore: number,
  joint: JointRelevanceFeatures,
): number {
  const conceptCount = analysis.concepts.length;
  if (conceptCount === 0) return semanticScore * 0.12;

  let score = 0;
  const normalizedTitle = normalize(document.title);
  const normalizedQuery = normalize(analysis.original);

  if (normalizedQuery && normalizedTitle.includes(normalizedQuery)) score += 0.12;
  score += 0.1 * (lexical.titleMatches / conceptCount);
  score += 0.06 * lexical.coverage;

  if (
    analysis.concepts.some((concept) =>
      document.modelTags.some((tag) =>
        concept.alternatives.some((alternative) => normalize(tag).includes(normalize(alternative))),
      ),
    )
  ) {
    score += 0.08;
  }

  if (
    analysis.concepts.some((concept) =>
      document.domainTags.some((tag) =>
        concept.alternatives.some((alternative) => normalize(tag).includes(normalize(alternative))),
      ),
    )
  ) {
    score += 0.04;
  }

  if (paths.includes("vector") && paths.some((path) => path !== "vector")) score += 0.06;
  score += 0.12 * Math.max(0, Math.min(1, semanticScore));
  if (joint.titleJointMatch) score += 0.12;
  else if (joint.abstractJointMatch) score += 0.08;
  score += joint.sameSentenceCooccurrence * 0.08;
  score += joint.sameParagraphCooccurrence * 0.04;
  if (joint.vectorLexicalAgreement) score += 0.06;

  const summaryText = normalize([document.summaryZh, document.summaryEn].filter(Boolean).join(" "));
  if (
    analysis.concepts.some((concept) =>
      concept.alternatives.some((alternative) => summaryText.includes(normalize(alternative))),
    )
  ) {
    score += 0.04;
  }

  return Math.min(1, score);
}

export function computeJointRelevanceFeatures(
  document: Document,
  analysis: SearchQueryAnalysis,
  lexical: LexicalRelevance = scoreDocumentAgainstQuery(document, analysis),
  paths: string[] = [],
  semanticScore = 0,
): JointRelevanceFeatures {
  const concepts = analysis.concepts;
  const allMatch = (text: string): boolean =>
    concepts.length > 0 && concepts.every((concept) => textContainsConcept(text, concept));
  const summaries = [document.summaryZh, document.summaryEn].filter(Boolean).join("\n");
  const paragraphs = [document.abstract, summaries, document.fullText ?? ""]
    .flatMap((value) => value.split(/\n{2,}/u))
    .filter(Boolean);
  const sentences = paragraphs
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?。！？])\s*/u))
    .filter(Boolean);

  return {
    conceptCoverage: lexical.coverage,
    titleJointMatch: allMatch(document.title),
    abstractJointMatch: allMatch(document.abstract),
    sameSentenceCooccurrence: sentences.some(allMatch) ? 1 : 0,
    sameParagraphCooccurrence: paragraphs.some(allMatch) ? 1 : 0,
    allTagMatch: allMatch([...document.domainTags, ...document.modelTags].join(" ")),
    strictPathHit: paths.includes("exact") || paths.includes("strict"),
    vectorLexicalAgreement: paths.includes("vector") && lexical.coverage > 0 && semanticScore > 0,
  };
}

function buildMatchReason(paths: string[], lexical: LexicalRelevance): string {
  const parts: string[] = [];
  if (paths.includes("exact")) parts.push("标题精确匹配");
  else if (paths.includes("strict")) parts.push("关键词严格匹配");
  else if (paths.includes("broad")) parts.push("关键词宽松匹配");

  if (paths.includes("cjk")) parts.push("中文内容匹配");
  if (paths.includes("vector")) parts.push("语义相关");
  if (lexical.titleMatches > 0) parts.push(`标题命中 ${lexical.titleMatches} 个概念`);
  if (lexical.tagMatches > 0) parts.push("标签匹配");
  return parts.length > 0 ? parts.join(" · ") : "综合相关";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/g, "");
}
