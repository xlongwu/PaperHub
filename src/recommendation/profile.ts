/**
 * User profile builder for personalized recommendations.
 */

import { getDocumentById } from "@/db/documents";
import { getUserMemoryTerms } from "@/db/recommendations";
import { getFavorites, getHistory, getUserPreference } from "@/db/user";
import type { Document, UserProfile, WeightedProfileTerm } from "@/types";

export interface BuildUserProfileOptions {
  includeRead?: boolean;
}

export function buildUserProfile(options: BuildUserProfileOptions = {}): UserProfile {
  const includeRead = options.includeRead ?? false;
  const weightedTerms = new Map<string, WeightedProfileTerm>();
  const excludedDocumentIds = new Set<string>();

  for (const interestTag of getInterestTags()) {
    addWeightedTerm(weightedTerms, {
      term: interestTag,
      category: "domain",
      weight: 1,
      source: "preference",
    });
  }

  for (const term of getUserMemoryTerms({ source: "digest", limit: 30 })) {
    addWeightedTerm(weightedTerms, {
      term: term.term,
      category: term.category,
      weight: term.weight * 0.7,
      source: "digest",
    });
  }

  const favoriteDocs = getFavorites()
    .map((item) => getDocumentById(item.documentId))
    .filter(Boolean) as Document[];
  for (const doc of favoriteDocs) {
    accumulateDocumentSignal(weightedTerms, doc, "favorite", 0.85);
    excludedDocumentIds.add(doc.id);
  }

  const historyDocs = getHistory()
    .map((item, index) => ({
      document: getDocumentById(item.documentId),
      weight: index < 5 ? 0.6 : 0.35,
    }))
    .filter((item): item is { document: Document; weight: number } => Boolean(item.document));

  for (const item of historyDocs) {
    accumulateDocumentSignal(weightedTerms, item.document, "history", item.weight);
    excludedDocumentIds.add(item.document.id);
  }

  return {
    weightedTags: [...weightedTerms.values()].sort(
      (left, right) => right.weight - left.weight || left.term.localeCompare(right.term),
    ),
    excludedDocumentIds: includeRead ? new Set<string>() : excludedDocumentIds,
  };
}

function getInterestTags(): string[] {
  const raw = getUserPreference("interest_tags");
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as string[];
    return parsed.filter((item) => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function accumulateDocumentSignal(
  weightedTerms: Map<string, WeightedProfileTerm>,
  document: Document,
  source: WeightedProfileTerm["source"],
  baseWeight: number,
): void {
  for (const tag of document.domainTags) {
    addWeightedTerm(weightedTerms, {
      term: tag,
      category: "domain",
      weight: baseWeight,
      source,
    });
  }

  for (const tag of document.modelTags) {
    addWeightedTerm(weightedTerms, {
      term: tag,
      category: "model",
      weight: baseWeight * 0.8,
      source,
    });
  }

  addWeightedTerm(weightedTerms, {
    term: document.source,
    category: "source",
    weight: baseWeight * 0.5,
    source,
  });
}

function addWeightedTerm(weightedTerms: Map<string, WeightedProfileTerm>, term: WeightedProfileTerm): void {
  const key = `${term.category}:${term.term}`;
  const existing = weightedTerms.get(key);

  if (existing) {
    existing.weight += term.weight;
    return;
  }

  weightedTerms.set(key, { ...term });
}
