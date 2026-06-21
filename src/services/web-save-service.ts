import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/config";
import {
  findDocumentByCanonicalUrl,
  findDocumentByExternalIds,
  findDocumentByTitleAuthorYear,
  getDocumentById,
  updateDocument,
} from "@/db/documents";
import {
  appendWebSearchEvent,
  getSavedWebSearchResult,
  getWebSearchResult,
  getWebSearchSession,
  updateWebSearchResultLocalState,
  upsertSavedWebSearchResult,
} from "@/db/web-search";
import { addFavorite, isFavorite } from "@/db/user";
import { recordWebSearchUsageEvent } from "@/db/web-search-metrics";
import { ingestSingleDocument } from "@/services/document-ingestion";
import { summarizeDocument } from "@/summarizer";
import { extractHtmlContent } from "@/web-search/content-extractor";
import { extractPdfText } from "@/web-search/pdf-text";
import { safeFetch, type SafeFetchOptions } from "@/web-search/safe-fetch";
import type {
  WebSaveMode,
  WebSaveRequest,
  WebSaveResponse,
  WebSearchResult,
} from "@/web-search/types";
import type {
  Document,
  DocumentOrigin,
  DocumentSource,
  RawDocument,
} from "@/types";

const PDF_MAX_BYTES = 30 * 1024 * 1024;

interface WebSaveDependencies {
  safeFetchOptions?: SafeFetchOptions;
  dataDir?: string;
  summarize?: typeof summarizeDocument;
}

interface PreparedContent {
  text?: string;
  canonicalUrl?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  pdfBody?: Uint8Array;
  pdfSourceUrl?: string;
}

export async function saveWebSearchResult(
  sessionId: string,
  resultId: string,
  request: WebSaveRequest,
  dependencies: WebSaveDependencies = {},
): Promise<WebSaveResponse> {
  const session = getWebSearchSession(sessionId);
  if (!session || session.status === "expired") {
    throw new WebSaveError("session", "Web Search session was not found or has expired.");
  }
  const result = getWebSearchResult(sessionId, resultId);
  if (!result) throw new WebSaveError("result", "Web Search result was not found.");

  const previous = getSavedWebSearchResult(sessionId, resultId);
  const previousDocument = previous ? getDocumentById(previous.documentId) : null;
  updateWebSearchResultLocalState(sessionId, resultId, {
    ...result.localState,
    status: "saving",
    documentId: previousDocument?.id,
  });
  appendWebSearchEvent(sessionId, "result.save.started", {
    resultId,
    mode: request.mode,
  });

  try {
    const prepared =
      request.mode === "metadata_only"
        ? {}
        : await prepareContent(result, request.mode, dependencies.safeFetchOptions);
    const duplicate = previousDocument ?? findExistingDocument(result, prepared.canonicalUrl);
    const raw = toRawDocument(result, prepared, sessionId);
    let documentId: string;
    let status: WebSaveResponse["status"];

    if (duplicate) {
      documentId = duplicate.id;
      status = await enrichExistingDocument(duplicate, raw, prepared) ? "updated" : "duplicate";
    } else {
      const ingestion = await ingestSingleDocument(raw);
      if (ingestion.status === "error" || !ingestion.documentId) {
        throw new WebSaveError("ingestion", ingestion.error ?? "Document ingestion failed.");
      }
      documentId = ingestion.documentId;
      status = ingestion.status;
    }

    let hasDownloadedFile = Boolean(getDocumentById(documentId)?.fullTextPath);
    if (prepared.pdfBody) {
      const fullTextPath = persistPdf(
        documentId,
        prepared.pdfBody,
        dependencies.dataDir ?? getDataDir(),
      );
      updateDocument(documentId, {
        fullTextPath,
        fullText: prepared.text || getDocumentById(documentId)?.fullText,
      });
      hasDownloadedFile = true;
    }

    upsertSavedWebSearchResult({
      sessionId,
      resultId,
      documentId,
      saveMode: request.mode,
      pdfSourceUrl: prepared.pdfSourceUrl,
    });
    if (request.favorite) {
      try {
        addFavorite(documentId);
      } catch (error) {
        updateWebSearchResultLocalState(sessionId, resultId, {
          status: "saved",
          documentId,
          isFavorite: false,
          hasDownloadedFile,
        });
        throw new WebSaveError(
          "favorite",
          error instanceof Error ? error.message : "Favorite could not be added.",
        );
      }
    }
    const favorite = isFavorite(documentId);
    updateWebSearchResultLocalState(sessionId, resultId, {
      status: "saved",
      documentId,
      isFavorite: favorite,
      hasDownloadedFile,
    });
    appendWebSearchEvent(sessionId, "result.save.completed", {
      resultId,
      documentId,
      mode: request.mode,
      status,
      favorite,
      hasDownloadedFile,
    });
    recordWebSearchUsageEvent({
      sessionId,
      eventType: "save",
      metadata: { mode: request.mode },
    });
    if (favorite) {
      recordWebSearchUsageEvent({ sessionId, eventType: "favorite" });
    }
    if (request.mode === "download_pdf") {
      recordWebSearchUsageEvent({ sessionId, eventType: "pdf_download" });
    }

    const summaryQueued = request.generateSummary === true;
    if (summaryQueued) {
      queueMicrotask(() => {
        const document = getDocumentById(documentId);
        if (!document) return;
        void (dependencies.summarize ?? summarizeDocument)(document).catch(() => {
          console.error(`[web-save] summary failed for ${documentId}`);
        });
      });
    }

    return {
      sessionId,
      resultId,
      documentId,
      status,
      mode: request.mode,
      favorite,
      hasDownloadedFile,
      summaryQueued,
    };
  } catch (error) {
    const failure =
      error instanceof WebSaveError
        ? error
        : new WebSaveError(
            request.mode === "download_pdf" ? "pdf_download" : "content_fetch",
            error instanceof Error ? error.message : "Web result save failed.",
          );
    if (failure.stage !== "favorite") {
      updateWebSearchResultLocalState(sessionId, resultId, {
        ...result.localState,
        status: "save_failed",
      });
    }
    appendWebSearchEvent(sessionId, "result.save.failed", {
      resultId,
      stage: failure.stage,
      error: failure.message,
    });
    recordWebSearchUsageEvent({
      sessionId,
      eventType: request.mode === "download_pdf" ? "pdf_download" : "save",
      success: false,
      metadata: { stage: failure.stage },
    });
    throw failure;
  }
}

export class WebSaveError extends Error {
  constructor(
    public readonly stage:
      | "session"
      | "result"
      | "content_fetch"
      | "pdf_download"
      | "ingestion"
      | "favorite",
    message: string,
  ) {
    super(message);
  }
}

export function cleanupTemporaryPdfFiles(
  dataDir = getDataDir(),
  now = Date.now(),
): number {
  const directory = path.join(dataDir, "pdfs");
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const filePath = path.join(directory, entry.name);
    if (now - fs.statSync(filePath).mtimeMs < 24 * 60 * 60 * 1000) continue;
    fs.unlinkSync(filePath);
    removed++;
  }
  return removed;
}

async function prepareContent(
  result: WebSearchResult,
  mode: Exclude<WebSaveMode, "metadata_only">,
  safeFetchOptions?: SafeFetchOptions,
): Promise<PreparedContent> {
  const url = mode === "download_pdf" ? resolvePdfUrl(result) : result.url;
  const fetched = await safeFetch(url, {
    ...safeFetchOptions,
    maxBytes: mode === "download_pdf" ? PDF_MAX_BYTES : safeFetchOptions?.maxBytes,
    allowedContentTypes:
      mode === "download_pdf"
        ? new Set(["application/pdf"])
        : safeFetchOptions?.allowedContentTypes,
  });
  if (mode === "download_pdf") {
    if (fetched.contentType !== "application/pdf") {
      throw new WebSaveError("pdf_download", "The selected result did not return a PDF.");
    }
    return {
      text: extractPdfText(fetched.body) || undefined,
      pdfBody: fetched.body,
      pdfSourceUrl: fetched.finalUrl,
    };
  }
  if (fetched.contentType === "application/pdf") {
    return { text: extractPdfText(fetched.body) || undefined };
  }
  const extracted = extractHtmlContent(
    new TextDecoder().decode(fetched.body),
    fetched.finalUrl,
  );
  return {
    text: extracted.text || undefined,
    canonicalUrl: extracted.canonicalUrl ?? fetched.finalUrl,
    title: extracted.title,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
  };
}

function findExistingDocument(
  result: WebSearchResult,
  fetchedCanonicalUrl?: string,
): Document | null {
  return (
    findDocumentByExternalIds(result.identifiers) ??
    findDocumentByCanonicalUrl(
      normalizeCanonicalUrl(fetchedCanonicalUrl ?? result.canonicalUrl ?? result.url),
    ) ??
    findDocumentByTitleAuthorYear({
      title: result.title,
      firstAuthor: result.authors[0],
      year: result.publishedAt ? new Date(result.publishedAt).getUTCFullYear() : undefined,
    })
  );
}

function toRawDocument(
  result: WebSearchResult,
  prepared: PreparedContent,
  sessionId: string,
): RawDocument {
  const source = inferDocumentSource(result);
  const canonicalUrl = normalizeCanonicalUrl(
    prepared.canonicalUrl ?? result.canonicalUrl ?? result.url,
  );
  return {
    title: prepared.title ?? result.title,
    source,
    url: canonicalUrl,
    publishedAt:
      prepared.publishedAt ??
      result.publishedAt ??
      new Date().toISOString(),
    authors:
      result.authors.length > 0
        ? result.authors
        : prepared.author
          ? [prepared.author]
          : [],
    abstract: result.abstract ?? result.snippet ?? "",
    content: prepared.text,
    language: result.language === "zh" ? "zh" : "en",
    metadata: {
      contentType: result.contentType,
      externalIds: normalizeExternalIds(result.identifiers),
      canonicalUrl,
      origin: toDocumentOrigin(result),
      discovery: {
        discoveredVia: "web_search",
        providerId: result.providerEvidence[0]?.providerId,
        searchSessionId: sessionId,
        webResultId: result.id,
      },
      categories: arrayValue(result.metadata?.categories),
      pdfUrl: prepared.pdfSourceUrl ?? stringValue(result.metadata?.pdfUrl),
    },
  };
}

async function enrichExistingDocument(
  existing: Document,
  raw: RawDocument,
  prepared: PreparedContent,
): Promise<boolean> {
  const updates: Partial<Document> = {};
  if (prepared.text && prepared.text !== existing.fullText) updates.fullText = prepared.text;
  if (!existing.abstract && raw.abstract) updates.abstract = raw.abstract;
  if (!existing.externalIds) {
    updates.externalIds = raw.metadata?.externalIds as Document["externalIds"];
  }
  if (!existing.canonicalUrl) updates.canonicalUrl = stringValue(raw.metadata?.canonicalUrl);
  if (!existing.origin) updates.origin = raw.metadata?.origin as Document["origin"];
  if (!existing.discovery) updates.discovery = raw.metadata?.discovery as Document["discovery"];
  if (Object.keys(updates).length === 0) return false;
  updateDocument(existing.id, updates);
  return true;
}

function persistPdf(documentId: string, body: Uint8Array, dataDir: string): string {
  const directory = path.join(dataDir, "pdfs");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${documentId}.pdf`);
  fs.writeFileSync(target, body);
  return target;
}

function resolvePdfUrl(result: WebSearchResult): string {
  const pdfUrl = stringValue(result.metadata?.pdfUrl);
  if (pdfUrl) return pdfUrl;
  if (/\.pdf(?:$|[?#])/i.test(result.url)) return result.url;
  if (result.identifiers.arxivId) {
    return `https://arxiv.org/pdf/${result.identifiers.arxivId}`;
  }
  throw new WebSaveError("pdf_download", "No PDF URL is available for this result.");
}

function inferDocumentSource(result: WebSearchResult): DocumentSource {
  if (result.identifiers.arxivId || result.origin.domain === "arxiv.org") return "arxiv";
  if (/openai\.com$/i.test(result.origin.domain)) return "gpt_blog";
  if (/anthropic\.com$/i.test(result.origin.domain)) return "claude_blog";
  return "web";
}

function toDocumentOrigin(result: WebSearchResult): DocumentOrigin {
  const sourceType =
    result.identifiers.arxivId || result.origin.domain === "arxiv.org"
      ? "arxiv"
      : result.contentType === "paper"
        ? result.origin.venue
          ? "journal"
          : "other"
        : result.contentType;
  return {
    sourceType,
    sourceName: result.origin.sourceName,
    publisher: result.origin.publisher,
    venue: result.origin.venue,
    domain: result.origin.domain,
  };
}

function normalizeExternalIds(
  ids: WebSearchResult["identifiers"],
): WebSearchResult["identifiers"] {
  return {
    doi: ids.doi
      ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .toLowerCase(),
    arxivId: ids.arxivId?.replace(/^arxiv:/i, "").replace(/v\d+$/i, ""),
    openAlexId: ids.openAlexId?.replace(/^https?:\/\/openalex\.org\//i, ""),
    pmid: ids.pmid,
  };
}

function normalizeCanonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}
