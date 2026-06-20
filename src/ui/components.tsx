import { Link } from "react-router-dom";
import type { Document, RecommendationEntry } from "@/types";
import type { ReactNode } from "react";
import { useSummaryLanguage, type SummaryLanguage } from "./summary-language";

/** Returns the selected summary language, falling back only to the original abstract. */
export function pickSummary(doc: Document, lang: SummaryLanguage): string {
  return (lang === "zh" ? doc.summaryZh : doc.summaryEn) ?? doc.abstract;
}

export function SectionHeader(props: {
  kicker: string;
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
}): JSX.Element {
  return (
    <div className="section-header">
      <div>
        <span className="section-kicker">{props.kicker}</span>
        <h2 className="section-title">{props.title}</h2>
        <p className="section-description">{props.description}</p>
      </div>
      {props.actionLabel && props.actionTo ? (
        <Link className="text-link" to={props.actionTo}>
          {props.actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function RecommendationCard(props: { entry: RecommendationEntry }): JSX.Element {
  const { document, reason, score } = props.entry;
  const { language } = useSummaryLanguage();

  return (
    <article className="paper-card paper-card-featured">
      <div className="paper-meta-row">
        <span>{document.sourceTag}</span>
        <span>{formatDate(document.publishedAt)}</span>
        <span>score {score.toFixed(2)}</span>
      </div>
      <Link className="paper-title-link" to={`/documents/${document.id}`}>
        <h3 className="paper-title">{document.title}</h3>
      </Link>
      <p className="paper-abstract">{pickSummary(document, language)}</p>
      <div className="chip-row">
        {reason.matchedTags?.slice(0, 4).map((tag) => (
          <span className="chip chip-accent" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <p className="paper-reason">{reason.factors.join(" · ")}</p>
    </article>
  );
}

export function DocumentCard(props: {
  document: Document;
  snippet?: string;
  emphasis?: string;
  onOpen?: () => void;
}): JSX.Element {
  const { document } = props;
  const { language } = useSummaryLanguage();
  return (
    <article className="paper-card">
      <div className="paper-meta-row">
        <span>{document.sourceTag}</span>
        <span>{formatDate(document.publishedAt)}</span>
        <span>{document.typeTag}</span>
      </div>
      <Link className="paper-title-link" onClick={props.onOpen} to={`/documents/${document.id}`}>
        <h3 className="paper-title">{document.title}</h3>
      </Link>
      <p className="paper-abstract">
        {props.snippet
          ? renderHighlightedSnippet(props.snippet)
          : (props.emphasis ?? pickSummary(document, language))}
      </p>
      <div className="chip-row">
        {document.domainTags.slice(0, 4).map((tag) => (
          <span className="chip" key={tag}>
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}

export function EmptyBlock(props: { title: string; description: string }): JSX.Element {
  return (
    <div className="empty-block">
      <p className="empty-title">{props.title}</p>
      <p className="empty-description">{props.description}</p>
    </div>
  );
}

export function LoadingBlock(): JSX.Element {
  return (
    <div className="loading-block">
      <span className="loading-dot" />
      <span className="loading-dot" />
      <span className="loading-dot" />
    </div>
  );
}

export function StatTile(props: { label: string; value: string; note: string }): JSX.Element {
  return (
    <article className="stat-tile">
      <p className="stat-label">{props.label}</p>
      <p className="stat-value">{props.value}</p>
      <p className="stat-note">{props.note}</p>
    </article>
  );
}

export function PaginationBar(props: {
  page: number;
  totalPages: number;
  label: string;
  onPrev: () => void;
  onNext: () => void;
}): JSX.Element | null {
  if (props.totalPages <= 1) {
    return null;
  }

  return (
    <div aria-label={`${props.label} pagination`} className="pagination-bar">
      <button className="secondary-button" disabled={props.page <= 1} onClick={props.onPrev} type="button">
        Previous
      </button>
      <p className="pagination-copy">
        Page {props.page} / {props.totalPages}
      </p>
      <button
        className="secondary-button"
        disabled={props.page >= props.totalPages}
        onClick={props.onNext}
        type="button"
      >
        Next
      </button>
    </div>
  );
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function renderHighlightedSnippet(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const matcher = /<mark>([\s\S]*?)<\/mark>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = matcher.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(snippet.slice(lastIndex, match.index));
    }

    nodes.push(<mark key={`mark-${key++}`}>{match[1]}</mark>);
    lastIndex = matcher.lastIndex;
  }

  if (lastIndex < snippet.length) {
    nodes.push(snippet.slice(lastIndex));
  }

  return nodes;
}
