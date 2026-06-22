import { SEARCH_UI } from "@/i18n";
import type { WebSaveMode, WebSearchResult, WebSearchSummary } from "@/web-search/types";
import { recordWebSearchResultOpen } from "./lib/api";

type UiLanguage = keyof typeof SEARCH_UI.webSearchTab;

export interface WebResultCardProps {
  language: UiLanguage;
  result: WebSearchResult;
  resultSummary?: WebSearchSummary;
  resultSummaryError?: unknown;
  resultSummaryPending: boolean;
  saveError?: unknown;
  savePending: boolean;
  onSave: (input: { mode: WebSaveMode; favorite?: boolean }) => void;
  onSummarize: () => void;
}

export function WebResultCard({
  language,
  result,
  resultSummary,
  resultSummaryError,
  resultSummaryPending,
  saveError,
  savePending,
  onSave,
  onSummarize,
}: WebResultCardProps): JSX.Element {
  const providerNames = result.providerEvidence.map((evidence) => evidence.providerId).join(", ");
  const localStatus = describeLocalState(result);
  return (
    <article className="paper-card web-result-card">
      <div className="paper-meta-row">
        <span>{result.origin.sourceName ?? result.origin.domain}</span>
        <span>{result.contentType}</span>
        <span>{result.publishedAt?.slice(0, 10) ?? "Date unavailable"}</span>
      </div>
      <a
        href={result.url}
        onClick={() => {
          void recordWebSearchResultOpen(result.sessionId, result.id).catch(() => undefined);
        }}
        rel="noreferrer"
        target="_blank"
      >
        <h3 className="paper-title">{result.title}</h3>
      </a>
      <p className="empty-description">{result.authors.join(", ") || "Authors unavailable"}</p>
      <p>{result.abstract ?? result.snippet ?? "No abstract returned."}</p>
      <div className="chip-row">
        <span className={`chip ${result.localState.status === "saved" ? "chip-success" : ""}`}>
          {localStatus}
        </span>
        {result.localState.isFavorite ? <span className="chip">Favorite</span> : null}
        {result.localState.hasDownloadedFile ? <span className="chip">PDF downloaded</span> : null}
        {result.identifiers.arxivId ? <span className="chip">arXiv:{result.identifiers.arxivId}</span> : null}
        {result.identifiers.doi ? <span className="chip">DOI:{result.identifiers.doi}</span> : null}
      </div>

      <details className="web-result-details">
        <summary>Evidence and ranking</summary>
        <div className="empty-block compact-block">
          <p className="empty-title">
            Providers: {providerNames || "unknown"} · score{" "}
            {result.ranking.aggregateScore.toFixed(2)}
          </p>
          <p className="empty-description">
            Concept coverage {Math.round(result.ranking.conceptCoverageScore * 100)}% · freshness{" "}
            {Math.round(result.ranking.freshnessScore * 100)}% · source quality{" "}
            {Math.round(result.ranking.sourceQualityScore * 100)}
            %{result.ranking.sourceQualityTier ? ` · tier ${result.ranking.sourceQualityTier}` : ""}
          </p>
          {result.ranking.sortExplanation?.length ? (
            <p className="empty-description">
              Sort: {result.ranking.sortExplanation.join(" · ")}
            </p>
          ) : null}
          {result.match.matchedConcepts.length > 0 ? (
            <p className="empty-description">Matched: {result.match.matchedConcepts.join(", ")}</p>
          ) : null}
          {(result.match.matchedShouldConcepts?.length ?? 0) > 0 ? (
            <p className="empty-description">
              Should matched: {result.match.matchedShouldConcepts?.join(", ")}
            </p>
          ) : null}
          {result.match.missingMustConcepts.length > 0 ? (
            <p className="empty-description">
              Missing must concepts: {result.match.missingMustConcepts.join(", ")}
            </p>
          ) : null}
          {(result.match.excludedConcepts?.length ?? 0) > 0 ? (
            <p className="empty-description">
              Excluded concepts: {result.match.excludedConcepts?.join(", ")}
            </p>
          ) : null}
          {result.providerEvidence.length > 0 ? (
            <ul className="evidence-list">
              {result.providerEvidence.map((evidence) => (
                <li key={`${evidence.providerId}:${evidence.providerResultId ?? evidence.originalUrl}`}>
                  {evidence.providerId} rank #{evidence.providerRank} · {evidence.originalUrl}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>

      <div className="web-result-actions">
        <button
          className="secondary-button"
          disabled={savePending}
          onClick={() => onSave({ mode: "metadata_only" })}
          type="button"
        >
          {SEARCH_UI.saveMetadata[language]}
        </button>
        <button
          className="secondary-button"
          disabled={savePending}
          onClick={() => onSave({ mode: "save_content" })}
          type="button"
        >
          {SEARCH_UI.saveContent[language]}
        </button>
        <button
          className="secondary-button"
          disabled={savePending}
          onClick={() => onSave({ mode: "metadata_only", favorite: true })}
          type="button"
        >
          {result.localState.isFavorite ? SEARCH_UI.favorited[language] : SEARCH_UI.saveFavorite[language]}
        </button>
        {result.metadata?.pdfUrl || result.identifiers.arxivId ? (
          <button
            className="secondary-button"
            disabled={savePending}
            onClick={() => onSave({ mode: "download_pdf" })}
            type="button"
          >
            {result.localState.hasDownloadedFile
              ? SEARCH_UI.pdfDownloaded[language]
              : SEARCH_UI.downloadPdf[language]}
          </button>
        ) : null}
        <button
          className="secondary-button"
          disabled={resultSummaryPending}
          onClick={onSummarize}
          type="button"
        >
          {resultSummaryPending
            ? "Summarizing..."
            : resultSummary?.status === "completed"
              ? "Refresh deep summary"
              : "Deep summary"}
        </button>
        {result.localState.documentId ? (
          <a
            className="secondary-button"
            href={`/documents/${encodeURIComponent(result.localState.documentId)}`}
          >
            {SEARCH_UI.openLocal[language]}
          </a>
        ) : null}
      </div>

      {savePending || result.localState.status === "saving" ? (
        <p className="empty-description">Saving this result to the local library...</p>
      ) : null}
      {result.localState.status === "save_failed" || saveError ? (
        <p className="empty-description">
          {saveError instanceof Error ? saveError.message : SEARCH_UI.saveError[language]}
        </p>
      ) : null}
      {resultSummaryError ? (
        <p className="empty-description">
          {resultSummaryError instanceof Error ? resultSummaryError.message : "Deep summary failed."} Retry is safe and does not change the result list.
        </p>
      ) : null}
      {resultSummary?.status === "failed" ? (
        <p className="empty-description">
          Deep summary failed: {resultSummary.error ?? "unknown error"}. Retry is safe and does not change the result list.
        </p>
      ) : null}
      {resultSummary?.status === "completed" ? (
        <div className="web-summary-panel">
          <p className="empty-title">
            Deep summary cache ready · {resultSummary.evidenceCount} evidence chunks
            {resultSummary.latencyMs !== undefined ? ` · ${resultSummary.latencyMs} ms` : ""}
          </p>
          {resultSummary.citations.length > 0 ? (
            <ul className="evidence-list">
              {resultSummary.citations.map((citation) => (
                <li key={citation.number}>
                  [{citation.number}] {citation.title} · {citation.url}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-description">
              No citation was available; the summary fell back to returned metadata/snippets.
            </p>
          )}
          <WebSummaryView summary={resultSummary} />
        </div>
      ) : null}
    </article>
  );
}

export function WebSummaryView({ summary }: { summary: WebSearchSummary }): JSX.Element {
  const synthesis = summary.synthesis;
  const citationByResult = new Map(
    summary.citations.map((citation) => [citation.resultId, citation]),
  );
  if (!synthesis) return <></>;
  return (
    <div className="web-summary-content">
      {synthesis.reportTitle ? <h2 className="section-title">{synthesis.reportTitle}</h2> : null}
      {synthesis.researchQuestion ? (
        <div className="empty-block">
          <p className="empty-title">研究问题</p>
          <p>{synthesis.researchQuestion}</p>
        </div>
      ) : null}
      <h3>总体概述</h3>
      <p>{synthesis.overview}</p>
      {synthesis.keyFindings.length > 0 ? (
        <>
          <h3>核心结论</h3>
          <ul>
            {synthesis.keyFindings.map((finding) => (
              <li key={`${finding.claim}:${finding.citations.join(",")}`}>
                {finding.claim}{" "}
                <CitationLinks
                  citationByResult={citationByResult}
                  resultIds={finding.citations}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {(synthesis.methodSections ?? []).map((section, index) => (
        <section key={`${section.title}:${index}`}>
          <h3>{`${index + 1}. ${section.title}`}</h3>
          <p>{section.summary}</p>
          {section.designLogic ? (
            <p>
              <strong>设计逻辑：</strong>
              {section.designLogic}
            </p>
          ) : null}
          {section.methodology ? (
            <p>
              <strong>方法论与具体流程：</strong>
              {section.methodology}
            </p>
          ) : null}
          {section.whyEffective ? (
            <p>
              <strong>为什么有效：</strong>
              {section.whyEffective}
            </p>
          ) : null}
          {section.implementation ? (
            <p>
              <strong>实施中如何应用：</strong>
              {section.implementation}
            </p>
          ) : null}
          {section.boundaries ? (
            <p>
              <strong>适用边界：</strong>
              {section.boundaries}
            </p>
          ) : null}
          <CitationLinks citationByResult={citationByResult} resultIds={section.resultIds} />
        </section>
      ))}
      {(synthesis.methodSections?.length ?? 0) === 0 && synthesis.resultGroups.length > 0 ? (
        <>
          <h3>方法分类</h3>
          {synthesis.resultGroups.map((group) => (
            <section key={group.title}>
              <h4>{group.title}</h4>
              <p>{group.summary}</p>
              <CitationLinks citationByResult={citationByResult} resultIds={group.resultIds} />
            </section>
          ))}
        </>
      ) : null}
      {synthesis.comparison ? (
        <section>
          <h3>跨方法比较</h3>
          <p>{synthesis.comparison}</p>
        </section>
      ) : null}
      {(synthesis.recommendations?.length ?? 0) > 0 ? (
        <section>
          <h3>实施建议</h3>
          <ol>
            {synthesis.recommendations?.map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {synthesis.conclusion ? (
        <section>
          <h3>最终结论</h3>
          <p>{synthesis.conclusion}</p>
        </section>
      ) : null}
      {synthesis.limitations.length > 0 ? (
        <div className="empty-block">
          <p className="empty-title">Evidence limitations</p>
          {synthesis.limitations.map((limitation) => (
            <p className="empty-description" key={limitation}>
              {limitation}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CitationLinks({
  citationByResult,
  resultIds,
}: {
  citationByResult: Map<string, WebSearchSummary["citations"][number]>;
  resultIds: string[];
}): JSX.Element {
  return (
    <>
      {resultIds.map((resultId) => {
        const citation = citationByResult.get(resultId);
        return citation ? (
          <a
            aria-label={`Citation ${citation.number}: ${citation.title}`}
            href={citation.url}
            key={resultId}
            rel="noreferrer"
            target="_blank"
          >
            [{citation.number}]
          </a>
        ) : null;
      })}
    </>
  );
}

function describeLocalState(result: WebSearchResult): string {
  if (result.localState.status === "saving") return "Saving";
  if (result.localState.status === "save_failed") return "Save failed";
  if (result.localState.status === "saved") return "Local";
  return "Temporary";
}
