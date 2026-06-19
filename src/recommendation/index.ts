/**
 * Personalized recommendation orchestration.
 */

import { getAllDocuments } from "@/db/documents";
import { clearUserMemoryTerms, getUserMemoryTerms, saveRecommendationSnapshot } from "@/db/recommendations";
import { extractMemoryFromDigests, rebuildUserMemoryFromDigests } from "@/recommendation/memory";
import { buildUserProfile } from "@/recommendation/profile";
import {
  buildHotRecommendations,
  getHotRecommendations,
  refreshHotRecommendations,
} from "@/recommendation/hot";
import type { Document, MemoryTerm, RecommendationEntry, WeightedProfileTerm } from "@/types";

export interface PersonalizedRecommendationOptions {
  limit?: number;
  windowDays?: number;
  includeRead?: boolean;
  now?: Date;
}

export interface RecommendationBundle {
  hot: RecommendationEntry[];
  personalized: RecommendationEntry[];
  memory: MemoryTerm[];
}

export {
  buildHotRecommendations,
  getHotRecommendations,
  refreshHotRecommendations,
  extractMemoryFromDigests,
  rebuildUserMemoryFromDigests,
  getUserMemoryTerms,
  clearUserMemoryTerms,
};

export async function buildPersonalizedRecommendations(
  options: PersonalizedRecommendationOptions = {},
): Promise<RecommendationEntry[]> {
  const limit = Math.min(options.limit ?? 10, 100);
  const now = options.now ?? new Date();
  const includeRead = options.includeRead ?? false;
  const profile = buildUserProfile({ includeRead });
  const candidateWindowDays = options.windowDays ?? 30;
  const candidates = collectCandidateDocuments(now, candidateWindowDays);
  let scored = scoreCandidates(
    candidates,
    profile.weightedTags,
    profile.excludedDocumentIds,
    includeRead,
    now,
  );

  if (scored.length < limit && candidateWindowDays < 90) {
    const fallbackCandidates = collectCandidateDocuments(now, 90);
    scored = scoreCandidates(
      fallbackCandidates,
      profile.weightedTags,
      profile.excludedDocumentIds,
      includeRead,
      now,
    );
  }

  const top = scored.slice(0, limit);
  saveRecommendationSnapshot("personalized", toDateKey(now), top);
  return top;
}

export async function rebuildMemoryAndPersonalizedRecommendations(
  options: PersonalizedRecommendationOptions = {},
): Promise<RecommendationBundle> {
  const memory = rebuildUserMemoryFromDigests({
    now: options.now,
    maxDays: 30,
  });
  const personalized = await buildPersonalizedRecommendations(options);
  const hot = refreshHotRecommendations({
    limit: options.limit ?? 10,
    windowDays: 14,
    includeRead: true,
    now: options.now,
  });

  return { hot, personalized, memory };
}

export function getCurrentMemory(): MemoryTerm[] {
  return getUserMemoryTerms({ source: "digest", limit: 30 });
}

function scoreDocument(
  document: Document,
  weightedTags: WeightedProfileTerm[],
  now: Date,
): RecommendationEntry {
  const tagSignals = weightedTags
    .map((tag) => scoreTagMatch(document, tag))
    .filter((signal) => signal.score > 0);

  const profileMatchScore = normalizeScore(tagSignals.reduce((sum, signal) => sum + signal.score, 0));
  const recencyScore = calculateRecencyScore(document.publishedAt, now);
  const sourceBonus = calculateSourceBonus(document, weightedTags);
  const summaryBonus = document.isSummarized ? 1 : 0;

  const finalScore =
    profileMatchScore * 0.65 + recencyScore * 0.25 + sourceBonus * 0.05 + summaryBonus * 0.05;

  return {
    document,
    score: Number(finalScore.toFixed(4)),
    reason: {
      kind: "personalized",
      matchedTags: unique([...tagSignals.flatMap((signal) => signal.matchedTags)]),
      factors: buildFactors(tagSignals, recencyScore, sourceBonus, summaryBonus),
    },
  };
}

function scoreTagMatch(
  document: Document,
  tag: WeightedProfileTerm,
): { score: number; matchedTags: string[] } {
  const { category, term, weight } = tag;
  const matchedTags: string[] = [];
  let score = 0;
  const lower = term.toLowerCase();

  if (category === "domain" || category === "topic") {
    for (const domainTag of document.domainTags) {
      if (domainTag.toLowerCase() === lower) {
        matchedTags.push(domainTag);
        score += weight * (category === "domain" ? 1 : 0.65);
      }
    }
  }

  if (category === "model" || category === "topic") {
    for (const modelTag of document.modelTags) {
      if (modelTag.toLowerCase() === lower) {
        matchedTags.push(modelTag);
        score += weight * (category === "model" ? 0.85 : 0.5);
      }
    }
  }

  if (category === "source" || category === "topic") {
    if (document.source.toLowerCase() === lower || document.sourceTag.toLowerCase() === lower) {
      matchedTags.push(document.sourceTag);
      score += weight * (category === "source" ? 0.5 : 0.35);
    }
  }

  if (category === "topic" && documentMatchesTopic(document, term)) {
    matchedTags.push(term);
    score += weight * 0.45;
  }

  return { score, matchedTags: unique(matchedTags) };
}

function calculateRecencyScore(publishedAt: string, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3600000);
  return Math.pow(0.5, ageHours / 168);
}

function calculateSourceBonus(document: Document, weightedTags: WeightedProfileTerm[]): number {
  const preferredSources = new Set(
    weightedTags.filter((tag) => tag.category === "source").map((tag) => tag.term.toLowerCase()),
  );

  if (preferredSources.has(document.source.toLowerCase())) {
    return 1;
  }

  if (preferredSources.has(document.sourceTag.toLowerCase())) {
    return 1;
  }

  return 0;
}

function buildFactors(
  signals: Array<{ matchedTags: string[] }>,
  recencyScore: number,
  sourceBonus: number,
  summaryBonus: number,
): string[] {
  const factors: string[] = [];
  for (const signal of signals) {
    for (const tag of signal.matchedTags) {
      factors.push(`match:${tag}`);
    }
  }

  if (recencyScore > 0.7) {
    factors.push("recently_published");
  }
  if (sourceBonus > 0) {
    factors.push("preferred_source");
  }
  if (summaryBonus > 0) {
    factors.push("summary_ready");
  }

  return unique(factors);
}

function normalizeScore(score: number): number {
  return Math.max(0, Math.min(1, score / 4));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function scoreCandidates(
  documents: Document[],
  weightedTags: WeightedProfileTerm[],
  excludedDocumentIds: Set<string>,
  includeRead: boolean,
  now: Date,
): RecommendationEntry[] {
  return documents
    .filter((document) => includeRead || !excludedDocumentIds.has(document.id))
    .map((document) => scoreDocument(document, weightedTags, now))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
}

function collectCandidateDocuments(now: Date, windowDays: number): Document[] {
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = 200;
  const documents: Document[] = [];

  for (let offset = 0; ; offset += batchSize) {
    const batch = getAllDocuments({
      from,
      to: now.toISOString(),
      limit: batchSize,
      offset,
    });
    documents.push(...batch);

    if (batch.length < batchSize) {
      break;
    }
  }

  return documents;
}

function documentMatchesTopic(document: Document, term: string): boolean {
  const haystack = [
    document.title,
    document.abstract,
    document.sourceTag,
    document.source,
    ...document.domainTags,
  ].join(" ");

  return containsTerm(haystack, term);
}

function containsTerm(content: string, term: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
