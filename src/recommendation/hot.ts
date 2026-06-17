/**
 * Hot recommendation builder with time decay and source diversity.
 */

import { getAllDocuments } from "@/db/documents";
import {
  getLatestRecommendationSnapshotDate,
  getRecommendationSnapshot,
  pruneRecommendationSnapshots,
  saveRecommendationSnapshot,
} from "@/db/recommendations";
import { getFavorites, getHistory } from "@/db/user";
import type { Document, RecommendationEntry } from "@/types";

export interface HotRecommendationOptions {
  limit?: number;
  windowDays?: number;
  includeRead?: boolean;
  now?: Date;
}

export interface HotRecommendationResponse {
  entries: RecommendationEntry[];
  snapshotDate: string;
  cached: boolean;
}

export function buildHotRecommendations(
  options: HotRecommendationOptions = {},
): RecommendationEntry[] {
  const limit = Math.min(options.limit ?? 10, 100);
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 14;
  const includeRead = options.includeRead ?? true;
  const excludedIds = includeRead ? new Set<string>() : getExcludedDocumentIds();

  const candidates = collectWindowDocuments(now, windowDays)
    .filter((document) => !excludedIds.has(document.id))
    .map((document) => ({
      document,
      score: scoreHotDocument(document, now),
      reason: buildHotReason(document, now),
    }))
    .sort((left, right) => right.score - left.score);

  return diversifyBySource(candidates, limit);
}

export function getHotRecommendations(
  options: HotRecommendationOptions = {},
): HotRecommendationResponse {
  const limit = Math.min(options.limit ?? 10, 100);
  const snapshotDate = toDateKey(options.now ?? new Date());
  const cached = getRecommendationSnapshot({ kind: "hot", snapshotDate, limit });

  if (cached.length > 0) {
    return { entries: cached, snapshotDate, cached: true };
  }

  const fresh = refreshHotRecommendations(options);
  return { entries: fresh, snapshotDate, cached: false };
}

export function refreshHotRecommendations(
  options: HotRecommendationOptions = {},
): RecommendationEntry[] {
  const snapshotDate = toDateKey(options.now ?? new Date());
  const entries = buildHotRecommendations({
    ...options,
    limit: Math.max(options.limit ?? 10, 20),
  });

  saveRecommendationSnapshot("hot", snapshotDate, entries);
  pruneRecommendationSnapshots("hot", toDateKey(addDays(options.now ?? new Date(), -30)));

  return entries.slice(0, Math.min(options.limit ?? 10, 100));
}

export function getLatestHotSnapshot(limit = 10): HotRecommendationResponse {
  const snapshotDate = getLatestRecommendationSnapshotDate("hot");
  if (!snapshotDate) {
    return {
      entries: [],
      snapshotDate: toDateKey(new Date()),
      cached: false,
    };
  }

  return {
    entries: getRecommendationSnapshot({ kind: "hot", snapshotDate, limit }),
    snapshotDate,
    cached: true,
  };
}

function scoreHotDocument(document: Document, now: Date): number {
  const ageHours = Math.max(
    0,
    (now.getTime() - new Date(document.publishedAt).getTime()) / (1000 * 60 * 60),
  );
  const timeDecay = Math.pow(0.5, ageHours / 48);

  let freshnessBoost = 0;
  if (ageHours <= 24) {
    freshnessBoost = 1;
  } else if (ageHours <= 72) {
    freshnessBoost = 0.6;
  }

  const summaryBonus = document.isSummarized ? 1 : 0;
  return timeDecay * 0.75 + freshnessBoost * 0.15 + summaryBonus * 0.1;
}

function buildHotReason(document: Document, now: Date): RecommendationEntry["reason"] {
  const ageHours = Math.max(
    0,
    (now.getTime() - new Date(document.publishedAt).getTime()) / (1000 * 60 * 60),
  );
  const factors = ["time_decay"];

  if (ageHours <= 24) {
    factors.push("published_within_24h");
  } else if (ageHours <= 72) {
    factors.push("published_within_72h");
  }

  if (document.isSummarized) {
    factors.push("summary_ready");
  }

  return { kind: "hot", matchedTags: document.domainTags.slice(0, 3), factors };
}

function diversifyBySource(entries: RecommendationEntry[], limit: number): RecommendationEntry[] {
  const maxPerSource = Math.max(1, Math.ceil(limit / 2));
  const sourceCounts = new Map<string, number>();
  const selected: RecommendationEntry[] = [];
  const overflow: RecommendationEntry[] = [];

  for (const entry of entries) {
    const count = sourceCounts.get(entry.document.source) ?? 0;
    if (count < maxPerSource) {
      selected.push(entry);
      sourceCounts.set(entry.document.source, count + 1);
    } else {
      overflow.push(entry);
    }
  }

  for (const entry of overflow) {
    if (selected.length >= limit) {
      break;
    }
    selected.push(entry);
  }

  return selected.slice(0, limit);
}

function getExcludedDocumentIds(): Set<string> {
  const excluded = new Set<string>();

  for (const item of getHistory()) {
    excluded.add(item.documentId);
  }

  for (const item of getFavorites()) {
    excluded.add(item.documentId);
  }

  return excluded;
}

function collectWindowDocuments(now: Date, windowDays: number): Document[] {
  const from = isoDateTime(addDays(now, -windowDays));
  const batchSize = 200;
  const documents: Document[] = [];

  for (let offset = 0; ; offset += batchSize) {
    const batch = getAllDocuments({
      from,
      to: isoDateTime(now),
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDateTime(date: Date): string {
  return date.toISOString();
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
