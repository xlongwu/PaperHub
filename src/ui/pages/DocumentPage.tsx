import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { SUMMARY_UI, DOCUMENT_UI } from "@/i18n";
import type { Document } from "@/types";
import { EmptyBlock, LoadingBlock, SectionHeader, formatDate } from "../components";
import {
  addFavorite,
  getDocument,
  getFavorites,
  getHistory,
  recordHistory as sendHistory,
  removeFavorite,
  summarizeDocument,
} from "../lib/api";
import { useAppLanguage, type AppLanguage } from "../app-language";

type SummaryView = "summary" | "abstract";

export function DocumentPage(): JSX.Element {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { language } = useAppLanguage();
  const labels = {
    summaryTab: SUMMARY_UI.summaryTab[language],
    abstractTab: SUMMARY_UI.abstractTab[language],
    summaryHeading: SUMMARY_UI.summaryHeading[language],
    generating: SUMMARY_UI.generating[language],
    generationFailed: SUMMARY_UI.generationFailed[language],
    retry: SUMMARY_UI.retry[language],
  };
  const [summaryView, setSummaryView] = useState<SummaryView>("summary");
  const attemptedSummaries = useRef(new Set<string>());

  const documentQuery = useQuery({
    queryKey: ["document", id],
    enabled: Boolean(id),
    queryFn: () => getDocument(id!),
  });
  const favoritesQuery = useQuery({
    queryKey: ["user", "favorites"],
    queryFn: () => getFavorites({ limit: 100 }),
  });
  const historyQuery = useQuery({
    queryKey: ["user", "history"],
    queryFn: () => getHistory({ limit: 100 }),
  });
  const [markedRead, setMarkedRead] = useState(false);

  const favoriteMutation = useMutation({
    mutationFn: async () => {
      const isFavorite = favoritesQuery.data?.some((item) => item.documentId === id);
      if (isFavorite) {
        await removeFavorite(id!);
      } else {
        await addFavorite(id!);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user", "favorites"] });
      await queryClient.invalidateQueries({ queryKey: ["home", "personalized"] });
    },
  });

  const readMutation = useMutation({
    mutationFn: async () => sendHistory(id!),
    onSuccess: async () => {
      setMarkedRead(true);
      await queryClient.invalidateQueries({ queryKey: ["user", "history"] });
      await queryClient.invalidateQueries({ queryKey: ["home", "personalized"] });
    },
  });

  const summaryMutation = useMutation({
    mutationFn: (targetLanguage: AppLanguage) => summarizeDocument(id!, targetLanguage),
    onSuccess: async (result) => {
      queryClient.setQueryData(["document", id], result.document);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["home"] }),
        queryClient.invalidateQueries({ queryKey: ["search"] }),
        queryClient.invalidateQueries({ queryKey: ["tag-documents"] }),
      ]);
    },
  });

  const document = documentQuery.data;
  const selectedSummary = document ? getSummary(document, language) : undefined;

  useEffect(() => {
    if (!document || summaryView !== "summary" || selectedSummary) {
      return;
    }

    const attemptKey = `${document.id}:${language}`;
    if (attemptedSummaries.current.has(attemptKey)) {
      return;
    }

    attemptedSummaries.current.add(attemptKey);
    summaryMutation.mutate(language);
  }, [document, language, selectedSummary, summaryMutation, summaryView]);

  const favoriteIds = favoritesQuery.data?.map((item) => item.documentId) ?? [];
  const isFavorite = id ? favoriteIds.includes(id) : false;
  const historyIds = historyQuery.data?.map((item) => item.documentId) ?? [];
  const isRead = markedRead || (id ? historyIds.includes(id) : false);

  if (documentQuery.isLoading) {
    return (
      <section className="content-panel">
        <LoadingBlock />
      </section>
    );
  }

  if (!document) {
    return (
      <section className="content-panel">
        <EmptyBlock
          description={DOCUMENT_UI.noDocumentDescription[language]}
          title={DOCUMENT_UI.noDocumentTitle[language]}
        />
      </section>
    );
  }

  return (
    <div className="page-grid">
      <section className="content-panel article-panel">
        <SectionHeader
          description={`${document.sourceTag} · ${formatDate(document.publishedAt, language)} · ${document.typeTag}`}
          kicker={DOCUMENT_UI.readingKicker[language]}
          title={document.title}
        />
        <div className="detail-toolbar">
          <button className="primary-button" onClick={() => favoriteMutation.mutate()} type="button">
            {isFavorite ? DOCUMENT_UI.removeFavorite[language] : DOCUMENT_UI.saveFavorite[language]}
          </button>
          <button
            className="secondary-button"
            disabled={isRead || readMutation.isPending}
            onClick={() => readMutation.mutate()}
            type="button"
          >
            {isRead ? DOCUMENT_UI.markedRead[language] : DOCUMENT_UI.markRead[language]}
          </button>
          <a className="secondary-button" href={document.url} rel="noreferrer" target="_blank">
            {DOCUMENT_UI.openOriginal[language]}
          </a>
        </div>

        <div className="detail-meta-grid">
          <article className="detail-card">
            <h3>{DOCUMENT_UI.authorsLabel[language]}</h3>
            <p>
              {document.authors.length > 0
                ? document.authors.join(", ")
                : DOCUMENT_UI.authorsUnknown[language]}
            </p>
          </article>
          <article className="detail-card">
            <h3>{DOCUMENT_UI.labelsLabel[language]}</h3>
            <div className="chip-row">
              {document.domainTags.map((tag) => (
                <span className="chip" key={tag}>
                  {tag}
                </span>
              ))}
              {document.modelTags.map((tag) => (
                <span className="chip chip-accent" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </article>
        </div>

        <div className="lang-tab-bar" role="tablist" aria-label={labels.summaryTab}>
          <button
            aria-selected={summaryView === "summary"}
            className={`lang-tab${summaryView === "summary" ? " lang-tab-active" : ""}`}
            id="tab-summary"
            onClick={() => setSummaryView("summary")}
            role="tab"
            type="button"
          >
            {labels.summaryTab}
          </button>
          <button
            aria-selected={summaryView === "abstract"}
            className={`lang-tab${summaryView === "abstract" ? " lang-tab-active" : ""}`}
            id="tab-abstract"
            onClick={() => setSummaryView("abstract")}
            role="tab"
            type="button"
          >
            {labels.abstractTab}
          </button>
        </div>

        <article className="story-block" aria-labelledby={`tab-${summaryView}`} role="tabpanel">
          {summaryView === "summary" ? (
            <>
              <h3>{labels.summaryHeading}</h3>
              {selectedSummary ? (
                <p>{selectedSummary}</p>
              ) : summaryMutation.isPending && summaryMutation.variables === language ? (
                <p className="summary-status" role="status">
                  {labels.generating}
                </p>
              ) : summaryMutation.isError && summaryMutation.variables === language ? (
                <div className="summary-error" role="alert">
                  <p>{labels.generationFailed}</p>
                  <button
                    className="secondary-button"
                    disabled={summaryMutation.isPending}
                    onClick={() => summaryMutation.mutate(language)}
                    type="button"
                  >
                    {labels.retry}
                  </button>
                </div>
              ) : (
                <LoadingBlock />
              )}
            </>
          ) : (
            <>
              <h3>{labels.abstractTab}</h3>
              <p>{document.abstract}</p>
            </>
          )}
        </article>
      </section>
    </div>
  );
}

function getSummary(document: Document, language: AppLanguage): string | undefined {
  return language === "zh" ? document.summaryZh : document.summaryEn;
}
