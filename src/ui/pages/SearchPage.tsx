import { useMutation, useQuery } from "@tanstack/react-query";
import { FormEvent, Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useSearchParams } from "react-router-dom";
import { DocumentCard, EmptyBlock, LoadingBlock, PaginationBar, SectionHeader } from "../components";
import {
  generateSearchReport,
  createWebSearch,
  getWebSearchEventsUrl,
  getWebSearchSession,
  getWebSearchHealth,
  getIndexCoverage,
  getTagCloud,
  recordSearchFeedback,
  retryWebSearchSession,
  searchDocuments,
  saveWebSearchResult,
  summarizeWebSearch,
  summarizeWebSearchResult,
  type TimeRangePreset,
} from "../lib/api";
import { SEARCH_UI } from "@/i18n";
import { useAppLanguage } from "../app-language";
import type {
  WebSearchBudgetPreset,
  WebSearchContentType,
  WebSearchRequest,
  WebSearchScope,
  WebSearchSummary,
} from "@/web-search/types";
import { WebResultCard, WebSummaryView } from "../web-search-result-card";

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
const WEB_SEARCH_EVENT_KEY_PREFIX = "paperhub.web-search.last-event.";
const LOCAL_SEARCH_STATE_KEY = "paperhub.local-search.state.v1";

const webContentTypeOptions: Array<{ label: string; value: WebSearchContentType }> = [
  { label: "Papers", value: "paper" },
  { label: "Official blogs", value: "official_blog" },
  { label: "Technical articles", value: "technical_article" },
  { label: "Documentation", value: "documentation" },
  { label: "Repositories", value: "repository" },
];

const webProviderOptions = [
  { label: "arXiv", value: "arxiv" },
  { label: "OpenAlex", value: "openalex" },
  { label: "Crossref", value: "crossref" },
  { label: "Tavily", value: "tavily" },
  { label: "Brave", value: "brave" },
  { label: "GitHub", value: "github" },
  { label: "Search MCP", value: "mcp" },
];

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
  contentTypes: WebSearchContentType[];
  languages: string;
  mustConcepts: string;
  shouldConcepts: string;
  excludeConcepts: string;
  requireMustMatch: boolean;
  sort: "relevance" | "recent";
  allowQueryRewrite: boolean;
  providers: string[];
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
  const [searchBudget, setSearchBudget] = useState<WebSearchBudgetPreset>(initialDraft.searchBudget);
  const [maxResults, setMaxResults] = useState(initialDraft.maxResults);
  const [autoSummarize, setAutoSummarize] = useState(initialDraft.autoSummarize);
  const [contentTypes, setContentTypes] = useState<WebSearchContentType[]>(initialDraft.contentTypes);
  const [languages, setLanguages] = useState(initialDraft.languages);
  const [mustConcepts, setMustConcepts] = useState(initialDraft.mustConcepts);
  const [shouldConcepts, setShouldConcepts] = useState(initialDraft.shouldConcepts);
  const [excludeConcepts, setExcludeConcepts] = useState(initialDraft.excludeConcepts);
  const [requireMustMatch, setRequireMustMatch] = useState(initialDraft.requireMustMatch);
  const [sort, setSort] = useState<"relevance" | "recent">(initialDraft.sort);
  const [allowQueryRewrite, setAllowQueryRewrite] = useState(initialDraft.allowQueryRewrite);
  const [providers, setProviders] = useState<string[]>(initialDraft.providers);
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedWebSearchCriteria(initialDraft));
  const [sseFailed, setSseFailed] = useState(false);
  const [latestEvent, setLatestEvent] = useState<{ type: string; id: string } | null>(null);
  const [resultSummaries, setResultSummaries] = useState<Record<string, WebSearchSummary>>({});
  const processedEventIds = useRef(new Set<string>());
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
      contentTypes,
      languages,
      mustConcepts,
      shouldConcepts,
      excludeConcepts,
      requireMustMatch,
      sort,
      allowQueryRewrite,
      providers,
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
    contentTypes,
    languages,
    mustConcepts,
    shouldConcepts,
    excludeConcepts,
    requireMustMatch,
    sort,
    allowQueryRewrite,
    providers,
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
        : sseFailed || !hasEventSource()
          ? 750
          : false;
    },
  });
  const session = sessionQuery.data;
  const healthQuery = useQuery({
    queryKey: ["web-search-health"],
    queryFn: getWebSearchHealth,
    staleTime: 30_000,
  });
  const providerHealth = useMemo(() => {
    return new Map((healthQuery.data?.providers ?? []).map((provider) => [provider.providerId, provider]));
  }, [healthQuery.data]);
  const advancedSummary = buildAdvancedWebSearchSummary({
    contentTypes,
    languages,
    includeDomains,
    excludeDomains,
    providers,
    sort,
    allowQueryRewrite,
    searchBudget,
    maxResults,
    mustConcepts,
    shouldConcepts,
    excludeConcepts,
    requireMustMatch,
  });

  useEffect(() => {
    if (!sessionId || !hasEventSource()) return;
    const terminal = session?.status
      ? ["completed", "partial", "failed", "cancelled", "expired"].includes(session.status)
      : false;
    if (terminal) return;
    setSseFailed(false);
    const storageKey = `${WEB_SEARCH_EVENT_KEY_PREFIX}${sessionId}`;
    const lastEventId = readLastEventId(storageKey);
    const source = new EventSource(getWebSearchEventsUrl(sessionId, lastEventId));
    const handleEvent = (event: MessageEvent) => {
      const eventKey = `${sessionId}:${event.lastEventId || event.type}`;
      if (processedEventIds.current.has(eventKey)) return;
      processedEventIds.current.add(eventKey);
      if (event.lastEventId) {
        localStorage.setItem(storageKey, event.lastEventId);
        setLatestEvent({ type: event.type, id: event.lastEventId });
      }
      if (event.type !== "heartbeat") void sessionQuery.refetch();
      if (WEB_SEARCH_TERMINAL_EVENTS.has(event.type)) {
        source.close();
      }
    };
    for (const type of WEB_SEARCH_SSE_EVENTS) {
      source.addEventListener(type, handleEvent);
    }
    source.onerror = () => {
      source.close();
      setSseFailed(true);
    };
    return () => {
      for (const type of WEB_SEARCH_SSE_EVENTS) {
        source.removeEventListener(type, handleEvent);
      }
      source.close();
    };
  }, [sessionId, session?.status, sessionQuery.refetch]);

  const synthesisMutation = useMutation({
    mutationFn: () => summarizeWebSearch(sessionId!),
    onSuccess: () => void sessionQuery.refetch(),
  });
  const resultSummaryMutation = useMutation({
    mutationFn: (resultId: string) => summarizeWebSearchResult(sessionId!, resultId),
    onSuccess: (summary, resultId) => {
      setResultSummaries((current) => ({ ...current, [resultId]: summary }));
      void sessionQuery.refetch();
    },
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
  const retryMutation = useMutation({
    mutationFn: (providerIds?: string[]) => retryWebSearchSession(sessionId!, providerIds),
    onSuccess: () => {
      setSseFailed(false);
      void sessionQuery.refetch();
    },
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
    const order = ["Papers", "Official blogs", "Documentation & repositories", "Technical articles"];
    return new Map([...groups.entries()].sort(([a], [b]) => groupOrder(order, a) - groupOrder(order, b)));
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
              contentTypes: contentTypes.length > 0 ? contentTypes : undefined,
              languages: parseStringList(languages),
              includeDomains: parseDomainList(includeDomains),
              excludeDomains: parseDomainList(excludeDomains),
              providers: providers.length > 0 ? providers : undefined,
              sort,
              maxResults,
              searchBudget,
              autoSummarize,
              allowQueryRewrite,
              concepts: buildWebConceptInput({
                mustConcepts,
                shouldConcepts,
                excludeConcepts,
                requireMustMatch,
              }),
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
          <details
            className="advanced-search-box"
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            open={advancedOpen}
          >
            <summary>高级 Web 搜索设置</summary>
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
                <span>Languages</span>
                <input
                  className="field-input"
                  onChange={(event) => setLanguages(event.target.value)}
                  placeholder="en, zh"
                  value={languages}
                />
              </label>
              <label className="field">
                <span>Must concepts</span>
                <input
                  className="field-input"
                  onChange={(event) => setMustConcepts(event.target.value)}
                  placeholder="synthetic data, large language models"
                  value={mustConcepts}
                />
              </label>
              <label className="field">
                <span>Should concepts</span>
                <input
                  className="field-input"
                  onChange={(event) => setShouldConcepts(event.target.value)}
                  placeholder="evaluation, human feedback"
                  value={shouldConcepts}
                />
              </label>
              <label className="field">
                <span>Exclude concepts</span>
                <input
                  className="field-input"
                  onChange={(event) => setExcludeConcepts(event.target.value)}
                  placeholder="survey, seo"
                  value={excludeConcepts}
                />
              </label>
              <label className="field">
                <span>Sort</span>
                <select
                  className="field-input"
                  onChange={(event) => setSort(event.target.value as "relevance" | "recent")}
                  value={sort}
                >
                  <option value="relevance">Relevance</option>
                  <option value="recent">Recent first</option>
                </select>
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
            <fieldset className="filter-fieldset">
              <legend>Content types</legend>
              <div className="chip-row">
                {webContentTypeOptions.map((option) => (
                  <label className="checkbox-row compact" key={option.value}>
                    <input
                      checked={contentTypes.includes(option.value)}
                      onChange={() => setContentTypes((current) => toggleValue(current, option.value))}
                      type="checkbox"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="filter-fieldset">
              <legend>Providers</legend>
              <p className="empty-description">
                Leave empty to use the planner defaults for the selected scope.
              </p>
              <div className="chip-row">
                {webProviderOptions.map((option) => {
                  const availability = getProviderAvailability(option.value, providerHealth);
                  const checked = providers.includes(option.value);
                  return (
                    <label
                      className={`checkbox-row compact${availability.available ? "" : " muted"}`}
                      key={option.value}
                      title={availability.reason}
                    >
                      <input
                        checked={checked}
                        disabled={!checked && !availability.available}
                        onChange={() => setProviders((current) => toggleValue(current, option.value))}
                        type="checkbox"
                      />
                      <span>{option.label}</span>
                      {!availability.available ? (
                        <span className="provider-status-note">{availability.reason}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="checkbox-row">
              <input
                checked={allowQueryRewrite}
                onChange={(event) => setAllowQueryRewrite(event.target.checked)}
                type="checkbox"
              />
              <span>Allow safe query rewrite</span>
            </label>
            <label className="checkbox-row">
              <input
                checked={requireMustMatch}
                onChange={(event) => setRequireMustMatch(event.target.checked)}
                type="checkbox"
              />
              <span>Require all must concepts</span>
            </label>
          </details>
          {advancedSummary.length > 0 ? (
            <div className="active-filter-summary" aria-label="Active Web Search advanced filters">
              {advancedSummary.map((item) => (
                <span className="chip" key={item}>
                  {item}
                </span>
              ))}
            </div>
          ) : null}
          <label className="checkbox-row">
            <input
              checked={autoSummarize}
              onChange={(event) => setAutoSummarize(event.target.checked)}
              type="checkbox"
            />
            <span>{SEARCH_UI.autoSummarize[language]}</span>
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
          {session?.plan?.rewrite ? (
            <div className="active-filter-summary" aria-label="Web Search query rewrite status">
              <span className={`chip ${session.plan.rewrite.applied ? "chip-success" : ""}`}>
                {session.plan.rewrite.applied ? "Query rewritten" : "Original query used"}
              </span>
              {session.plan.rewrite.rewrittenQuery ? (
                <span className="chip">{session.plan.rewrite.rewrittenQuery}</span>
              ) : null}
              {session.plan.rewrite.reason ? (
                <span className="chip">{session.plan.rewrite.reason}</span>
              ) : null}
            </div>
          ) : null}
          {!sessionId ? (
            <EmptyBlock
              description={SEARCH_UI.noSessionDescription[language]}
              title={SEARCH_UI.noSessionTitle[language]}
            />
          ) : null}
          {session?.status === "failed" ? (
            <EmptyBlock
              description={session.error ?? "All providers failed."}
              title={SEARCH_UI.searchFailedTitle[language]}
            />
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
                {synthesisMutation.isPending
                  ? SEARCH_UI.generatingOverview[language]
                  : SEARCH_UI.generateOverview[language]}
              </button>
            </section>
          ) : null}
          <div className="stack-grid">
            {[...groupedResults.entries()].map(([group, results]) => (
              <Fragment key={group}>
                <h3 className="section-title">{group}</h3>
                {results.map((result) => (
                  <WebResultCard
                    key={result.id}
                    language={language}
                    result={result}
                    resultSummary={resultSummaries[result.id]}
                    resultSummaryError={
                      resultSummaryMutation.isError && resultSummaryMutation.variables === result.id
                        ? resultSummaryMutation.error
                        : undefined
                    }
                    resultSummaryPending={
                      resultSummaryMutation.isPending && resultSummaryMutation.variables === result.id
                    }
                    saveError={
                      saveMutation.isError && saveMutation.variables?.resultId === result.id
                        ? saveMutation.error
                        : undefined
                    }
                    savePending={saveMutation.isPending && saveMutation.variables?.resultId === result.id}
                    onSave={(input) =>
                      saveMutation.mutate({
                        resultId: result.id,
                        ...input,
                      })
                    }
                    onSummarize={() => resultSummaryMutation.mutate(result.id)}
                  />
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
          {latestEvent ? (
            <p className="empty-description">
              Live event #{latestEvent.id}: {latestEvent.type}
              {sseFailed ? " · SSE fallback polling active" : ""}
            </p>
          ) : null}
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
                {!["success", "partial", "not_configured"].includes(run.status) &&
                ["partial", "failed"].includes(session.status) ? (
                  <button
                    className="secondary-button"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate([run.providerId])}
                    type="button"
                  >
                    Retry {run.providerId}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {session && ["partial", "failed"].includes(session.status) ? (
            <button
              className="secondary-button"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate(undefined)}
              type="button"
            >
              Retry failed providers
            </button>
          ) : null}
        </aside>
      </div>
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
    contentTypes: [],
    languages: "",
    mustConcepts: "",
    shouldConcepts: "",
    excludeConcepts: "",
    requireMustMatch: false,
    sort: "relevance",
    allowQueryRewrite: false,
    providers: [],
  };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(localStorage.getItem(WEB_SEARCH_STATE_KEY) ?? "{}") as Partial<WebSearchDraft>;
    return {
      ...fallback,
      ...stored,
      scope: ["academic", "technical", "mixed"].includes(stored.scope ?? "") ? stored.scope! : fallback.scope,
      searchBudget: ["low_cost", "balanced", "broad"].includes(stored.searchBudget ?? "")
        ? stored.searchBudget!
        : fallback.searchBudget,
      maxResults: Math.min(100, Math.max(1, Number(stored.maxResults) || fallback.maxResults)),
      contentTypes: Array.isArray(stored.contentTypes)
        ? stored.contentTypes.filter((value): value is WebSearchContentType =>
            ["paper", "official_blog", "technical_article", "documentation", "repository"].includes(
              String(value),
            ),
          )
        : fallback.contentTypes,
      languages: typeof stored.languages === "string" ? stored.languages : fallback.languages,
      mustConcepts: typeof stored.mustConcepts === "string" ? stored.mustConcepts : fallback.mustConcepts,
      shouldConcepts:
        typeof stored.shouldConcepts === "string" ? stored.shouldConcepts : fallback.shouldConcepts,
      excludeConcepts:
        typeof stored.excludeConcepts === "string" ? stored.excludeConcepts : fallback.excludeConcepts,
      requireMustMatch: stored.requireMustMatch === true,
      sort: stored.sort === "recent" ? "recent" : fallback.sort,
      allowQueryRewrite: stored.allowQueryRewrite === true,
      providers: Array.isArray(stored.providers)
        ? stored.providers.filter((value): value is string => typeof value === "string")
        : fallback.providers,
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
  const domains = [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return domains.length > 0 ? domains : undefined;
}

function parseStringList(value: string): string[] | undefined {
  const items = [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return items.length > 0 ? items : undefined;
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function groupOrder(order: string[], group: string): number {
  const index = order.indexOf(group);
  return index === -1 ? order.length : index;
}

function hasAdvancedWebSearchCriteria(draft: WebSearchDraft): boolean {
  return buildAdvancedWebSearchSummary(draft).length > 0;
}

function buildAdvancedWebSearchSummary(input: {
  contentTypes: WebSearchContentType[];
  languages: string;
  includeDomains: string;
  excludeDomains: string;
  mustConcepts: string;
  shouldConcepts: string;
  excludeConcepts: string;
  requireMustMatch: boolean;
  providers: string[];
  sort: "relevance" | "recent";
  allowQueryRewrite: boolean;
  searchBudget: WebSearchBudgetPreset;
  maxResults: number;
}): string[] {
  const items: string[] = [];
  if (input.contentTypes.length > 0) items.push(`Types: ${input.contentTypes.join(", ")}`);
  if (parseStringList(input.languages)?.length) items.push(`Languages: ${input.languages}`);
  if (parseDomainList(input.includeDomains)?.length) items.push(`Include: ${input.includeDomains}`);
  if (parseDomainList(input.excludeDomains)?.length) items.push(`Exclude: ${input.excludeDomains}`);
  if (parseStringList(input.mustConcepts)?.length) items.push(`Must: ${input.mustConcepts}`);
  if (parseStringList(input.shouldConcepts)?.length) items.push(`Should: ${input.shouldConcepts}`);
  if (parseStringList(input.excludeConcepts)?.length) items.push(`Concept exclude: ${input.excludeConcepts}`);
  if (input.requireMustMatch) items.push("Require all must concepts");
  if (input.providers.length > 0) items.push(`Providers: ${input.providers.join(", ")}`);
  if (input.sort === "recent") items.push("Sort: recent");
  if (input.allowQueryRewrite) items.push("Safe rewrite enabled");
  if (input.searchBudget !== "balanced") items.push(`Budget: ${input.searchBudget}`);
  if (input.maxResults !== 20) items.push(`Max: ${input.maxResults}`);
  return items;
}

function buildWebConceptInput(input: {
  mustConcepts: string;
  shouldConcepts: string;
  excludeConcepts: string;
  requireMustMatch: boolean;
}): WebSearchRequest["concepts"] {
  const must = parseStringList(input.mustConcepts);
  const should = parseStringList(input.shouldConcepts);
  const exclude = parseStringList(input.excludeConcepts);
  if (!must?.length && !should?.length && !exclude?.length && !input.requireMustMatch) {
    return undefined;
  }
  return {
    ...(must?.length ? { must } : {}),
    ...(should?.length ? { should } : {}),
    ...(exclude?.length ? { exclude } : {}),
    ...(input.requireMustMatch ? { requireMustMatch: true } : {}),
  };
}

function getProviderAvailability(
  providerId: string,
  providerHealth: Map<
    string,
    {
      configured: boolean;
      enabled: boolean;
      lastTestStatus?: "success" | "failed";
    }
  >,
): { available: boolean; reason: string } {
  const health = providerHealth.get(providerId);
  if (!health) return { available: true, reason: "Health not loaded yet" };
  if (!health.configured) return { available: false, reason: "Not configured" };
  if (!health.enabled) return { available: false, reason: "Disabled" };
  if (health.lastTestStatus === "failed") return { available: false, reason: "Connection test failed" };
  return { available: true, reason: "Available" };
}

const WEB_SEARCH_SSE_EVENTS = [
  "plan.completed",
  "query.rewritten",
  "provider.started",
  "provider.completed",
  "provider.failed",
  "provider.partial",
  "provider.timeout",
  "provider.rate_limited",
  "provider.not_configured",
  "provider.cache_hit",
  "provider.failover",
  "aggregation.started",
  "aggregation.completed",
  "summary.started",
  "summary.completed",
  "summary.skipped",
  "retry.started",
  "retry.completed",
  "session.completed",
  "session.partial",
  "session.failed",
  "session.cancelled",
  "session.interrupted",
  "heartbeat",
] as const;

const WEB_SEARCH_TERMINAL_EVENTS = new Set<string>([
  "session.completed",
  "session.partial",
  "session.failed",
  "session.cancelled",
  "session.interrupted",
]);

function hasEventSource(): boolean {
  return typeof window !== "undefined" && typeof window.EventSource !== "undefined";
}

function readLastEventId(storageKey: string): number {
  const value = typeof window === "undefined" ? null : localStorage.getItem(storageKey);
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
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
  const effectiveAllTags = appliedState.allTags.length > 0 ? appliedState.allTags : localDraft.allTags;
  const effectiveAnyTags = appliedState.anyTags.length > 0 ? appliedState.anyTags : localDraft.anyTags;
  const effectiveExcludeTags =
    appliedState.excludeTags.length > 0 ? appliedState.excludeTags : localDraft.excludeTags;
  const effectiveTimeRange = appliedState.timeRange !== "all" ? appliedState.timeRange : localDraft.timeRange;

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
    setAllTagDraft((appliedState.allTags.length > 0 ? appliedState.allTags : localDraft.allTags).join(", "));
    setAnyTagDraft((appliedState.anyTags.length > 0 ? appliedState.anyTags : localDraft.anyTags).join(", "));
    setExcludeTagDraft(
      (appliedState.excludeTags.length > 0 ? appliedState.excludeTags : localDraft.excludeTags).join(", "),
    );
    setTimeRange(appliedState.timeRange !== "all" ? appliedState.timeRange : localDraft.timeRange);
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
          <p className="empty-description">{SEARCH_UI.tagHint[language]}</p>

          <button className="primary-button" type="submit">
            {SEARCH_UI.runSearch[language]}
          </button>
        </form>
      </section>

      <div className="search-layout">
        <section className="content-panel">
          <SectionHeader
            description={
              SEARCH_UI.matchedDescription(
                searchQuery.data?.candidateTotal ?? searchQuery.data?.total ?? 0,
                searchQuery.data?.modeUsed ?? appliedState.mode,
              )[language]
            }
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
            <EmptyBlock
              description={SEARCH_UI.noSearchDescription[language]}
              title={SEARCH_UI.noSearchTitle[language]}
            />
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
          {reportQuery.data ? <pre className="report-copy">{reportQuery.data}</pre> : null}
          <div className="empty-block">
            <label className="field">
              <span>{SEARCH_UI.papersInReport[language]}</span>
              <input
                className="field-input"
                max={Math.min(100, searchQuery.data?.total ?? 10)}
                min={1}
                onChange={(event) => setReportCount(Math.max(1, Number(event.target.value) || 10))}
                type="number"
                value={reportCount}
              />
            </label>
            <button
              className="primary-button"
              disabled={reportQuery.isFetching || (searchQuery.data?.results.length ?? 0) === 0}
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
