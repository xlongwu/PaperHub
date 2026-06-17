/**
 * User memory extraction from historical digests.
 */

import fs from "node:fs";
import path from "node:path";
import { clearUserMemoryTerms, getUserMemoryTerms, upsertUserMemoryTerms } from "@/db/recommendations";
import { ARXIV_DOMAIN_MAP } from "@/tagger/arxiv-mapping";
import { extractModelTags } from "@/tagger/model-extract";
import type { MemoryCategory, MemoryTerm } from "@/types";

export interface MemoryExtractionOptions {
  maxDays?: number;
  maxTerms?: number;
  minTermsBeforeFallback?: number;
  useLlmFallback?: boolean;
  digestDir?: string;
  now?: Date;
}

interface TermAccumulator {
  term: string;
  category: MemoryCategory;
  weight: number;
  files: Set<string>;
}

interface DigestFile {
  path: string;
  basename: string;
  ageDays: number;
  content: string;
  fileWeight: number;
}

const DOMAIN_TERMS = [
  ...new Set(Object.values(ARXIV_DOMAIN_MAP).flat()),
  "Agents",
  "Planning",
  "Prompt Engineering",
  "RLHF",
  "Safety",
  "CLI",
  "Web",
];

const SOURCE_PATTERNS: Array<{ term: string; pattern: RegExp }> = [
  { term: "arxiv", pattern: /\barxiv\b/gi },
  { term: "gpt_blog", pattern: /\b(openai|gpt blog)\b/gi },
  { term: "claude_blog", pattern: /\b(anthropic|claude blog)\b/gi },
];

const TOPIC_BY_FILE_BASENAME: Record<string, string> = {
  "ai-agents": "Agents",
  "ai-cli": "CLI",
  "ai-web": "Web",
  "ai-community": "Community",
  "ai-trending": "Trending",
  "ai-hn": "Hacker News",
  "ai-ph": "Product Hunt",
  "ai-hf": "Hugging Face",
};

const FALLBACK_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "analysis",
  "anthropic",
  "article",
  "articles",
  "assistant",
  "blog",
  "blogs",
  "breaking",
  "build",
  "built",
  "community",
  "content",
  "daily",
  "digest",
  "engineering",
  "feature",
  "features",
  "github",
  "highlight",
  "highlights",
  "latest",
  "model",
  "models",
  "openai",
  "paper",
  "papers",
  "project",
  "projects",
  "prompt",
  "prompts",
  "recent",
  "report",
  "reports",
  "research",
  "summary",
  "today",
  "tool",
  "tools",
  "update",
  "updates",
  "weekly",
]);

export function extractMemoryFromDigests(
  options: MemoryExtractionOptions = {},
): MemoryTerm[] {
  const now = options.now ?? new Date();
  const digestDir = options.digestDir ?? path.resolve(process.cwd(), "digests");
  const maxDays = options.maxDays ?? 30;
  const maxTerms = options.maxTerms ?? 20;
  const minTermsBeforeFallback = options.minTermsBeforeFallback ?? 5;
  const accumulators = new Map<string, TermAccumulator>();
  const digestFiles = loadDigestFiles(digestDir, now, maxDays);

  for (const file of digestFiles) {
    extractDomainTerms(file.content, file.path, file.fileWeight, accumulators);
    extractModelTerms(file.content, file.path, file.fileWeight, accumulators);
    extractSourceTerms(file.content, file.path, file.fileWeight, accumulators);
    extractTopicTerms(file.basename, file.path, file.fileWeight, accumulators);
  }

  if (options.useLlmFallback && accumulators.size < minTermsBeforeFallback) {
    extractFallbackTopicTerms(digestFiles, accumulators, maxTerms);
  }

  return finalizeMemoryTerms(accumulators, maxTerms, now);
}

export function rebuildUserMemoryFromDigests(
  options: MemoryExtractionOptions = {},
): MemoryTerm[] {
  const terms = extractMemoryFromDigests(options);
  clearUserMemoryTerms("digest");
  upsertUserMemoryTerms(terms);
  return getUserMemoryTerms({ source: "digest", limit: options.maxTerms ?? 20 });
}

export { getUserMemoryTerms, clearUserMemoryTerms };

function loadDigestFiles(
  digestDir: string,
  now: Date,
  maxDays: number,
): DigestFile[] {
  return listRelevantDigestFiles(digestDir, now, maxDays)
    .map((file) => ({
      ...file,
      content: safeRead(file.path),
      fileWeight: getDigestWeight(file.basename, file.ageDays),
    }))
    .filter((file) => file.content.length > 0);
}

function listRelevantDigestFiles(
  digestDir: string,
  now: Date,
  maxDays: number,
): Array<{ path: string; basename: string; ageDays: number }> {
  if (!fs.existsSync(digestDir)) {
    return [];
  }

  const results: Array<{ path: string; basename: string; ageDays: number }> = [];
  for (const folder of fs.readdirSync(digestDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(folder)) {
      continue;
    }

    const folderDate = new Date(`${folder}T00:00:00Z`);
    const ageDays = (now.getTime() - folderDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 0 || ageDays > maxDays) {
      continue;
    }

    const folderPath = path.join(digestDir, folder);
    for (const basename of fs.readdirSync(folderPath)) {
      if (
        !/^ai-.*\.md$/.test(basename) ||
        basename.endsWith("-en.md") ||
        basename === "index.md"
      ) {
        continue;
      }

      results.push({
        path: path.join(folderPath, basename),
        basename: basename.replace(/\.md$/, ""),
        ageDays,
      });
    }
  }

  return results;
}

function extractDomainTerms(
  content: string,
  filePath: string,
  fileWeight: number,
  accumulators: Map<string, TermAccumulator>,
): void {
  for (const term of DOMAIN_TERMS) {
    const hits = countTerm(content, term);
    if (hits > 0) {
      addTerm(accumulators, {
        term,
        category: "domain",
        amount: Math.min(hits, 3) * fileWeight,
        filePath,
      });
    }
  }
}

function extractModelTerms(
  content: string,
  filePath: string,
  fileWeight: number,
  accumulators: Map<string, TermAccumulator>,
): void {
  for (const term of extractModelTags(content)) {
    addTerm(accumulators, {
      term,
      category: "model",
      amount: 1.5 * fileWeight,
      filePath,
    });
  }
}

function extractSourceTerms(
  content: string,
  filePath: string,
  fileWeight: number,
  accumulators: Map<string, TermAccumulator>,
): void {
  for (const source of SOURCE_PATTERNS) {
    const hits = countMatches(content, source.pattern);
    if (hits > 0) {
      addTerm(accumulators, {
        term: source.term,
        category: "source",
        amount: Math.min(hits, 3) * fileWeight,
        filePath,
      });
    }
  }
}

function extractTopicTerms(
  basename: string,
  filePath: string,
  fileWeight: number,
  accumulators: Map<string, TermAccumulator>,
): void {
  const topic = TOPIC_BY_FILE_BASENAME[basename];
  if (!topic) {
    return;
  }

  addTerm(accumulators, {
    term: topic,
    category: "topic",
    amount: fileWeight,
    filePath,
  });
}

function extractFallbackTopicTerms(
  digestFiles: DigestFile[],
  accumulators: Map<string, TermAccumulator>,
  maxTerms: number,
): void {
  const candidates = new Map<string, { term: string; amount: number; files: Set<string> }>();
  const existingTerms = new Set(
    [...accumulators.values()].map((entry) => `${entry.category}:${entry.term.toLowerCase()}`),
  );

  for (const file of digestFiles) {
    for (const token of tokenizeFallbackTerms(file.content)) {
      const key = `topic:${token.toLowerCase()}`;
      if (existingTerms.has(key)) {
        continue;
      }

      const existing = candidates.get(key);
      if (existing) {
        existing.amount += file.fileWeight;
        existing.files.add(file.path);
        continue;
      }

      candidates.set(key, {
        term: formatFallbackToken(token),
        amount: file.fileWeight,
        files: new Set([file.path]),
      });
    }
  }

  const availableSlots = Math.max(0, maxTerms - accumulators.size);
  if (availableSlots === 0) {
    return;
  }

  const ranked = [...candidates.values()]
    .sort(
      (left, right) =>
        right.files.size - left.files.size ||
        right.amount - left.amount ||
        left.term.localeCompare(right.term),
    )
    .slice(0, availableSlots);

  for (const candidate of ranked) {
    addTerm(accumulators, {
      term: candidate.term,
      category: "topic",
      amount: candidate.amount,
      filePath: [...candidate.files][0]!,
    });
  }
}

function finalizeMemoryTerms(
  accumulators: Map<string, TermAccumulator>,
  maxTerms: number,
  now: Date,
): MemoryTerm[] {
  const ranked = [...accumulators.values()]
    .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
    .slice(0, maxTerms);

  const maxWeight = ranked[0]?.weight ?? 1;
  return ranked.map((entry) => ({
    term: entry.term,
    category: entry.category,
    weight: Number((entry.weight / maxWeight).toFixed(4)),
    source: "digest",
    lastSeenAt: now.toISOString(),
    meta: {
      files: [...entry.files].sort(),
      rawWeight: Number(entry.weight.toFixed(4)),
      fileCount: entry.files.size,
    },
  }));
}

function getDigestWeight(basename: string, ageDays: number): number {
  let typeWeight = 1;
  if (basename.includes("weekly")) {
    typeWeight = 2.5;
  } else if (basename.includes("monthly")) {
    typeWeight = 3.5;
  }

  if (ageDays <= 7) {
    return typeWeight * 1.4;
  }

  if (ageDays <= 14) {
    return typeWeight * 1.1;
  }

  return typeWeight * 0.8;
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function tokenizeFallbackTerms(content: string): string[] {
  const matches = content.match(/\b[A-Za-z][A-Za-z0-9-]{3,}\b/g) ?? [];
  return matches.filter((token) => {
    const normalized = token.toLowerCase();
    if (FALLBACK_STOP_WORDS.has(normalized)) {
      return false;
    }

    return !DOMAIN_TERMS.some((term) => term.toLowerCase() === normalized);
  });
}

function formatFallbackToken(token: string): string {
  if (token.toUpperCase() === token) {
    return token;
  }

  return token[0]!.toUpperCase() + token.slice(1).toLowerCase();
}

function countTerm(content: string, term: string): number {
  const escaped = escapeRegExp(term);
  return countMatches(content, new RegExp(`\\b${escaped}\\b`, "gi"));
}

function countMatches(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addTerm(
  accumulators: Map<string, TermAccumulator>,
  input: { term: string; category: MemoryCategory; amount: number; filePath: string },
): void {
  const key = `${input.category}:${input.term}`;
  const existing = accumulators.get(key);

  if (existing) {
    existing.weight += input.amount;
    existing.files.add(input.filePath);
    return;
  }

  accumulators.set(key, {
    term: input.term,
    category: input.category,
    weight: input.amount,
    files: new Set([input.filePath]),
  });
}
