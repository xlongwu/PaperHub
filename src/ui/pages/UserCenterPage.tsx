import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyBlock, LoadingBlock, SectionHeader } from "../components";
import { LlmConnectionsPanel } from "../llm-connections";
import { WebSearchConnectionsPanel } from "../web-search-connections";
import {
  getFavorites,
  getHistory,
  getEmbeddingSettings,
  getWebSearchHealth,
  getWebSearchMetrics,
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
import { USER_CENTER_UI } from "@/i18n";
import { useAppLanguage } from "../app-language";

export function UserCenterPage(): JSX.Element {
  const { language } = useAppLanguage();
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
  const webSearchHealthQuery = useQuery({
    queryKey: ["web-search", "health"],
    queryFn: getWebSearchHealth,
    refetchInterval: 60_000,
  });
  const webSearchMetricsQuery = useQuery({
    queryKey: ["web-search", "metrics"],
    queryFn: getWebSearchMetrics,
    refetchInterval: 60_000,
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
          description={USER_CENTER_UI.profileDescription[language]}
          kicker={USER_CENTER_UI.profileKicker[language]}
          title={USER_CENTER_UI.profileTitle[language]}
        />
        {preferencesQuery.isLoading ? <LoadingBlock /> : null}
        <div className="settings-grid">
          <label className="field">
            <span>{USER_CENTER_UI.interestTagsLabel[language]}</span>
            <textarea
              className="field-input field-textarea"
              onChange={(event) => setInterestTagsDraft(event.target.value)}
              rows={3}
              value={interestTagsDraft}
            />
          </label>
          <label className="field">
            <span>{USER_CENTER_UI.defaultLanguageLabel[language]}</span>
            <select
              className="field-input"
              onChange={(event) => setDefaultLanguage(event.target.value)}
              value={defaultLanguage}
            >
              <option value="zh">{USER_CENTER_UI.languageZh[language]}</option>
              <option value="en">{USER_CENTER_UI.languageEn[language]}</option>
            </select>
          </label>
          <label className="field">
            <span>{USER_CENTER_UI.summaryLengthLabel[language]}</span>
            <select
              className="field-input"
              onChange={(event) => setSummaryLength(event.target.value)}
              value={summaryLength}
            >
              <option value="short">{USER_CENTER_UI.summaryShort[language]}</option>
              <option value="detailed">{USER_CENTER_UI.summaryDetailed[language]}</option>
            </select>
          </label>
          <label className="field">
            <span>{USER_CENTER_UI.dailyRecommendLabel[language]}</span>
            <input
              className="field-input"
              onChange={(event) => setDailyRecommendCount(event.target.value)}
              value={dailyRecommendCount}
            />
          </label>
          <button className="primary-button" onClick={() => savePreferencesMutation.mutate()} type="button">
            {USER_CENTER_UI.savePreferences[language]}
          </button>
        </div>
      </section>

      <section className="content-panel">
        <SectionHeader
          description={USER_CENTER_UI.embeddingDescription[language]}
          kicker={USER_CENTER_UI.embeddingKicker[language]}
          title={USER_CENTER_UI.embeddingTitle[language]}
        />
        {embeddingSettingsQuery.isLoading ? <LoadingBlock /> : null}
        {embeddingSettingsQuery.data ? (
          <div className="settings-grid">
            <label className="field">
              <span>{USER_CENTER_UI.embeddingProviderLabel[language]}</span>
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
                      !prev || prev === "https://api.openai.com/v1" ? "http://127.0.0.1:11434" : prev,
                    );
                  } else {
                    setEmbeddingBaseUrl((prev) =>
                      !prev || prev === "http://127.0.0.1:11434" ? "https://api.openai.com/v1" : prev,
                    );
                  }
                }}
                value={embeddingProvider}
              >
                <option value="openai">{USER_CENTER_UI.embeddingOpenAI[language]}</option>
                <option value="ollama">{USER_CENTER_UI.embeddingOllama[language]}</option>
              </select>
            </label>
            <label className="field">
              <span>{USER_CENTER_UI.embeddingModelLabel[language]}</span>
              <input
                className="field-input"
                id="embedding-model"
                onChange={(event) => setEmbeddingModel(event.target.value)}
                placeholder={
                  embeddingProvider === "ollama" ? "e.g. qwen3-embedding:0.6b" : "e.g. text-embedding-3-small"
                }
                value={embeddingModel}
              />
            </label>
            <label className="field">
              <span>{USER_CENTER_UI.embeddingBaseUrlLabel[language]}</span>
              <input
                className="field-input"
                id="embedding-base-url"
                onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
                placeholder={
                  embeddingProvider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"
                }
                type="url"
                value={embeddingBaseUrl}
              />
            </label>
            {embeddingProvider === "openai" ? (
              <label className="field">
                <span>{USER_CENTER_UI.embeddingApiKeyLabel[language]}</span>
                <input
                  autoComplete="off"
                  className="field-input"
                  id="embedding-api-key"
                  onChange={(event) => setEmbeddingApiKeyDraft(event.target.value)}
                  placeholder={
                    embeddingSettingsQuery.data.hasApiKey && embeddingSettingsQuery.data.source === "stored"
                      ? USER_CENTER_UI.embeddingKeyStored[language]
                      : USER_CENTER_UI.embeddingKeyPlaceholder[language]
                  }
                  type="password"
                  value={embeddingApiKeyDraft}
                />
              </label>
            ) : null}
            <div className="field">
              <span>{USER_CENTER_UI.embeddingDimensionsLabel[language]}</span>
              <strong>
                {testEmbeddingMutation.data?.dimensions ??
                  embeddingSettingsQuery.data.index.dimensions ??
                  USER_CENTER_UI.embeddingNotProbed[language]}
              </strong>
            </div>
            <p className="settings-note" role="status">
              {embeddingSettingsStatus(embeddingSettingsQuery.data, embeddingProvider, language)}
            </p>
            <p className="settings-note" role="status">
              {USER_CENTER_UI.indexStatus(
                embeddingSettingsQuery.data.index.status,
                embeddingSettingsQuery.data.index.ready,
                embeddingSettingsQuery.data.index.total,
                embeddingSettingsQuery.data.index.pending + embeddingSettingsQuery.data.index.running,
                embeddingSettingsQuery.data.index.failed,
              )[language]}
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
                {saveEmbeddingSettingsMutation.isPending ? USER_CENTER_UI.saving[language] : USER_CENTER_UI.saveEmbedding[language]}
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
                  {USER_CENTER_UI.removeKey[language]}
                </button>
              ) : null}
              <button
                className="secondary-button"
                disabled={testEmbeddingMutation.isPending}
                id="test-embedding-connection"
                onClick={() => testEmbeddingMutation.mutate()}
                type="button"
              >
                {testEmbeddingMutation.isPending ? USER_CENTER_UI.testing[language] : USER_CENTER_UI.testConnection[language]}
              </button>
              <button
                className="primary-button"
                disabled={rebuildEmbeddingMutation.isPending}
                id="rebuild-vector-index"
                onClick={() => rebuildEmbeddingMutation.mutate()}
                type="button"
              >
                {rebuildEmbeddingMutation.isPending ? USER_CENTER_UI.starting[language] : USER_CENTER_UI.rebuildIndex[language]}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <LlmConnectionsPanel />
      <WebSearchConnectionsPanel />

      <section className="content-panel">
        <SectionHeader
          description={USER_CENTER_UI.webSearchDescription[language]}
          kicker={USER_CENTER_UI.webSearchKicker[language]}
          title={USER_CENTER_UI.webSearchTitle[language]}
        />
        {webSearchHealthQuery.isLoading || webSearchMetricsQuery.isLoading ? <LoadingBlock /> : null}
        {webSearchHealthQuery.data ? (
          <>
            <div className="memory-grid">
              <article className="memory-card">
                <p className="memory-category">{USER_CENTER_UI.healthLabel[language]}</p>
                <h3>{webSearchHealthQuery.data.status}</h3>
                <p className="memory-weight">
                  {USER_CENTER_UI.enabledProviders(webSearchHealthQuery.data.providers.filter((provider) => provider.enabled).length)[language]}
                </p>
              </article>
              <article className="memory-card">
                <p className="memory-category">{USER_CENTER_UI.searches7d[language]}</p>
                <h3>{webSearchHealthQuery.data.lastSevenDays.searches}</h3>
                <p className="memory-weight">
                  {USER_CENTER_UI.providerFailures((webSearchHealthQuery.data.lastSevenDays.providerFailureRate * 100).toFixed(1))[language]}
                </p>
              </article>
              <article className="memory-card">
                <p className="memory-category">{USER_CENTER_UI.estimatedCredits[language]}</p>
                <h3>{webSearchHealthQuery.data.lastSevenDays.estimatedCredits.toFixed(3)}</h3>
                <p className="memory-weight">{USER_CENTER_UI.storedLocally[language]}</p>
              </article>
              <article className="memory-card">
                <p className="memory-category">{USER_CENTER_UI.tempCache[language]}</p>
                <h3>{webSearchHealthQuery.data.cache.results} {USER_CENTER_UI.resultsCache[language]}</h3>
                <p className="memory-weight">
                  {webSearchHealthQuery.data.cache.content} {USER_CENTER_UI.fetchedPages[language]}
                </p>
              </article>
            </div>
            <p className="settings-note">
              {USER_CENTER_UI.lastCleanup[language]}
              {webSearchHealthQuery.data.maintenance.lastCleanupAt
                ? new Date(webSearchHealthQuery.data.maintenance.lastCleanupAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
                : USER_CENTER_UI.notRecorded[language]}
            </p>
          </>
        ) : null}
        {webSearchMetricsQuery.data ? (
          <div className="list-panel">
            {webSearchMetricsQuery.data.providers.map((provider) => (
              <div className="list-row" key={provider.providerId}>
                <span>{provider.providerId}</span>
                <strong>
                  {provider.calls} {USER_CENTER_UI.calls[language]} · {(provider.successRate * 100).toFixed(0)}% {USER_CENTER_UI.success[language]} · P95{" "}
                  {provider.p95LatencyMs} ms
                </strong>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="content-panel">
        <SectionHeader
          description={USER_CENTER_UI.memoryDescription[language]}
          kicker={USER_CENTER_UI.memoryKicker[language]}
          title={USER_CENTER_UI.memoryTitle[language]}
        />
        <div className="toolbar-inline">
          <button className="secondary-button" onClick={() => rebuildMemoryMutation.mutate()} type="button">
            {USER_CENTER_UI.rebuildMemory[language]}
          </button>
        </div>
        {memoryQuery.isLoading ? <LoadingBlock /> : null}
        {(memoryQuery.data?.length ?? 0) === 0 && !memoryQuery.isLoading ? (
          <EmptyBlock
            description={USER_CENTER_UI.noMemoryDescription[language]}
            title={USER_CENTER_UI.noMemoryTitle[language]}
          />
        ) : null}
        <div className="memory-grid">
          {memoryQuery.data?.map((term) => (
            <article className="memory-card" key={`${term.category}-${term.term}`}>
              <p className="memory-category">{term.category}</p>
              <h3>{term.term}</h3>
              <p className="memory-weight">{USER_CENTER_UI.weightLabel(term.weight.toFixed(2))[language]}</p>
            </article>
          ))}
        </div>
      </section>

      <div className="dual-column">
        <section className="content-panel">
          <SectionHeader
            description={USER_CENTER_UI.historyDescription[language]}
            kicker={USER_CENTER_UI.historyKicker[language]}
            title={USER_CENTER_UI.historyTitle[language]}
          />
          {historyQuery.isLoading ? <LoadingBlock /> : null}
          {(historyQuery.data?.length ?? 0) === 0 && !historyQuery.isLoading ? (
            <EmptyBlock
              description={USER_CENTER_UI.noHistoryDescription[language]}
              title={USER_CENTER_UI.noHistoryTitle[language]}
            />
          ) : null}
          <div className="list-panel">
            {historyQuery.data?.map((item) => (
              <Link className="list-row" key={item.id} to={`/documents/${item.documentId}`}>
                <span>{item.documentId}</span>
                <strong>{new Date(item.viewedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="content-panel">
          <SectionHeader
            description={USER_CENTER_UI.favoritesDescription[language]}
            kicker={USER_CENTER_UI.favoritesKicker[language]}
            title={USER_CENTER_UI.favoritesTitle[language]}
          />
          {favoritesQuery.isLoading ? <LoadingBlock /> : null}
          {(favoritesQuery.data?.length ?? 0) === 0 && !favoritesQuery.isLoading ? (
            <EmptyBlock
              description={USER_CENTER_UI.noFavoritesDescription[language]}
              title={USER_CENTER_UI.noFavoritesTitle[language]}
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
                  {USER_CENTER_UI.removeFavorite[language]}
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
  lang: "zh" | "en",
): string {
  if (!settings) {
    return USER_CENTER_UI.embeddingStatusUnsaved[lang];
  }
  if (settings.source === "environment") {
    return USER_CENTER_UI.embeddingStatusEnv[lang];
  }
  if (settings.source === "stored") {
    if (selectedProvider === "openai" && !settings.hasApiKey) {
      return USER_CENTER_UI.embeddingStatusNoKey[lang];
    }
    return USER_CENTER_UI.embeddingStatusSaved[lang];
  }
  // "default"
  if (selectedProvider === "ollama") {
    return USER_CENTER_UI.embeddingStatusDefaultOllama[lang];
  }
  return USER_CENTER_UI.embeddingStatusDefault[lang];
}
