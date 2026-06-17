import { useQuery } from "@tanstack/react-query";
import {
  getHotRecommendations,
  getLatestDocuments,
  getPersonalizedRecommendations,
} from "../lib/api";
import {
  DocumentCard,
  EmptyBlock,
  LoadingBlock,
  RecommendationCard,
  SectionHeader,
  StatTile,
} from "../components";

export function HomePage(): JSX.Element {
  const hotQuery = useQuery({
    queryKey: ["home", "hot"],
    queryFn: getHotRecommendations,
  });
  const personalizedQuery = useQuery({
    queryKey: ["home", "personalized"],
    queryFn: getPersonalizedRecommendations,
  });
  const latestQuery = useQuery({
    queryKey: ["home", "latest"],
    queryFn: getLatestDocuments,
  });

  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="section-kicker">Research Frontline</span>
          <h1 className="hero-title">A local intelligence desk for papers, labs, and fast-moving AI ecosystems.</h1>
          <p className="hero-description">
            PaperHub combines recommendation, retrieval, and memory into a single reading surface.
            Start with the hot board, move into the archive, then follow the tags that matter.
          </p>
        </div>
        <div className="hero-stats">
          <StatTile label="Hot board" note="Daily rebuild" value={String(hotQuery.data?.length ?? 0)} />
          <StatTile label="For you" note="Profile matched" value={String(personalizedQuery.data?.length ?? 0)} />
          <StatTile label="Latest" note="Fresh entries" value={String(latestQuery.data?.length ?? 0)} />
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel="Search everything"
          actionTo="/search"
          description="Time-decayed picks with source diversity, rebuilt from the recommendation cache."
          kicker="Today"
          title="Hot board"
        />
        {hotQuery.isLoading ? <LoadingBlock /> : null}
        {!hotQuery.isLoading && (hotQuery.data?.length ?? 0) === 0 ? (
          <EmptyBlock description="Run collection or rebuild recommendations to populate the board." title="No hot recommendations yet" />
        ) : null}
        <div className="feature-grid">
          {hotQuery.data?.map((entry) => (
            <RecommendationCard entry={entry} key={entry.document.id} />
          ))}
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel="Open profile"
          actionTo="/me"
          description="Matches drawn from interests, memory terms, reading history, and favorites."
          kicker="Personal"
          title="For you"
        />
        {personalizedQuery.isLoading ? <LoadingBlock /> : null}
        {!personalizedQuery.isLoading && (personalizedQuery.data?.length ?? 0) === 0 ? (
          <EmptyBlock description="Add interest tags or rebuild user memory to unlock personalized picks." title="Profile needs more signal" />
        ) : null}
        <div className="stack-grid">
          {personalizedQuery.data?.map((entry) => (
            <RecommendationCard entry={entry} key={entry.document.id} />
          ))}
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel="Browse tags"
          actionTo="/tags"
          description="The latest additions from the local corpus, ready for reading and follow-up search."
          kicker="Recent"
          title="New on the desk"
        />
        {latestQuery.isLoading ? <LoadingBlock /> : null}
        <div className="stack-grid">
          {latestQuery.data?.map((document) => (
            <DocumentCard document={document} key={document.id} />
          ))}
        </div>
      </section>
    </div>
  );
}
