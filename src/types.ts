/**
 * PaperHub core types and interfaces.
 */

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export type DocumentSource = "arxiv" | "gpt_blog" | "claude_blog" | "web";
export type DocumentType = "paper" | "blog" | "tutorial" | "review";
export type DocumentLanguage = "zh" | "en";
export type SummaryLevel = "short" | "detailed";

export interface DocumentExternalIds {
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  pmid?: string;
}

export interface DocumentOrigin {
  sourceType:
    | "arxiv"
    | "journal"
    | "conference"
    | "official_blog"
    | "technical_article"
    | "documentation"
    | "repository"
    | "other";
  sourceName?: string;
  publisher?: string;
  venue?: string;
  domain?: string;
}

export interface DocumentDiscovery {
  discoveredVia: "collector" | "web_search" | "manual_import" | "mcp";
  providerId?: string;
  searchSessionId?: string;
  webResultId?: string;
}

export interface Document {
  id: string; // hash(source + url)
  title: string;
  source: DocumentSource;
  url: string;
  publishedAt: string; // ISO 8601
  authors: string[];
  abstract: string;
  fullText?: string;
  fullTextPath?: string; // local file path
  language: DocumentLanguage;
  externalIds?: DocumentExternalIds;
  canonicalUrl?: string;
  origin?: DocumentOrigin;
  discovery?: DocumentDiscovery;

  // tags
  domainTags: string[];
  sourceTag: string;
  typeTag: DocumentType;
  yearTag: number;
  modelTags: string[];

  // summaries
  summaryZh?: string;
  summaryEn?: string;
  summaryZhLevel?: SummaryLevel;
  summaryEnLevel?: SummaryLevel;

  // metadata
  createdAt: string;
  updatedAt: string;
  isSummarized: boolean;
}

// ---------------------------------------------------------------------------
// Raw document from collectors
// ---------------------------------------------------------------------------

export interface RawDocument {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  authors: string[];
  abstract: string;
  content?: string;
  language: DocumentLanguage;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

export interface ContentCollector {
  id: string;
  name: string;
  sourceTag: string;
  interval: number; // milliseconds
  fetch(): Promise<RawDocument[]>;
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

export interface UserPreferences {
  interestTags: string[];
  defaultLanguage: DocumentLanguage;
  summaryLength: SummaryLevel;
  dailyRecommendCount: number;
}

// ---------------------------------------------------------------------------
// Recommendation & memory
// ---------------------------------------------------------------------------

export type MemoryCategory = "domain" | "model" | "source" | "topic";
export type MemorySource = "digest" | "preference" | "history" | "favorite";
export type RecommendationKind = "hot" | "personalized";

export interface MemoryTerm {
  term: string;
  category: MemoryCategory;
  weight: number;
  source: MemorySource;
  lastSeenAt?: string;
  meta?: Record<string, unknown>;
}

export interface RecommendationReason {
  kind: RecommendationKind;
  matchedTags?: string[];
  factors: string[];
}

export interface RecommendationEntry {
  document: Document;
  score: number;
  reason: RecommendationReason;
}

export interface WeightedProfileTerm {
  term: string;
  category: MemoryCategory;
  weight: number;
  source: MemorySource;
}

export interface UserProfile {
  weightedTags: WeightedProfileTerm[];
  excludedDocumentIds: Set<string>;
}
