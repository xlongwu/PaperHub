import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Link, useSearchParams } from "react-router-dom";
import { DocumentCard, EmptyBlock, LoadingBlock, PaginationBar, SectionHeader } from "../components";
import { getDocumentsByTag, getTagCloud } from "../lib/api";
import { TAGS_UI, SEARCH_UI } from "@/i18n";
import { useAppLanguage } from "../app-language";

const tagCategories = ["domain", "model", "method", "task", "source", "type", "year"] as const;
const TAG_PAGE_SIZE = 12;
const categoryOptions = [
  { labelKey: "catAll" as const, value: "all" },
  { labelKey: "catDomain" as const, value: "domain" },
  { labelKey: "catModel" as const, value: "model" },
  { labelKey: "catMethod" as const, value: "method" },
  { labelKey: "catTask" as const, value: "task" },
  { labelKey: "catSource" as const, value: "source" },
  { labelKey: "catType" as const, value: "type" },
  { labelKey: "catYear" as const, value: "year" },
] as const;

export function TagsPage(): JSX.Element {
  const { tag } = useParams();
  const { language } = useAppLanguage();
  const [params, setParams] = useSearchParams();
  const category = categoryOptions.some((option) => option.value === params.get("category"))
    ? (params.get("category") as (typeof categoryOptions)[number]["value"])
    : "all";
  const sortBy = params.get("sort") === "relevance" ? "relevance" : "time";
  const pageValue = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;
  const tagsQuery = useQuery({
    queryKey: ["tags", category],
    queryFn: () =>
      category === "all"
        ? Promise.all(tagCategories.map((item) => getTagCloud(item)))
        : Promise.all(
            tagCategories.map((item) => (item === category ? getTagCloud(item) : Promise.resolve([]))),
          ),
  });
  const documentsQuery = useQuery({
    queryKey: ["tag-documents", tag, sortBy, page],
    enabled: Boolean(tag),
    queryFn: () => getDocumentsByTag(tag!, { sortBy, page, limit: TAG_PAGE_SIZE }),
  });

  const groupedTags = tagCategories.map((category, index) => ({
    category,
    items: tagsQuery.data?.[index] ?? [],
  }));
  const totalPages = Math.max(1, Math.ceil((documentsQuery.data?.total ?? 0) / TAG_PAGE_SIZE));

  return (
    <div className="page-grid">
      <section className="content-panel">
        <SectionHeader
          description={TAGS_UI.description[language]}
          kicker={TAGS_UI.kicker[language]}
          title={TAGS_UI.title[language]}
        />
        <div className="filter-strip">
          {categoryOptions.map((option) => (
            <button
              className={`filter-pill${category === option.value ? " active" : ""}`}
              key={option.value}
              onClick={() => {
                setParams(updateTagParams(params, { category: option.value, page: 1 }));
              }}
              type="button"
            >
              {TAGS_UI[option.labelKey][language]}
            </button>
          ))}
        </div>
        {tagsQuery.isLoading ? <LoadingBlock /> : null}
        {groupedTags.map((group) => (
          <div className="tag-group" key={group.category}>
            <h3 className="group-title">{group.category}</h3>
            <div className="tag-cloud">
              {group.items.map((item) => (
                <Link
                  className="tag-badge"
                  to={buildTagHref(item.tag, category)}
                  key={`${group.category}-${item.tag}`}
                >
                  <span>{item.tag}</span>
                  <strong>{item.count}</strong>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>

      {tag ? (
        <section className="content-panel">
          <SectionHeader
            description={TAGS_UI.focusDescription(tag)[language]}
            kicker={TAGS_UI.focusKicker[language]}
            title={tag}
          />
          <div className="toolbar-inline toolbar-inline-spread">
            <label className="field field-inline">
              <span>{TAGS_UI.sortBy[language]}</span>
              <select
                className="field-input"
                onChange={(event) => {
                  setParams(updateTagParams(params, { sort: event.target.value, page: 1 }));
                }}
                value={sortBy}
              >
                <option value="time">{TAGS_UI.sortNewest[language]}</option>
                <option value="relevance">{TAGS_UI.sortSummaries[language]}</option>
              </select>
            </label>
          </div>
          {documentsQuery.isLoading ? <LoadingBlock /> : null}
          {!documentsQuery.isLoading && (documentsQuery.data?.items.length ?? 0) === 0 ? (
            <EmptyBlock
              description={TAGS_UI.noHitsDescription[language]}
              title={TAGS_UI.noHitsTitle[language]}
            />
          ) : null}
          <div className="stack-grid">
            {documentsQuery.data?.items.map((document) => (
              <DocumentCard document={document} key={document.id} />
            ))}
          </div>
          <PaginationBar
            label={TAGS_UI.paginationLabel[language]}
            nextLabel={SEARCH_UI.nextPage[language]}
            prevLabel={SEARCH_UI.prevPage[language]}
            onNext={() => setParams(updateTagParams(params, { page: page + 1 }))}
            onPrev={() => setParams(updateTagParams(params, { page: page - 1 }))}
            page={page}
            totalPages={totalPages}
          />
        </section>
      ) : null}
    </div>
  );
}

function updateTagParams(
  current: URLSearchParams,
  updates: {
    category?: string;
    sort?: string;
    page?: number;
  },
): URLSearchParams {
  const next = new URLSearchParams(current);
  const category = updates.category ?? current.get("category") ?? "all";
  const sort = updates.sort ?? current.get("sort") ?? "time";
  const currentPage = Number.parseInt(current.get("page") ?? "1", 10);
  const page = updates.page ?? (Number.isFinite(currentPage) && currentPage > 0 ? currentPage : 1);

  if (category === "all") {
    next.delete("category");
  } else {
    next.set("category", category);
  }

  if (sort === "time") {
    next.delete("sort");
  } else {
    next.set("sort", sort);
  }

  if (page <= 1) {
    next.delete("page");
  } else {
    next.set("page", String(page));
  }

  return next;
}

function buildTagHref(tag: string, category: string): string {
  const next = new URLSearchParams();
  if (category !== "all") {
    next.set("category", category);
  }
  const query = next.toString();
  return query ? `/tags/${encodeURIComponent(tag)}?${query}` : `/tags/${encodeURIComponent(tag)}`;
}
