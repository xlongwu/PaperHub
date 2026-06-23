import { useQuery } from "@tanstack/react-query";
import { getHotRecommendations, getLatestDocuments, getPersonalizedRecommendations } from "../lib/api";
import {
  DocumentCard,
  EmptyBlock,
  LoadingBlock,
  RecommendationCard,
  SectionHeader,
  StatTile,
} from "../components";
import { HOME_UI } from "@/i18n";
import { useAppLanguage } from "../app-language";

export function HomePage(): JSX.Element {
  const { language } = useAppLanguage();
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
          <span className="section-kicker">{HOME_UI.heroKicker[language]}</span>
          <h1 className="hero-title">{HOME_UI.heroTitle[language]}</h1>
          <p className="hero-description">{HOME_UI.heroDescription[language]}</p>
        </div>
        <div className="hero-stats">
          <StatTile
            label={HOME_UI.hotStatLabel[language]}
            note={HOME_UI.hotStatNote[language]}
            value={String(hotQuery.data?.length ?? 0)}
          />
          <StatTile
            label={HOME_UI.forYouStatLabel[language]}
            note={HOME_UI.forYouStatNote[language]}
            value={String(personalizedQuery.data?.length ?? 0)}
          />
          <StatTile
            label={HOME_UI.latestStatLabel[language]}
            note={HOME_UI.latestStatNote[language]}
            value={String(latestQuery.data?.length ?? 0)}
          />
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel={HOME_UI.hotActionLabel[language]}
          actionTo="/search"
          description={HOME_UI.hotDescription[language]}
          kicker={HOME_UI.hotKicker[language]}
          title={HOME_UI.hotTitle[language]}
        />
        {hotQuery.isLoading ? <LoadingBlock /> : null}
        {!hotQuery.isLoading && (hotQuery.data?.length ?? 0) === 0 ? (
          <EmptyBlock description={HOME_UI.noHotDescription[language]} title={HOME_UI.noHotTitle[language]} />
        ) : null}
        <div className="feature-grid">
          {hotQuery.data?.map((entry) => (
            <RecommendationCard entry={entry} key={entry.document.id} />
          ))}
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel={HOME_UI.personalActionLabel[language]}
          actionTo="/me"
          description={HOME_UI.personalDescription[language]}
          kicker={HOME_UI.personalKicker[language]}
          title={HOME_UI.personalTitle[language]}
        />
        {personalizedQuery.isLoading ? <LoadingBlock /> : null}
        {!personalizedQuery.isLoading && (personalizedQuery.data?.length ?? 0) === 0 ? (
          <EmptyBlock
            description={HOME_UI.noPersonalDescription[language]}
            title={HOME_UI.noPersonalTitle[language]}
          />
        ) : null}
        <div className="stack-grid">
          {personalizedQuery.data?.map((entry) => (
            <RecommendationCard entry={entry} key={entry.document.id} />
          ))}
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          actionLabel={HOME_UI.recentActionLabel[language]}
          actionTo="/tags"
          description={HOME_UI.recentDescription[language]}
          kicker={HOME_UI.recentKicker[language]}
          title={HOME_UI.recentTitle[language]}
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
