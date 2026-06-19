import { useQuery } from "@tanstack/react-query";
import { FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "react-router-dom";
import { DocumentCard, EmptyBlock, LoadingBlock, PaginationBar, SectionHeader } from "../components";
import {
  generateSearchReport,
  getIndexCoverage,
  recordSearchFeedback,
  searchDocuments,
  type TimeRangePreset,
} from "../lib/api";

const sourceOptions = [
  { label: "arXiv", value: "arxiv" },
  { label: "GPT Blog", value: "gpt_blog" },
  { label: "Claude Blog", value: "claude_blog" },
];

const timeRangeOptions: Array<{ label: string; value: TimeRangePreset }> = [
  { label: "Any time", value: "all" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "Last 365 days", value: "365d" },
];

const PAGE_SIZE = 12;

export function SearchPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const appliedState = useMemo(() => parseSearchParams(params), [params]);
  const [query, setQuery] = useState(appliedState.query);
  const [mode, setMode] = useState(appliedState.mode);
  const [sources, setSources] = useState<string[]>(appliedState.sources);
  const [, setTags] = useState<string[]>(appliedState.tags);
  const [tagDraft, setTagDraft] = useState(appliedState.tags.join(", "));
  const [tagMatchMode, setTagMatchMode] = useState<"any" | "all">(appliedState.tagMatchMode);
  const [timeRange, setTimeRange] = useState<TimeRangePreset>(appliedState.timeRange);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setQuery(appliedState.query);
    setMode(appliedState.mode);
    setSources(appliedState.sources);
    setTags(appliedState.tags);
    setTagDraft(appliedState.tags.join(", "));
    setTagMatchMode(appliedState.tagMatchMode);
    setTimeRange(appliedState.timeRange);
  }, [appliedState]);

  const searchQuery = useQuery({
    queryKey: [
      "search",
      appliedState.query,
      appliedState.mode,
      appliedState.sources.join(","),
      appliedState.tags.join(","),
      appliedState.tagMatchMode,
      appliedState.timeRange,
      appliedState.page,
    ],
    enabled: appliedState.query.trim().length > 0,
    queryFn: () =>
      searchDocuments({
        query: appliedState.query,
        mode: appliedState.mode,
        sources: appliedState.sources,
        tags: appliedState.tags,
        tagMatchMode: appliedState.tagMatchMode,
        timeRange: appliedState.timeRange,
        page: appliedState.page,
        limit: PAGE_SIZE,
      }),
  });
  const reportQuery = useQuery({
    queryKey: [
      "search-report",
      appliedState.query,
      searchQuery.data?.results.map((result) => result.document.id).join(",") ?? "",
    ],
    enabled: appliedState.mode === "hybrid" && (searchQuery.data?.results.length ?? 0) > 10,
    queryFn: () =>
      generateSearchReport(
        appliedState.query,
        searchQuery.data?.results.map((result) => result.document.id) ?? [],
      ),
  });
  const coverageQuery = useQuery({
    queryKey: ["index-coverage"],
    queryFn: getIndexCoverage,
    staleTime: 30_000,
  });
  const totalPages = Math.max(1, Math.ceil((searchQuery.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="page-grid">
      <section className="content-panel search-panel">
        <SectionHeader
          description="Keyword, semantic, and hybrid retrieval all land here. Use source and tag filters to narrow the desk."
          kicker="Research mode"
          title="Search"
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
            startTransition(() => {
              const normalizedTags = tagDraft
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean);
              setTags(normalizedTags);
              setParams(
                buildSearchParams({
                  query,
                  mode,
                  sources,
                  tags: normalizedTags,
                  tagMatchMode,
                  timeRange,
                  page: 1,
                }),
              );
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Query</span>
              <input
                className="field-input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="agent planning, multimodal memory, prompt alignment"
                value={query}
              />
            </label>
            <label className="field">
              <span>Mode</span>
              <select className="field-input" onChange={(event) => setMode(event.target.value)} value={mode}>
                <option value="hybrid">Hybrid</option>
                <option value="keyword">Keyword</option>
                <option value="semantic">Semantic</option>
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
              <span>Tags or topic refinements</span>
              <input
                className="field-input"
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder="Agents, RAG, GPT-4"
                value={tagDraft}
              />
            </label>
            <label className="field">
              <span>Published within</span>
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
            <label className="field">
              <span>Tag matching</span>
              <select
                className="field-input"
                onChange={(event) => setTagMatchMode(event.target.value as "any" | "all")}
                value={tagMatchMode}
              >
                <option value="any">Match any tag</option>
                <option value="all">Match all tags</option>
              </select>
            </label>
          </div>

          <button className="primary-button" type="submit">
            Run search
          </button>
        </form>
      </section>

      <div className="search-layout">
        <section className="content-panel">
          <SectionHeader
            description={`Matched ${searchQuery.data?.candidateTotal ?? searchQuery.data?.total ?? 0} candidates with mode ${searchQuery.data?.modeUsed ?? appliedState.mode}.`}
            kicker="Results"
            title="Result list"
          />
          {searchQuery.isLoading ? <LoadingBlock /> : null}
          {searchQuery.data?.modeUsed === "keyword_fallback" ? (
            <div className="empty-block">
              <p className="empty-title">Semantic search is temporarily unavailable</p>
              <p className="empty-description">Results are currently provided by keyword search.</p>
            </div>
          ) : null}
          {(searchQuery.data?.topicTerms?.length ?? 0) > 0 ? (
            <div className="empty-block">
              <p className="empty-title">Topic refinement applied</p>
              <p className="empty-description">
                {searchQuery.data?.topicTerms?.join(", ")} is not an indexed tag, so it was included in
                relevance matching instead of being silently discarded.
              </p>
            </div>
          ) : null}
          {!searchQuery.isLoading && appliedState.query.trim().length === 0 ? (
            <EmptyBlock description="Start with a topic, model, or workflow pattern." title="No search yet" />
          ) : null}
          {!searchQuery.isLoading &&
          appliedState.query.trim().length > 0 &&
          (searchQuery.data?.results.length ?? 0) === 0 ? (
            <EmptyBlock
              description="Try widening the query, changing the mode, or removing some filters."
              title="No matches found"
            />
          ) : null}
          <div className="stack-grid">
            {searchQuery.data?.results.map((result, index) => (
              <DocumentCard
                document={result.document}
                key={result.document.id}
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
            ))}
          </div>
          <PaginationBar
            label="Search results"
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
            description="Search results return first; this briefing loads independently."
            kicker="Briefing"
            title="Research memo"
          />
          {reportQuery.isLoading ? <LoadingBlock /> : null}
          {!reportQuery.isLoading && !reportQuery.data ? (
            <EmptyBlock
              description="A report appears automatically when the result set is rich enough."
              title="No memo generated"
            />
          ) : null}
          {reportQuery.data ? <p className="report-copy">{reportQuery.data}</p> : null}
          <div className="empty-block">
            <p className="empty-title">Local corpus coverage</p>
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
  tags: string[];
  tagMatchMode: "any" | "all";
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
    tags: params.get("tags")?.split(",").filter(Boolean) ?? [],
    tagMatchMode: params.get("tagMatch") === "all" ? "all" : "any",
    timeRange: nextTimeRange,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function buildSearchParams(state: {
  query: string;
  mode: string;
  sources: string[];
  tags: string[];
  tagMatchMode: "any" | "all";
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
  if (state.tags.length > 0) {
    next.set("tags", state.tags.join(","));
    next.set("tagMatch", state.tagMatchMode);
  }
  if (state.timeRange !== "all") {
    next.set("range", state.timeRange);
  }
  if (state.page > 1) {
    next.set("page", String(state.page));
  }
  return next;
}
