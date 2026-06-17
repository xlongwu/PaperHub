/**
 * Deduplication utilities — URL exact match + title similarity.
 */

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows for O(n) space
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ---------------------------------------------------------------------------
// Similarity check
// ---------------------------------------------------------------------------

export function isSimilarTitle(a: string, b: string, threshold = 0.3): boolean {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);

  if (normalizedA === normalizedB) return true;

  const maxLen = Math.max(normalizedA.length, normalizedB.length);
  if (maxLen === 0) return true;

  const distance = levenshteinDistance(normalizedA, normalizedB);
  return distance / maxLen < threshold;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Batch dedup against existing DB titles
// ---------------------------------------------------------------------------

import { getAllDocuments } from "@/db/documents";

export function findDuplicateByTitle(title: string): { id: string; title: string } | null {
  const docs = getAllDocuments();
  for (const doc of docs) {
    if (isSimilarTitle(title, doc.title)) {
      return { id: doc.id, title: doc.title };
    }
  }
  return null;
}
