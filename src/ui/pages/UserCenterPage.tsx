import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyBlock, LoadingBlock, SectionHeader } from "../components";
import {
  getFavorites,
  getHistory,
  getLlmSettings,
  getUserMemory,
  getUserPreferences,
  rebuildUserMemory,
  removeFavorite,
  saveLlmSettings,
  saveUserPreferences,
  type LlmProviderName,
} from "../lib/api";

export function UserCenterPage(): JSX.Element {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery({
    queryKey: ["user", "preferences"],
    queryFn: getUserPreferences,
  });
  const llmSettingsQuery = useQuery({
    queryKey: ["llm", "settings"],
    queryFn: getLlmSettings,
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
  const [llmProvider, setLlmProvider] = useState<LlmProviderName>("deepseek");
  const [llmApiKeyDraft, setLlmApiKeyDraft] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");

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
    if (!llmSettingsQuery.data) {
      return;
    }

    setLlmProvider(llmSettingsQuery.data.provider);
    setLlmModel(llmSettingsQuery.data.model);
    setLlmBaseUrl(llmSettingsQuery.data.baseUrl);
    setLlmApiKeyDraft("");
  }, [llmSettingsQuery.data]);

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

  const saveLlmSettingsMutation = useMutation({
    mutationFn: () =>
      saveLlmSettings({
        provider: llmProvider,
        ...(llmApiKeyDraft.trim() ? { apiKey: llmApiKeyDraft.trim() } : {}),
        model: llmModel,
        baseUrl: llmBaseUrl,
      }),
    onSuccess: async () => {
      setLlmApiKeyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["llm", "settings"] });
    },
  });

  const clearLlmApiKeyMutation = useMutation({
    mutationFn: () =>
      saveLlmSettings({
        provider: llmProvider,
        clearApiKey: true,
        model: llmModel,
        baseUrl: llmBaseUrl,
      }),
    onSuccess: async () => {
      setLlmApiKeyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["llm", "settings"] });
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
          description="Configure the provider used for summaries, tags, and search reports. API keys stay on this device and are never shown again."
          kicker="AI"
          title="LLM connection"
        />
        {llmSettingsQuery.isLoading ? <LoadingBlock /> : null}
        <div className="settings-grid">
          <label className="field">
            <span>Provider</span>
            <select
              className="field-input"
              onChange={(event) => {
                setLlmProvider(event.target.value as LlmProviderName);
                setLlmApiKeyDraft("");
                setLlmModel("");
                setLlmBaseUrl("");
              }}
              value={llmProvider}
            >
              {(
                llmSettingsQuery.data?.supportedProviders ?? [
                  "deepseek",
                  "openai",
                  "anthropic",
                  "openrouter",
                  "github-copilot",
                ]
              ).map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>API key</span>
            <input
              autoComplete="off"
              className="field-input"
              onChange={(event) => setLlmApiKeyDraft(event.target.value)}
              placeholder={
                llmSettingsQuery.data?.hasApiKey && llmSettingsQuery.data.provider === llmProvider
                  ? "A key is already configured; leave blank to keep it"
                  : "Paste the provider API key"
              }
              type="password"
              value={llmApiKeyDraft}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              className="field-input"
              onChange={(event) => setLlmModel(event.target.value)}
              placeholder="Use the provider default"
              value={llmModel}
            />
          </label>
          <label className="field">
            <span>API base URL</span>
            <input
              className="field-input"
              onChange={(event) => setLlmBaseUrl(event.target.value)}
              placeholder="Use the provider default endpoint"
              type="url"
              value={llmBaseUrl}
            />
          </label>
          <p className="settings-note" role="status">
            {llmSettingsStatus(llmSettingsQuery.data, llmProvider)}
          </p>
          {saveLlmSettingsMutation.error ? (
            <p className="settings-error">{saveLlmSettingsMutation.error.message}</p>
          ) : null}
          <div className="toolbar-inline">
            <button
              className="primary-button"
              disabled={saveLlmSettingsMutation.isPending}
              onClick={() => saveLlmSettingsMutation.mutate()}
              type="button"
            >
              {saveLlmSettingsMutation.isPending ? "Saving..." : "Save LLM settings"}
            </button>
            {llmSettingsQuery.data?.apiKeySource === "stored" &&
            llmSettingsQuery.data.provider === llmProvider ? (
              <button
                className="secondary-button"
                disabled={clearLlmApiKeyMutation.isPending}
                onClick={() => clearLlmApiKeyMutation.mutate()}
                type="button"
              >
                Remove saved key
              </button>
            ) : null}
          </div>
        </div>
      </section>

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

function providerLabel(provider: LlmProviderName): string {
  const labels: Record<LlmProviderName, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    "github-copilot": "GitHub Models",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
  };
  return labels[provider];
}

function llmSettingsStatus(
  settings: Awaited<ReturnType<typeof getLlmSettings>> | undefined,
  selectedProvider: LlmProviderName,
): string {
  if (!settings || settings.provider !== selectedProvider) {
    return "Save to activate this provider.";
  }
  if (settings.apiKeySource === "stored") {
    return "API key configured locally. New LLM requests will use these settings.";
  }
  if (settings.apiKeySource === "environment") {
    return "Using an API key from the process environment.";
  }
  return "No API key configured. LLM requests will fail until a key is saved.";
}
