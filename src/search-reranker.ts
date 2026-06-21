import { getConceptMatchEvidence } from "@/search-query";
import type { SearchQueryPlan } from "@/search-contract";
import type { FusionResult } from "@/search-fusion";

export type SearchRerankerProviderName = "off" | "local";

export interface SearchRerankerInput {
  queryPlan: SearchQueryPlan;
  candidates: FusionResult[];
}

export interface SearchRerankerResult {
  documentId: string;
  score: number;
}

export interface SearchRerankerProvider {
  readonly name: Exclude<SearchRerankerProviderName, "off">;
  rerank(input: SearchRerankerInput): Promise<SearchRerankerResult[]>;
}

export interface SearchRerankerMetadata {
  provider: SearchRerankerProviderName;
  topK: number;
  latencyMs: number;
  changedRanks: number;
}

export interface RerankedCandidate {
  candidate: FusionResult;
  rerankerScore?: number;
}

export async function rerankSearchCandidates(
  candidates: FusionResult[],
  queryPlan: SearchQueryPlan,
): Promise<{
  candidates: RerankedCandidate[];
  metadata: SearchRerankerMetadata;
}> {
  const providerName = resolveProviderName();
  const topK = resolveTopK(candidates.length);
  if (providerName === "off" || topK === 0) {
    return {
      candidates: candidates.map((candidate) => ({ candidate })),
      metadata: { provider: "off", topK: 0, latencyMs: 0, changedRanks: 0 },
    };
  }

  const provider = new LocalFeatureReranker();
  const startedAt = performance.now();
  try {
    const head = candidates.slice(0, topK);
    const scores = await provider.rerank({ queryPlan, candidates: head });
    const scoreById = new Map(scores.map((result) => [result.documentId, result.score]));
    const rerankedHead = head
      .map((candidate, originalRank) => ({
        candidate,
        originalRank,
        rerankerScore: scoreById.get(candidate.document.id) ?? candidate.finalScore,
      }))
      .sort(
        (left, right) => right.rerankerScore - left.rerankerScore || left.originalRank - right.originalRank,
      );
    const changedRanks = rerankedHead.filter(
      (entry, index) => entry.candidate.document.id !== head[index]?.document.id,
    ).length;

    return {
      candidates: [
        ...rerankedHead.map(({ candidate, rerankerScore }) => ({
          candidate,
          rerankerScore,
        })),
        ...candidates.slice(topK).map((candidate) => ({ candidate })),
      ],
      metadata: {
        provider: provider.name,
        topK,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        changedRanks,
      },
    };
  } catch (error) {
    console.warn(
      `[search-reranker] Local reranking failed; using deterministic base ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      candidates: candidates.map((candidate) => ({ candidate })),
      metadata: {
        provider: "off",
        topK: 0,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        changedRanks: 0,
      },
    };
  }
}

class LocalFeatureReranker implements SearchRerankerProvider {
  readonly name = "local" as const;

  async rerank(input: SearchRerankerInput): Promise<SearchRerankerResult[]> {
    return input.candidates.map((candidate) => {
      const mustCoverage = getConceptMatchEvidence(
        candidate.document,
        input.queryPlan.concepts.must,
      ).coverage;
      const shouldCoverage = getConceptMatchEvidence(
        candidate.document,
        input.queryPlan.concepts.should,
      ).coverage;
      const jointEvidence =
        (candidate.joint.titleJointMatch ? 0.3 : 0) +
        (candidate.joint.abstractJointMatch ? 0.2 : 0) +
        candidate.joint.sameSentenceCooccurrence * 0.25 +
        candidate.joint.sameParagraphCooccurrence * 0.1 +
        (candidate.joint.vectorLexicalAgreement ? 0.1 : 0) +
        (candidate.joint.allTagMatch ? 0.05 : 0);
      const structuredScore = Math.min(1, mustCoverage * 0.45 + shouldCoverage * 0.15 + jointEvidence * 0.4);
      return {
        documentId: candidate.document.id,
        score: candidate.finalScore * 0.6 + structuredScore * 0.4,
      };
    });
  }
}

function resolveProviderName(): SearchRerankerProviderName {
  const configured = process.env["PAPERHUB_RERANKER"]?.trim().toLocaleLowerCase();
  return configured === "off" || configured === "false" || configured === "0" ? "off" : "local";
}

function resolveTopK(candidateCount: number): number {
  const configured = Number(process.env["PAPERHUB_RERANK_TOP_K"] ?? 50);
  const topK = Number.isSafeInteger(configured) ? configured : 50;
  return Math.min(candidateCount, Math.max(0, Math.min(topK, 100)));
}
