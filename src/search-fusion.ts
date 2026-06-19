/**
 * Reciprocal Rank Fusion and deterministic feature re-ranking.
 */

import { scoreDocumentAgainstQuery } from "@/search-query";
import type { SearchQueryAnalysis, LexicalRelevance } from "@/search-query";
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
    const featureScore = computeFeatureScore(
      entry.doc,
      queryAnalysis,
      lexical,
      entry.paths,
      entry.semanticScore,
    );

    const result = {
      document: entry.doc,
      rrfScore,
      featureScore,
      finalScore: rrfScore * 0.65 + featureScore * 0.35,
      lexical,
      paths: entry.paths,
      matchReason: buildMatchReason(entry.paths, lexical),
    };

    if (passesRecallQualityFloor(result, queryAnalysis)) {
      fused.push(result);
    }
  }

  return fused.sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      b.document.publishedAt.localeCompare(a.document.publishedAt) ||
      a.document.id.localeCompare(b.document.id),
  );
}

function passesRecallQualityFloor(result: FusionResult, analysis: SearchQueryAnalysis): boolean {
  const conceptCount = analysis.concepts.length;
  if (conceptCount <= 1) return true;

  if (result.paths.includes("vector") || result.paths.includes("exact") || result.paths.includes("strict")) {
    return true;
  }

  const requiredMatches = conceptCount === 2 ? 2 : Math.ceil(conceptCount * 0.66);
  return result.lexical.matchedConcepts >= requiredMatches;
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
