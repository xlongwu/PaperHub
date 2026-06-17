import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { EmptyBlock, LoadingBlock, SectionHeader, formatDate } from "../components";
import {
  addFavorite,
  getDocument,
  getFavorites,
  getHistory,
  recordHistory as sendHistory,
  removeFavorite,
} from "../lib/api";

export function DocumentPage(): JSX.Element {
  const { id } = useParams();
  const queryClient = useQueryClient();

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

  const document = documentQuery.data;
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
        <EmptyBlock description="The requested document could not be found in the local archive." title="Document missing" />
      </section>
    );
  }

  return (
    <div className="page-grid">
      <section className="content-panel article-panel">
        <SectionHeader
          description={`${document.sourceTag} · ${formatDate(document.publishedAt)} · ${document.typeTag}`}
          kicker="Reading room"
          title={document.title}
        />
        <div className="detail-toolbar">
          <button className="primary-button" onClick={() => favoriteMutation.mutate()} type="button">
            {isFavorite ? "Remove favorite" : "Save to favorites"}
          </button>
          <button
            className="secondary-button"
            disabled={isRead || readMutation.isPending}
            onClick={() => readMutation.mutate()}
            type="button"
          >
            {isRead ? "Marked as read" : "Mark as read"}
          </button>
          <a className="secondary-button" href={document.url} rel="noreferrer" target="_blank">
            Open original source
          </a>
        </div>

        <div className="detail-meta-grid">
          <article className="detail-card">
            <h3>Authors</h3>
            <p>{document.authors.length > 0 ? document.authors.join(", ") : "Unknown authorship"}</p>
          </article>
          <article className="detail-card">
            <h3>Labels</h3>
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

        <article className="story-block">
          <h3>Chinese summary</h3>
          <p>{document.summaryZh ?? "No Chinese summary has been generated yet."}</p>
        </article>
        <article className="story-block">
          <h3>English summary</h3>
          <p>{document.summaryEn ?? document.abstract}</p>
        </article>
        <article className="story-block">
          <h3>Abstract</h3>
          <p>{document.abstract}</p>
        </article>
      </section>
    </div>
  );
}
