import { useMutation, useQuery } from "@tanstack/react-query";
import { FormEvent, Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "react-router-dom";
import { DocumentCard, EmptyBlock, LoadingBlock, PaginationBar, SectionHeader } from "../components";
import {
  generateSearchReport,
  createWebSearch,
  getWebSearchSession,
  getIndexCoverage,
  getTagCloud,
  recordSearchFeedback,
  recordWebSearchResultOpen,
  searchDocuments,
  saveWebSearchResult,
  summarizeWebSearch,
  type TimeRangePreset,
} from "../lib/api";
import { SEARCH_UI } from "@/i18n";
import { useAppLanguage } from "../app-language";
import type {
  WebSearchBudgetPreset,
  WebSearchScope,
  WebSearchSummary,
} from "@/web-search/types";

const sourceOptions = [
  { label: "arXiv", value: "arxiv" },
  { label: "GPT Blog", value: "gpt_blog" },
  { label: "Claude Blog", value: "claude_blog" },
  { label: "Saved from Web", value: "web" },
];

const timeRangeOptions: Array<{ label: string; value: TimeRangePreset }> = [
  { label: "Any time", value: "all" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "Last 365 days", value: "365d" },
];

const PAGE_SIZE = 10;
const WEB_SEARCH_STATE_KEY = "paperhub.web-search.state.v1";
const LOCAL_SEARCH_STATE_KEY = "paperhub.local-search.state.v1";

interface WebSearchDraft {
  query: string;
  scope: WebSearchScope;
  from: string;
  to: string;
  includeDomains: string;
  excludeDomains: string;
  searchBudget: WebSearchBudgetPreset;
  maxResults: number;
  autoSummarize: boolean;
  includeSearchMcp: boolean;
  sessionId?: string;
}

export function SearchPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const { language } = useAppLanguage();
  const hasLocalQueryState =
    params.has("q") ||
    params.has("mode") ||
    params.has("sources") ||
    params.has("tags") ||
    params.has("allTags") ||
    params.has("anyTags") ||
    params.has("excludeTags");
  const activeView = params.get("view") ?? (hasLocalQueryState ? "local" : "web");

  return (
    <>
      <section className="content-panel search-entry-panel">
        <div className="search-entry-tabs" role="tablist" aria-label="Search source">
          <button
            aria-selected={activeView === "web"}
            className={`search-entry-tab${activeView === "web" ? " active" : ""}`}
            onClick={() => {
              setParams(buildWebSearchRestoreParams(readWebSearchDraft()));
            }}
            role="tab"
            type="button"
          >
            {SEARCH_UI.webSearchTab[language]}
          </button>
          <button
            aria-selected={activeView === "local"}
            className={`search-entry-tab${activeView === "local" ? " active" : ""}`}
            onClick={() => {
              const draft = readLocalSearchDraft();
              setParams(buildLocalSearchRestoreParams(draft));
            }}
            role="tab"
            type="button"
          >
            {SEARCH_UI.localSearchTab[language]}
          </button>
        </div>
      </section>
      {activeView === "web" ? <WebSearchPanel /> : <LocalSearchPanel />}
    </>
  );
}

function WebSearchPanel(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const { language } = useAppLanguage();
  const [initialDraft] = useState(readWebSearchDraft);
  const [query, setQuery] = useState(params.get("q") ?? initialDraft.query);
  const [scope, setScope] = useState<WebSearchScope>(
    params.get("scope") === "mixed" || params.get("scope") === "technical"
      ? (params.get("scope") as WebSearchScope)
      : initialDraft.scope,
  );
  const [from, setFrom] = useState(initialDraft.from);
  const [to, setTo] = useState(initialDraft.to);
  const [includeDomains, setIncludeDomains] = useState(initialDraft.includeDomains);
  const [excludeDomains, setExcludeDomains] = useState(initialDraft.excludeDomains);
  const [searchBudget, setSearchBudget] = useState<WebSearchBudgetPreset>(
    initialDraft.searchBudget,
  );
  const [maxResults, setMaxResults] = useState(initialDraft.maxResults);
  const [autoSummarize, setAutoSummarize] = useState(initialDraft.autoSummarize);
  const [includeSearchMcp, setIncludeSearchMcp] = useState(initialDraft.includeSearchMcp);
  const sessionId = params.get("session") ?? initialDraft.sessionId ?? null;

  useEffect(() => {
    if (!params.get("session") && initialDraft.sessionId) {
      setParams(buildWebSearchRestoreParams(initialDraft), { replace: true });
    }
  }, [initialDraft, params, setParams]);

  useEffect(() => {
    writeWebSearchDraft({
      query,
      scope,
      from,
      to,
      includeDomains,
      excludeDomains,
      searchBudget,
      maxResults,
      autoSummarize,
      includeSearchMcp,
      sessionId: sessionId ?? undefined,
    });
  }, [
    query,
    scope,
    from,
    to,
    includeDomains,
    excludeDomains,
    searchBudget,
    maxResults,
    autoSummarize,
    includeSearchMcp,
    sessionId,
  ]);
  const createMutation = useMutation({
    mutationFn: createWebSearch,
    onSuccess: (created) => {
      const next = new URLSearchParams();
      next.set("view", "web");
      next.set("q", query.trim());
      next.set("scope", scope);
      next.set("session", created.sessionId);
      setParams(next);
    },
  });
  const sessionQuery = useQuery({
    queryKey: ["web-search-session", sessionId],
    enabled: Boolean(sessionId),
    queryFn: () => getWebSearchSession(sessionId!),
    refetchInterval: (queryState) => {
      const status = queryState.state.data?.status;
      return status && ["completed", "partial", "failed", "cancelled", "expired"].includes(status)
        ? false
        : 750;
    },
  });
  const session = sessionQuery.data;
  const synthesisMutation = useMutation({
    mutationFn: () => summarizeWebSearch(sessionId!),
    onSuccess: () => void sessionQuery.refetch(),
  });
  const saveMutation = useMutation({
    mutationFn: (input: {
      resultId: string;
      mode: "metadata_only" | "save_content" | "download_pdf";
      favorite?: boolean;
    }) =>
      saveWebSearchResult(sessionId!, input.resultId, {
        mode: input.mode,
        favorite: input.favorite,
        generateSummary: input.mode !== "metadata_only",
      }),
    onSuccess: () => void sessionQuery.refetch(),
  });
  const groupedResults = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof session>["results"]>();
    for (const result of session?.results ?? []) {
      const label =
        result.contentType === "paper"
          ? "Papers"
          : result.contentType === "official_blog"
            ? "Official blogs"
            : result.contentType === "documentation" || result.contentType === "repository"
              ? "Documentation & repositories"
              : "Technical articles";
      groups.set(label, [...(groups.get(label) ?? []), result]);
    }
    return groups;
  }, [session]);

  return (
    <>
      <section className="content-panel search-panel">
        <SectionHeader
          description={SEARCH_UI.webSearchDescription[language]}
          kicker={SEARCH_UI.webSearchKicker[language]}
          title={SEARCH_UI.webSearchTitle[language]}
        />
        <form
          className="search-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!query.trim()) return;
            createMutation.mutate({
              query: query.trim(),
              scope,
              dateRange: from || to ? { start: from || undefined, end: to || undefined } : undefined,
              includeDomains: parseDomainList(includeDomains),
              excludeDomains: parseDomainList(excludeDomains),
              providers: includeSearchMcp
                ? ["arxiv", "openalex", "tavily", "brave", "mcp"]
                : undefined,
              maxResults,
              searchBudget,
              autoSummarize,
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>{SEARCH_UI.webQueryLabel[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="synthetic data for large language models"
                value={query}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.scopeLabel[language]}</span>
              <select
                className="field-input"
                onChange={(event) => setScope(event.target.value as WebSearchScope)}
                value={scope}
              >
                <option value="academic">{SEARCH_UI.scopeAcademic[language]}</option>
                <option value="technical">{SEARCH_UI.scopeTechnical[language]}</option>
                <option value="mixed">{SEARCH_UI.scopeMixed[language]}</option>
              </select>
            </label>
          </div>
          <div className="form-grid form-grid-compact">
            <label className="field">
              <span>{SEARCH_UI.publishedAfter[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setFrom(event.target.value)}
                type="date"
                value={from}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.publishedBefore[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setTo(event.target.value)}
                type="date"
                value={to}
              />
            </label>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>{SEARCH_UI.includeDomains[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setIncludeDomains(event.target.value)}
                placeholder="openai.com, github.com"
                value={includeDomains}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.excludeDomains[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setExcludeDomains(event.target.value)}
                placeholder="example.com"
                value={excludeDomains}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.searchBudget[language]}</span>
              <select
                className="field-input"
                onChange={(event) => setSearchBudget(event.target.value as WebSearchBudgetPreset)}
                value={searchBudget}
              >
                <option value="low_cost">{SEARCH_UI.budgetLowCost[language]}</option>
                <option value="balanced">{SEARCH_UI.budgetBalanced[language]}</option>
                <option value="broad">{SEARCH_UI.budgetBroad[language]}</option>
              </select>
            </label>
            <label className="field">
              <span>{SEARCH_UI.maxResults[language]}</span>
              <input
                className="field-input"
                max={100}
                min={1}
                onChange={(event) =>
                  setMaxResults(Math.min(100, Math.max(1, Number(event.target.value) || 1)))
                }
                type="number"
                value={maxResults}
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input
              checked={autoSummarize}
              onChange={(event) => setAutoSummarize(event.target.checked)}
              type="checkbox"
            />
            <span>{SEARCH_UI.autoSummarize[language]}</span>
          </label>
          <label className="checkbox-row">
            <input
              checked={includeSearchMcp}
              onChange={(event) => setIncludeSearchMcp(event.target.checked)}
              type="checkbox"
            />
            <span>{SEARCH_UI.includeMcp[language]}</span>
          </label>
          <button className="primary-button" disabled={createMutation.isPending} type="submit">
            {createMutation.isPending ? SEARCH_UI.searching[language] : SEARCH_UI.searchButton[language]}
          </button>
          {createMutation.isError ? (
            <p className="empty-description">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : SEARCH_UI.searchError[language]}
            </p>
          ) : null}
        </form>
      </section>

      <div className="search-layout">
        <section className="content-panel">
          <SectionHeader
            description={
              session
                ? `${session.results.length} temporary results · expires ${new Date(session.expiresAt).toLocaleString()}`
                : "Start a search to create a recoverable 24-hour session."
            }
            kicker={SEARCH_UI.webResultsKicker[language]}
            title={SEARCH_UI.webResultsTitle[language]}
          />
          {sessionQuery.isLoading ? <LoadingBlock /> : null}
          {!sessionId ? (
            <EmptyBlock
              description={SEARCH_UI.noSessionDescription[language]}
              title={SEARCH_UI.noSessionTitle[language]}
            />
          ) : null}
          {session?.status === "failed" ? (
            <EmptyBlock description={session.error ?? "All providers failed."} title={SEARCH_UI.searchFailedTitle[language]} />
          ) : null}
          {session && !["completed", "partial", "failed", "cancelled"].includes(session.status) ? (
            <LoadingBlock />
          ) : null}
          {session && ["completed", "partial"].includes(session.status) ? (
            <section className="web-summary-panel">
              <div className="paper-meta-row">
                <span>{SEARCH_UI.evidencePanel[language]}</span>
                <span>{SEARCH_UI.evidenceChunks(session.summary?.evidenceCount ?? 0)[language]}</span>
              </div>
              {session.summary?.status === "completed" && session.summary.synthesis ? (
                <WebSummaryView summary={session.summary} />
              ) : session.summary?.status === "failed" ? (
                <p className="empty-description">{session.summary.error}</p>
              ) : (
                <p className="empty-description">{SEARCH_UI.noSynthesis[language]}</p>
              )}
              <button
                className="secondary-button"
                disabled={synthesisMutation.isPending}
                onClick={() => synthesisMutation.mutate()}
                type="button"
              >
                {synthesisMutation.isPending ? SEARCH_UI.generatingOverview[language] : SEARCH_UI.generateOverview[language]}
              </button>
            </section>
          ) : null}
          <div className="stack-grid">
            {[...groupedResults.entries()].map(([group, results]) => (
              <Fragment key={group}>
                <h3 className="section-title">{group}</h3>
                {results.map((result) => (
                  <article className="paper-card" key={result.id}>
                <div className="paper-meta-row">
                  <span>{result.origin.sourceName ?? result.origin.domain}</span>
                  <span>{result.contentType}</span>
                  <span>{result.publishedAt?.slice(0, 10) ?? "Date unavailable"}</span>
                </div>
                <a
                  href={result.url}
                  onClick={() => {
                    void recordWebSearchResultOpen(result.sessionId, result.id).catch(
                      () => undefined,
                    );
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  <h3 className="paper-title">{result.title}</h3>
                </a>
                <p className="empty-description">{result.authors.join(", ") || "Authors unavailable"}</p>
                <p>{result.abstract ?? result.snippet ?? "No abstract returned."}</p>
                <div className="chip-row">
                  {result.identifiers.arxivId ? (
                    <span className="chip">arXiv:{result.identifiers.arxivId}</span>
                  ) : null}
                  <span className="chip">
                    {result.localState.status === "saved" ? "Local" : "Temporary"}
                  </span>
                </div>
                <div className="web-result-actions">
                  <button
                    className="secondary-button"
                    disabled={
                      saveMutation.isPending &&
                      saveMutation.variables?.resultId === result.id
                    }
                    onClick={() =>
                      saveMutation.mutate({
                        resultId: result.id,
                        mode: "metadata_only",
                      })
                    }
                    type="button"
                  >
                    {SEARCH_UI.saveMetadata[language]}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      saveMutation.isPending &&
                      saveMutation.variables?.resultId === result.id
                    }
                    onClick={() =>
                      saveMutation.mutate({
                        resultId: result.id,
                        mode: "save_content",
                      })
                    }
                    type="button"
                  >
                    {SEARCH_UI.saveContent[language]}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      saveMutation.isPending &&
                      saveMutation.variables?.resultId === result.id
                    }
                    onClick={() =>
                      saveMutation.mutate({
                        resultId: result.id,
                        mode: "metadata_only",
                        favorite: true,
                      })
                    }
                    type="button"
                  >
                    {result.localState.isFavorite ? SEARCH_UI.favorited[language] : SEARCH_UI.saveFavorite[language]}
                  </button>
                  {result.metadata?.pdfUrl || result.identifiers.arxivId ? (
                    <button
                      className="secondary-button"
                      disabled={
                        saveMutation.isPending &&
                        saveMutation.variables?.resultId === result.id
                      }
                      onClick={() =>
                        saveMutation.mutate({
                          resultId: result.id,
                          mode: "download_pdf",
                        })
                      }
                      type="button"
                    >
                      {result.localState.hasDownloadedFile
                        ? SEARCH_UI.pdfDownloaded[language]
                        : SEARCH_UI.downloadPdf[language]}
                    </button>
                  ) : null}
                  {result.localState.documentId ? (
                    <a
                      className="secondary-button"
                      href={`/documents/${encodeURIComponent(result.localState.documentId)}`}
                    >
                      {SEARCH_UI.openLocal[language]}
                    </a>
                  ) : null}
                </div>
                {saveMutation.isError &&
                saveMutation.variables?.resultId === result.id ? (
                  <p className="empty-description">
                    {saveMutation.error instanceof Error
                      ? saveMutation.error.message
                      : SEARCH_UI.saveError[language]}
                  </p>
                ) : null}
                  </article>
                ))}
              </Fragment>
            ))}
          </div>
        </section>
        <aside className="content-panel report-panel">
          <SectionHeader
            description="Each provider reports independently; one failure does not masquerade as a local search."
            kicker="Session"
            title={session?.status ?? "Idle"}
          />
          <div className="stack-grid">
            {session?.providerRuns.map((run) => (
              <div className="empty-block" key={run.providerId}>
                <p className="empty-title">{run.providerId}</p>
                <p className="empty-description">
                  {run.status} · {run.resultCount} results
                  {run.latencyMs !== undefined ? ` · ${run.latencyMs} ms` : ""}
                  {run.estimatedCredits !== undefined
                    ? ` · ${run.estimatedCredits.toFixed(3)} estimated credits`
                    : ""}
                </p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}

function WebSummaryView({ summary }: { summary: WebSearchSummary }): JSX.Element {
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

function readWebSearchDraft(): WebSearchDraft {
  const fallback: WebSearchDraft = {
    query: "",
    scope: "academic",
    from: "",
    to: "",
    includeDomains: "",
    excludeDomains: "",
    searchBudget: "balanced",
    maxResults: 20,
    autoSummarize: true,
    includeSearchMcp: false,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(localStorage.getItem(WEB_SEARCH_STATE_KEY) ?? "{}") as Partial<WebSearchDraft>;
    return {
      ...fallback,
      ...stored,
      scope: ["academic", "technical", "mixed"].includes(stored.scope ?? "")
        ? stored.scope!
        : fallback.scope,
      searchBudget: ["low_cost", "balanced", "broad"].includes(stored.searchBudget ?? "")
        ? stored.searchBudget!
        : fallback.searchBudget,
      maxResults: Math.min(100, Math.max(1, Number(stored.maxResults) || fallback.maxResults)),
    };
  } catch {
    return fallback;
  }
}

function writeWebSearchDraft(draft: WebSearchDraft): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(WEB_SEARCH_STATE_KEY, JSON.stringify(draft));
}

function buildWebSearchRestoreParams(draft: WebSearchDraft): URLSearchParams {
  const next = new URLSearchParams();
  next.set("view", "web");
  if (draft.query.trim()) next.set("q", draft.query.trim());
  next.set("scope", draft.scope);
  if (draft.sessionId) next.set("session", draft.sessionId);
  return next;
}

function parseDomainList(value: string): string[] | undefined {
  const domains = [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  return domains.length > 0 ? domains : undefined;
}

function LocalSearchPanel(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const { language } = useAppLanguage();
  const appliedState = useMemo(() => parseSearchParams(params), [params]);
  // Fall back to localStorage draft when URL params are empty (i.e. user
  // navigated to /search without query params after switching tabs).
  const localDraft = readLocalSearchDraft();
  const effectiveQuery = appliedState.query || localDraft.query;
  const effectiveMode = appliedState.mode || localDraft.mode;
  const effectiveSources = appliedState.sources.length > 0 ? appliedState.sources : localDraft.sources;
  const effectiveAllTags =
    appliedState.allTags.length > 0 ? appliedState.allTags : localDraft.allTags;
  const effectiveAnyTags =
    appliedState.anyTags.length > 0 ? appliedState.anyTags : localDraft.anyTags;
  const effectiveExcludeTags =
    appliedState.excludeTags.length > 0 ? appliedState.excludeTags : localDraft.excludeTags;
  const effectiveTimeRange =
    appliedState.timeRange !== "all" ? appliedState.timeRange : localDraft.timeRange;

  const [query, setQuery] = useState(effectiveQuery);
  const [mode, setMode] = useState(effectiveMode);
  const [sources, setSources] = useState<string[]>(effectiveSources);
  const [allTagDraft, setAllTagDraft] = useState(effectiveAllTags.join(", "));
  const [anyTagDraft, setAnyTagDraft] = useState(effectiveAnyTags.join(", "));
  const [excludeTagDraft, setExcludeTagDraft] = useState(effectiveExcludeTags.join(", "));
  const [timeRange, setTimeRange] = useState<TimeRangePreset>(effectiveTimeRange);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setQuery(appliedState.query || localDraft.query);
    setMode(appliedState.mode || localDraft.mode);
    setSources(appliedState.sources.length > 0 ? appliedState.sources : localDraft.sources);
    setAllTagDraft(
      (appliedState.allTags.length > 0 ? appliedState.allTags : localDraft.allTags).join(", "),
    );
    setAnyTagDraft(
      (appliedState.anyTags.length > 0 ? appliedState.anyTags : localDraft.anyTags).join(", "),
    );
    setExcludeTagDraft(
      (appliedState.excludeTags.length > 0 ? appliedState.excludeTags : localDraft.excludeTags).join(", "),
    );
    setTimeRange(
      appliedState.timeRange !== "all" ? appliedState.timeRange : localDraft.timeRange,
    );
  }, [appliedState]);

  // Persist local search state to localStorage so it survives navigation.
  useEffect(() => {
    writeLocalSearchDraft({
      query: query.trim(),
      mode,
      sources,
      allTags: parseCommaList(allTagDraft),
      anyTags: parseCommaList(anyTagDraft),
      excludeTags: parseCommaList(excludeTagDraft),
      timeRange,
    });
  }, [query, mode, sources, allTagDraft, anyTagDraft, excludeTagDraft, timeRange]);

  const searchQuery = useQuery({
    queryKey: [
      "search",
      appliedState.query,
      appliedState.mode,
      appliedState.sources.join(","),
      appliedState.allTags.join(","),
      appliedState.anyTags.join(","),
      appliedState.excludeTags.join(","),
      appliedState.timeRange,
      appliedState.page,
    ],
    enabled: appliedState.query.trim().length > 0,
    queryFn: () =>
      searchDocuments({
        query: appliedState.query,
        mode: appliedState.mode,
        sources: appliedState.sources,
        tags: [],
        allTags: appliedState.allTags,
        anyTags: appliedState.anyTags,
        excludeTags: appliedState.excludeTags,
        timeRange: appliedState.timeRange,
        page: appliedState.page,
        limit: PAGE_SIZE,
      }),
  });
  const [reportCount, setReportCount] = useState(10);
  const reportQuery = useQuery({
    queryKey: [
      "search-report",
      appliedState.query,
      searchQuery.data?.results.map((result) => result.document.id).join(",") ?? "",
      String(reportCount),
    ],
    enabled: false,
    queryFn: () =>
      generateSearchReport(
        appliedState.query,
        searchQuery.data?.results.map((result) => result.document.id) ?? [],
        reportCount,
      ),
  });
  const coverageQuery = useQuery({
    queryKey: ["index-coverage"],
    queryFn: getIndexCoverage,
    staleTime: 30_000,
  });
  const tagOptionsQuery = useQuery({
    queryKey: ["search-tag-options"],
    queryFn: () => getTagCloud(),
    staleTime: 30_000,
  });
  const totalPages = Math.max(1, Math.ceil((searchQuery.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="page-grid">
      <section className="content-panel search-panel">
        <SectionHeader
          description={SEARCH_UI.localDescription[language]}
          kicker={SEARCH_UI.localKicker[language]}
          title={SEARCH_UI.localTitle[language]}
        />
        <form
          className="search-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (searchQuery.data?.searchEventId && query.trim() !== appliedState.query.trim()) {
              void recordSearchFeedback({
                eventId: searchQuery.data.searchEventId,
                reformulated: true,
              });
            }
            const allTags = parseCommaList(allTagDraft);
            const allTagKeys = new Set(allTags.map(normalizeTagInput));
            const anyTags = parseCommaList(anyTagDraft).filter(
              (tag) => !allTagKeys.has(normalizeTagInput(tag)),
            );
            startTransition(() => {
              setParams(
                buildSearchParams({
                  query,
                  mode,
                  sources,
                  allTags,
                  anyTags,
                  excludeTags: parseCommaList(excludeTagDraft),
                  timeRange,
                  page: 1,
                }),
              );
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>{SEARCH_UI.queryLabel[language]}</span>
              <input
                className="field-input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="agent planning, multimodal memory, prompt alignment"
                value={query}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.modeLabel[language]}</span>
              <select className="field-input" onChange={(event) => setMode(event.target.value)} value={mode}>
                <option value="hybrid">{SEARCH_UI.modeHybrid[language]}</option>
                <option value="keyword">{SEARCH_UI.modeKeyword[language]}</option>
                <option value="semantic">{SEARCH_UI.modeSemantic[language]}</option>
              </select>
            </label>
          </div>

          <div className="filter-strip">
            {sourceOptions.map((option) => {
              const active = sources.includes(option.value);
              return (
                <button
                  className={`filter-pill${active ? " active" : ""}`}
                  key={option.value}
                  onClick={(event) => {
                    event.preventDefault();
                    setSources(
                      active ? sources.filter((value) => value !== option.value) : [...sources, option.value],
                    );
                  }}
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="form-grid form-grid-compact">
            <label className="field">
              <span>{SEARCH_UI.allTagsLabel[language]}</span>
              <input
                className="field-input"
                list="paperhub-search-tags"
                onChange={(event) => setAllTagDraft(event.target.value)}
                placeholder="LLM, Synthetic Data"
                value={allTagDraft}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.anyTagsLabel[language]}</span>
              <input
                className="field-input"
                list="paperhub-search-tags"
                onChange={(event) => setAnyTagDraft(event.target.value)}
                placeholder="Evaluation, RAG"
                value={anyTagDraft}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.excludeTagsLabel[language]}</span>
              <input
                className="field-input"
                list="paperhub-search-tags"
                onChange={(event) => setExcludeTagDraft(event.target.value)}
                placeholder="Image"
                value={excludeTagDraft}
              />
            </label>
            <label className="field">
              <span>{SEARCH_UI.timeRangeLabel[language]}</span>
              <select
                className="field-input"
                onChange={(event) => setTimeRange(event.target.value as TimeRangePreset)}
                value={timeRange}
              >
                {timeRangeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <datalist id="paperhub-search-tags">
            {Array.isArray(tagOptionsQuery.data)
              ? tagOptionsQuery.data.map((tag) => (
                  <option
                    key={`${tag.category}-${tag.canonicalTag ?? tag.tag}`}
                    label={`${tag.tag} · ${tag.count} documents`}
                    value={tag.canonicalTag ?? tag.tag}
                  />
                ))
              : null}
          </datalist>
          <p className="empty-description">
            {SEARCH_UI.tagHint[language]}
          </p>

          <button className="primary-button" type="submit">
            {SEARCH_UI.runSearch[language]}
          </button>
        </form>
      </section>

      <div className="search-layout">
        <section className="content-panel">
          <SectionHeader
            description={SEARCH_UI.matchedDescription(searchQuery.data?.candidateTotal ?? searchQuery.data?.total ?? 0, searchQuery.data?.modeUsed ?? appliedState.mode)[language]}
            kicker={SEARCH_UI.resultsKicker[language]}
            title={SEARCH_UI.resultsTitle[language]}
          />
          {searchQuery.isLoading ? <LoadingBlock /> : null}
          {searchQuery.isError ? (
            <div className="empty-block">
              <p className="empty-title">{SEARCH_UI.searchErrorTitle[language]}</p>
              <p className="empty-description">
                {searchQuery.error instanceof Error ? searchQuery.error.message : "Search failed"}
              </p>
            </div>
          ) : null}
          {searchQuery.data?.modeUsed === "keyword_fallback" ? (
            <div className="empty-block">
              <p className="empty-title">{SEARCH_UI.keywordFallbackTitle[language]}</p>
              <p className="empty-description">{SEARCH_UI.keywordFallbackDescription[language]}</p>
            </div>
          ) : null}
          {searchQuery.data?.queryPlan ? (
            <div className="empty-block">
              <p className="empty-title">{SEARCH_UI.queryPlanTitle[language]}</p>
              <p className="empty-description">
                Must:{" "}
                {searchQuery.data.queryPlan.concepts.must.map((item) => item.canonical).join(", ") || "—"}
                {" · "}All tags: {searchQuery.data.queryPlan.filters.allTags.join(", ") || "—"}
                {" · "}Any tags: {searchQuery.data.queryPlan.filters.anyTags.join(", ") || "—"}
                {" · "}Exclude: {searchQuery.data.queryPlan.filters.excludeTags.join(", ") || "—"}
              </p>
            </div>
          ) : null}
          {!searchQuery.isLoading && appliedState.query.trim().length === 0 ? (
            <EmptyBlock description={SEARCH_UI.noSearchDescription[language]} title={SEARCH_UI.noSearchTitle[language]} />
          ) : null}
          {!searchQuery.isLoading &&
          appliedState.query.trim().length > 0 &&
          (searchQuery.data?.results.length ?? 0) === 0 ? (
            <EmptyBlock
              description={SEARCH_UI.noMatchesDescription[language]}
              title={SEARCH_UI.noMatchesTitle[language]}
            />
          ) : null}
          <div className="stack-grid">
            {searchQuery.data?.results.map((result, index) => (
              <Fragment key={result.document.id}>
                <DocumentCard
                  document={result.document}
                  onOpen={() => {
                    if (searchQuery.data?.searchEventId) {
                      void recordSearchFeedback({
                        eventId: searchQuery.data.searchEventId,
                        documentId: result.document.id,
                        rank: (appliedState.page - 1) * PAGE_SIZE + index + 1,
                      });
                    }
                  }}
                  snippet={result.snippet}
                />
                {result.explanation ? (
                  <div className="empty-block">
                    <p className="empty-description">
                      {result.explanation.tier.toUpperCase()} · Must concepts:{" "}
                      {result.explanation.matchedMustConcepts.join(", ") || "—"} · Paths:{" "}
                      {result.explanation.recallPaths.join(", ")}
                    </p>
                  </div>
                ) : null}
              </Fragment>
            ))}
          </div>
          <PaginationBar
            label={SEARCH_UI.paginationLabel[language]}
            nextLabel={SEARCH_UI.nextPage[language]}
            prevLabel={SEARCH_UI.prevPage[language]}
            onNext={() =>
              startTransition(() => {
                setParams(
                  buildSearchParams({
                    ...appliedState,
                    page: appliedState.page + 1,
                  }),
                );
              })
            }
            onPrev={() =>
              startTransition(() => {
                setParams(
                  buildSearchParams({
                    ...appliedState,
                    page: appliedState.page - 1,
                  }),
                );
              })
            }
            page={appliedState.page}
            totalPages={totalPages}
          />
        </section>

        <aside className="content-panel report-panel">
          <SectionHeader
            description={SEARCH_UI.synthesisDescription[language]}
            kicker={SEARCH_UI.synthesisKicker[language]}
            title={SEARCH_UI.synthesisTitle[language]}
          />
          {reportQuery.isLoading ? <LoadingBlock /> : null}
          {reportQuery.data ? (
            <pre className="report-copy">{reportQuery.data}</pre>
          ) : null}
          <div className="empty-block">
            <label className="field">
              <span>{SEARCH_UI.papersInReport[language]}</span>
              <input
                className="field-input"
                max={Math.min(100, searchQuery.data?.total ?? 10)}
                min={1}
                onChange={(event) =>
                  setReportCount(Math.max(1, Number(event.target.value) || 10))
                }
                type="number"
                value={reportCount}
              />
            </label>
            <button
              className="primary-button"
              disabled={
                reportQuery.isFetching ||
                (searchQuery.data?.results.length ?? 0) === 0
              }
              onClick={() => reportQuery.refetch()}
              style={{ marginTop: "0.75rem" }}
              type="button"
            >
              {reportQuery.isFetching
                ? SEARCH_UI.generatingOverview[language]
                : SEARCH_UI.generateOverview[language]}
            </button>
            {reportQuery.isError ? (
              <p className="empty-description">
                {reportQuery.error instanceof Error
                  ? reportQuery.error.message
                  : SEARCH_UI.reportError[language]}
              </p>
            ) : null}
            <p className="empty-description">
              {reportQuery.data
                ? SEARCH_UI.reportInfo(reportCount)[language]
                : SEARCH_UI.reportWaiting(reportCount)[language]}
            </p>
          </div>
          <div className="empty-block">
            <p className="empty-title">{SEARCH_UI.coverageTitle[language]}</p>
            <p className="empty-description">
              Documents: {coverageQuery.data?.totalDocs ?? 0} · FTS: {coverageQuery.data?.ftsIndexed ?? 0}/
              {coverageQuery.data?.totalDocs ?? 0} · Vectors: {coverageQuery.data?.vectorIndexed ?? 0}/
              {coverageQuery.data?.totalDocs ?? 0}
            </p>
            {coverageQuery.data?.dateRange ? (
              <p className="empty-description">
                {coverageQuery.data.dateRange.from.slice(0, 10)} to{" "}
                {coverageQuery.data.dateRange.to.slice(0, 10)}
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function parseSearchParams(params: URLSearchParams): {
  query: string;
  mode: string;
  sources: string[];
  allTags: string[];
  anyTags: string[];
  excludeTags: string[];
  timeRange: TimeRangePreset;
  page: number;
} {
  const timeRange = params.get("range");
  const nextTimeRange = timeRangeOptions.some((option) => option.value === timeRange)
    ? (timeRange as TimeRangePreset)
    : "all";
  const page = Number.parseInt(params.get("page") ?? "1", 10);

  return {
    query: params.get("q") ?? "",
    mode: params.get("mode") ?? "hybrid",
    sources: params.get("sources")?.split(",").filter(Boolean) ?? [],
    allTags:
      params.get("allTags")?.split(",").filter(Boolean) ??
      (params.get("tagMatch") === "any" ? [] : (params.get("tags")?.split(",").filter(Boolean) ?? [])),
    anyTags:
      params.get("anyTags")?.split(",").filter(Boolean) ??
      (params.get("tagMatch") === "any" ? (params.get("tags")?.split(",").filter(Boolean) ?? []) : []),
    excludeTags: params.get("excludeTags")?.split(",").filter(Boolean) ?? [],
    timeRange: nextTimeRange,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function buildSearchParams(state: {
  query: string;
  mode: string;
  sources: string[];
  allTags: string[];
  anyTags: string[];
  excludeTags: string[];
  timeRange: TimeRangePreset;
  page: number;
}): URLSearchParams {
  const next = new URLSearchParams();
  if (state.query.trim()) {
    next.set("q", state.query.trim());
  }
  next.set("mode", state.mode);
  if (state.sources.length > 0) {
    next.set("sources", state.sources.join(","));
  }
  if (state.allTags.length > 0) next.set("allTags", state.allTags.join(","));
  if (state.anyTags.length > 0) next.set("anyTags", state.anyTags.join(","));
  if (state.excludeTags.length > 0) next.set("excludeTags", state.excludeTags.join(","));
  if (state.timeRange !== "all") {
    next.set("range", state.timeRange);
  }
  if (state.page > 1) {
    next.set("page", String(state.page));
  }
  return next;
}

interface LocalSearchDraft {
  query: string;
  mode: string;
  sources: string[];
  allTags: string[];
  anyTags: string[];
  excludeTags: string[];
  timeRange: TimeRangePreset;
}

function readLocalSearchDraft(): LocalSearchDraft {
  const fallback: LocalSearchDraft = {
    query: "",
    mode: "hybrid",
    sources: [],
    allTags: [],
    anyTags: [],
    excludeTags: [],
    timeRange: "all",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_SEARCH_STATE_KEY) ?? "{}",
    ) as Partial<LocalSearchDraft>;
    return {
      ...fallback,
      query: typeof stored.query === "string" ? stored.query : fallback.query,
      mode:
        stored.mode === "keyword" || stored.mode === "semantic" || stored.mode === "hybrid"
          ? stored.mode
          : fallback.mode,
      sources: Array.isArray(stored.sources) ? stored.sources.filter(Boolean) : fallback.sources,
      allTags: Array.isArray(stored.allTags) ? stored.allTags.filter(Boolean) : fallback.allTags,
      anyTags: Array.isArray(stored.anyTags) ? stored.anyTags.filter(Boolean) : fallback.anyTags,
      excludeTags: Array.isArray(stored.excludeTags)
        ? stored.excludeTags.filter(Boolean)
        : fallback.excludeTags,
      timeRange: timeRangeOptions.some((o) => o.value === stored.timeRange)
        ? (stored.timeRange as TimeRangePreset)
        : fallback.timeRange,
    };
  } catch {
    return fallback;
  }
}

function writeLocalSearchDraft(draft: LocalSearchDraft): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_SEARCH_STATE_KEY, JSON.stringify(draft));
}

function buildLocalSearchRestoreParams(draft: LocalSearchDraft): URLSearchParams {
  const next = new URLSearchParams();
  next.set("view", "local");
  if (draft.query.trim()) next.set("q", draft.query.trim());
  if (draft.mode !== "hybrid") next.set("mode", draft.mode);
  if (draft.sources.length > 0) next.set("sources", draft.sources.join(","));
  if (draft.allTags.length > 0) next.set("allTags", draft.allTags.join(","));
  if (draft.anyTags.length > 0) next.set("anyTags", draft.anyTags.join(","));
  if (draft.excludeTags.length > 0) next.set("excludeTags", draft.excludeTags.join(","));
  if (draft.timeRange !== "all") next.set("range", draft.timeRange);
  return next;
}

function parseCommaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeTagInput(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[-_\s]+/gu, "");
}
