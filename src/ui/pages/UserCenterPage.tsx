import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyBlock, LoadingBlock, SectionHeader } from "../components";
import { LlmConnectionsPanel } from "../llm-connections";
import {
  getFavorites,
  getHistory,
  getEmbeddingSettings,
  getUserMemory,
  getUserPreferences,
  rebuildUserMemory,
  rebuildEmbeddingIndex,
  removeFavorite,
  saveEmbeddingSettings,
  saveUserPreferences,
  testEmbeddingConnection,
  type EmbeddingProviderName,
} from "../lib/api";

export function UserCenterPage(): JSX.Element {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery({
    queryKey: ["user", "preferences"],
    queryFn: getUserPreferences,
  });
  const embeddingSettingsQuery = useQuery({
    queryKey: ["embedding", "settings"],
    queryFn: getEmbeddingSettings,
    refetchInterval: (query) => (query.state.data?.index.status === "rebuilding" ? 2_000 : false),
  });
  const memoryQuery = useQuery({
    queryKey: ["user", "memory"],
    queryFn: getUserMemory,
  });
  const historyQuery = useQuery({
    queryKey: ["user", "history"],
    queryFn: () => getHistory(),
  });
  const favoritesQuery = useQuery({
    queryKey: ["user", "favorites"],
    queryFn: () => getFavorites(),
  });

  const [interestTagsDraft, setInterestTagsDraft] = useState("");
  const [defaultLanguage, setDefaultLanguage] = useState("zh");
  const [summaryLength, setSummaryLength] = useState("short");
  const [dailyRecommendCount, setDailyRecommendCount] = useState("10");
  // Embedding form state
  const [embeddingProvider, setEmbeddingProvider] = useState<EmbeddingProviderName>("openai");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingApiKeyDraft, setEmbeddingApiKeyDraft] = useState("");

  useEffect(() => {
    if (!preferencesQuery.data) {
      return;
    }

    setInterestTagsDraft(JSON.parse(preferencesQuery.data.interest_tags ?? "[]").join(", "));
    setDefaultLanguage(preferencesQuery.data.default_language ?? "zh");
    setSummaryLength(preferencesQuery.data.summary_length ?? "short");
    setDailyRecommendCount(preferencesQuery.data.daily_recommend_count ?? "10");
  }, [preferencesQuery.data]);

  useEffect(() => {
    if (!embeddingSettingsQuery.data) {
      return;
    }
    const data = embeddingSettingsQuery.data;
    if (data.provider === "openai" || data.provider === "ollama") {
      setEmbeddingProvider(data.provider);
    }
    setEmbeddingModel(data.model ?? "");
    setEmbeddingBaseUrl(data.baseUrl ?? "");
    setEmbeddingApiKeyDraft("");
  }, [embeddingSettingsQuery.data]);

  const savePreferencesMutation = useMutation({
    mutationFn: async () =>
      saveUserPreferences({
        interest_tags: JSON.stringify(
          interestTagsDraft
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
        default_language: defaultLanguage,
        summary_length: summaryLength,
        daily_recommend_count: dailyRecommendCount,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user", "preferences"] });
      await queryClient.invalidateQueries({ queryKey: ["home", "personalized"] });
    },
  });

  const rebuildMemoryMutation = useMutation({
    mutationFn: rebuildUserMemory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user", "memory"] });
      await queryClient.invalidateQueries({ queryKey: ["home", "personalized"] });
    },
  });

  const testEmbeddingMutation = useMutation({
    mutationFn: testEmbeddingConnection,
  });

  const saveEmbeddingSettingsMutation = useMutation({
    mutationFn: () =>
      saveEmbeddingSettings({
        provider: embeddingProvider,
        model: embeddingModel || undefined,
        baseUrl: embeddingBaseUrl || undefined,
        ...(embeddingApiKeyDraft.trim() ? { apiKey: embeddingApiKeyDraft.trim() } : {}),
      }),
    onSuccess: async () => {
      setEmbeddingApiKeyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["embedding", "settings"] });
    },
  });

  const clearEmbeddingApiKeyMutation = useMutation({
    mutationFn: () =>
      saveEmbeddingSettings({
        provider: embeddingProvider,
        model: embeddingModel || undefined,
        baseUrl: embeddingBaseUrl || undefined,
        clearApiKey: true,
      }),
    onSuccess: async () => {
      setEmbeddingApiKeyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["embedding", "settings"] });
    },
  });

  const rebuildEmbeddingMutation = useMutation({
    mutationFn: rebuildEmbeddingIndex,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["embedding", "settings"] });
      await queryClient.invalidateQueries({ queryKey: ["search", "coverage"] });
    },
  });

  const removeFavoriteMutation = useMutation({
    mutationFn: removeFavorite,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user", "favorites"] });
      await queryClient.invalidateQueries({ queryKey: ["home", "personalized"] });
    },
  });

  return (
    <div className="page-grid profile-grid">
      <section className="content-panel">
        <SectionHeader
          description="Adjust explicit interests, reading defaults, and the size of the recommendation surface."
          kicker="Controls"
          title="Profile settings"
        />
        {preferencesQuery.isLoading ? <LoadingBlock /> : null}
        <div className="settings-grid">
          <label className="field">
            <span>Interest tags</span>
            <textarea
              className="field-input field-textarea"
              onChange={(event) => setInterestTagsDraft(event.target.value)}
              rows={3}
              value={interestTagsDraft}
            />
          </label>
          <label className="field">
            <span>Default language</span>
            <select
              className="field-input"
              onChange={(event) => setDefaultLanguage(event.target.value)}
              value={defaultLanguage}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field">
            <span>Summary length</span>
            <select
              className="field-input"
              onChange={(event) => setSummaryLength(event.target.value)}
              value={summaryLength}
            >
              <option value="short">Short</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
          <label className="field">
            <span>Daily recommendation count</span>
            <input
              className="field-input"
              onChange={(event) => setDailyRecommendCount(event.target.value)}
              value={dailyRecommendCount}
            />
          </label>
          <button className="primary-button" onClick={() => savePreferencesMutation.mutate()} type="button">
            Save preferences
          </button>
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          description="Configure the embedding model used for semantic search. Changes take effect immediately; rebuild the vector index if you switch models."
          kicker="Search"
          title="Embedding connection"
        />
        {embeddingSettingsQuery.isLoading ? <LoadingBlock /> : null}
        {embeddingSettingsQuery.data ? (
          <div className="settings-grid">
            <label className="field">
              <span>Provider</span>
              <select
                className="field-input"
                id="embedding-provider"
                onChange={(event) => {
                  const p = event.target.value as EmbeddingProviderName;
                  setEmbeddingProvider(p);
                  setEmbeddingApiKeyDraft("");
                  // Pre-fill sensible base URL defaults when switching providers
                  if (p === "ollama") {
                    setEmbeddingBaseUrl((prev) =>
                      !prev || prev === "https://api.openai.com/v1"
                        ? "http://127.0.0.1:11434"
                        : prev,
                    );
                  } else {
                    setEmbeddingBaseUrl((prev) =>
                      !prev || prev === "http://127.0.0.1:11434"
                        ? "https://api.openai.com/v1"
                        : prev,
                    );
                  }
                }}
                value={embeddingProvider}
              >
                <option value="openai">OpenAI (API)</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input
                className="field-input"
                id="embedding-model"
                onChange={(event) => setEmbeddingModel(event.target.value)}
                placeholder={
                  embeddingProvider === "ollama"
                    ? "e.g. qwen3-embedding:0.6b"
                    : "e.g. text-embedding-3-small"
                }
                value={embeddingModel}
              />
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                className="field-input"
                id="embedding-base-url"
                onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
                placeholder={
                  embeddingProvider === "ollama"
                    ? "http://127.0.0.1:11434"
                    : "https://api.openai.com/v1"
                }
                type="url"
                value={embeddingBaseUrl}
              />
            </label>
            {embeddingProvider === "openai" ? (
              <label className="field">
                <span>API key</span>
                <input
                  autoComplete="off"
                  className="field-input"
                  id="embedding-api-key"
                  onChange={(event) => setEmbeddingApiKeyDraft(event.target.value)}
                  placeholder={
                    embeddingSettingsQuery.data.hasApiKey &&
                    embeddingSettingsQuery.data.source === "stored"
                      ? "A key is already configured; leave blank to keep it"
                      : "Paste your embedding API key"
                  }
                  type="password"
                  value={embeddingApiKeyDraft}
                />
              </label>
            ) : null}
            <div className="field">
              <span>Detected dimensions</span>
              <strong>
                {testEmbeddingMutation.data?.dimensions ??
                  embeddingSettingsQuery.data.index.dimensions ??
                  "Not probed"}
              </strong>
            </div>
            <p className="settings-note" role="status">
              {embeddingSettingsStatus(embeddingSettingsQuery.data, embeddingProvider)}
            </p>
            <p className="settings-note" role="status">
              Index {embeddingSettingsQuery.data.index.status}: {embeddingSettingsQuery.data.index.ready}/
              {embeddingSettingsQuery.data.index.total} ready,{" "}
              {embeddingSettingsQuery.data.index.pending + embeddingSettingsQuery.data.index.running} pending,{" "}
              {embeddingSettingsQuery.data.index.failed} failed.
            </p>
            {embeddingSettingsQuery.data.index.lastError ? (
              <p className="settings-error">{embeddingSettingsQuery.data.index.lastError}</p>
            ) : null}
            {saveEmbeddingSettingsMutation.error ? (
              <p className="settings-error">{saveEmbeddingSettingsMutation.error.message}</p>
            ) : null}
            {testEmbeddingMutation.error ? (
              <p className="settings-error">{testEmbeddingMutation.error.message}</p>
            ) : null}
            {rebuildEmbeddingMutation.error ? (
              <p className="settings-error">{rebuildEmbeddingMutation.error.message}</p>
            ) : null}
            <div className="toolbar-inline">
              <button
                className="primary-button"
                disabled={saveEmbeddingSettingsMutation.isPending}
                id="save-embedding-settings"
                onClick={() => saveEmbeddingSettingsMutation.mutate()}
                type="button"
              >
                {saveEmbeddingSettingsMutation.isPending ? "Saving..." : "Save embedding settings"}
              </button>
              {embeddingSettingsQuery.data.source === "stored" &&
              embeddingSettingsQuery.data.hasApiKey &&
              embeddingProvider === "openai" ? (
                <button
                  className="secondary-button"
                  disabled={clearEmbeddingApiKeyMutation.isPending}
                  id="clear-embedding-api-key"
                  onClick={() => clearEmbeddingApiKeyMutation.mutate()}
                  type="button"
                >
                  Remove saved key
                </button>
              ) : null}
              <button
                className="secondary-button"
                disabled={testEmbeddingMutation.isPending}
                id="test-embedding-connection"
                onClick={() => testEmbeddingMutation.mutate()}
                type="button"
              >
                {testEmbeddingMutation.isPending ? "Testing..." : "Test connection"}
              </button>
              <button
                className="primary-button"
                disabled={rebuildEmbeddingMutation.isPending}
                id="rebuild-vector-index"
                onClick={() => rebuildEmbeddingMutation.mutate()}
                type="button"
              >
                {rebuildEmbeddingMutation.isPending ? "Starting..." : "Rebuild vector index"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <LlmConnectionsPanel />

      <section className="content-panel">
        <SectionHeader
          description="These are the long-lived terms currently extracted from recent digests and weighted into the profile."
          kicker="Memory"
          title="User memory"
        />
        <div className="toolbar-inline">
          <button className="secondary-button" onClick={() => rebuildMemoryMutation.mutate()} type="button">
            Rebuild memory
          </button>
        </div>
        {memoryQuery.isLoading ? <LoadingBlock /> : null}
        {(memoryQuery.data?.length ?? 0) === 0 && !memoryQuery.isLoading ? (
          <EmptyBlock
            description="Memory will appear after the first digest rebuild."
            title="No memory terms yet"
          />
        ) : null}
        <div className="memory-grid">
          {memoryQuery.data?.map((term) => (
            <article className="memory-card" key={`${term.category}-${term.term}`}>
              <p className="memory-category">{term.category}</p>
              <h3>{term.term}</h3>
              <p className="memory-weight">weight {term.weight.toFixed(2)}</p>
            </article>
          ))}
        </div>
      </section>

      <div className="dual-column">
        <section className="content-panel">
          <SectionHeader
            description="Recent reading activity is fed back into profile construction and read exclusion."
            kicker="History"
            title="Reading history"
          />
          {historyQuery.isLoading ? <LoadingBlock /> : null}
          {(historyQuery.data?.length ?? 0) === 0 && !historyQuery.isLoading ? (
            <EmptyBlock
              description="Mark a document as read from the detail page to register a reading event."
              title="No history yet"
            />
          ) : null}
          <div className="list-panel">
            {historyQuery.data?.map((item) => (
              <Link className="list-row" key={item.id} to={`/documents/${item.documentId}`}>
                <span>{item.documentId}</span>
                <strong>{new Date(item.viewedAt).toLocaleString("zh-CN")}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="content-panel">
          <SectionHeader
            description="Favorites are pinned research artifacts and are excluded from the default personalized queue."
            kicker="Pinned"
            title="Favorites"
          />
          {favoritesQuery.isLoading ? <LoadingBlock /> : null}
          {(favoritesQuery.data?.length ?? 0) === 0 && !favoritesQuery.isLoading ? (
            <EmptyBlock
              description="Save a paper from the detail page to pin it here."
              title="No favorites yet"
            />
          ) : null}
          <div className="list-panel">
            {favoritesQuery.data?.map((item) => (
              <div className="list-row" key={item.id}>
                <Link to={`/documents/${item.documentId}`}>{item.documentId}</Link>
                <button
                  className="inline-action"
                  onClick={() => removeFavoriteMutation.mutate(item.documentId)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function embeddingSettingsStatus(
  settings: Awaited<ReturnType<typeof getEmbeddingSettings>> | undefined,
  selectedProvider: "openai" | "ollama",
): string {
  if (!settings) {
    return "Save to activate this embedding configuration.";
  }
  if (settings.source === "environment") {
    return "Configuration is set via environment variables and cannot be overridden here.";
  }
  if (settings.source === "stored") {
    if (selectedProvider === "openai" && !settings.hasApiKey) {
      return "Saved — but no API key stored. Semantic search will fail until a key is saved.";
    }
    return "Embedding settings saved. Rebuild the vector index if you changed the model.";
  }
  // "default"
  if (selectedProvider === "ollama") {
    return "Using built-in defaults. Save to apply your Ollama configuration.";
  }
  return "Using built-in defaults. Save to persist your configuration.";
}
