import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { LLM_CONNECTION_UI } from "@/i18n";
import { LoadingBlock, SectionHeader } from "./components";
import {
  activateLlmConnection,
  createLlmConnection,
  deleteLlmConnection,
  discoverLlmConnectionModels,
  getLlmCatalog,
  getLlmConnections,
  testLlmConnection,
  updateLlmConnection,
  type LlmConnection,
  type LlmConnectionPayload,
  type LlmProviderPreset,
} from "./lib/api";

const text = Object.fromEntries(Object.entries(LLM_CONNECTION_UI).map(([key, value]) => [key, value.zh])) as {
  [K in keyof typeof LLM_CONNECTION_UI]: string;
};

interface DraftState {
  connection: LlmConnectionPayload;
  requestHeadersText: string;
  requestBodyText: string;
  modelsText: string;
}

export function LlmConnectionsPanel(): JSX.Element {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ queryKey: ["llm", "catalog"], queryFn: getLlmCatalog });
  const connectionsQuery = useQuery({
    queryKey: ["llm", "connections"],
    queryFn: getLlmConnections,
  });
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [formError, setFormError] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);

  const connections = connectionsQuery.data?.connections ?? [];
  const selectedId = draft?.connection.id ?? null;
  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId),
    [connections, selectedId],
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["llm", "connections"] });
    await queryClient.invalidateQueries({ queryKey: ["llm", "settings"] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({ activate }: { activate: boolean }) => {
      const payload = buildPayload(draft);
      const saved = payload.id
        ? await updateLlmConnection(payload.id, payload)
        : await createLlmConnection(payload);
      if (activate) await activateLlmConnection(saved.id);
      return saved;
    },
    onSuccess: async (saved) => {
      setDraft(toDraft(saved));
      setFormError("");
      await refresh();
    },
    onError: (error) => setFormError(error.message),
  });

  const activateMutation = useMutation({
    mutationFn: activateLlmConnection,
    onSuccess: refresh,
  });
  const deleteMutation = useMutation({
    mutationFn: deleteLlmConnection,
    onSuccess: async (_deleted, deletedId) => {
      await refresh();
      const remaining =
        queryClient.getQueryData<{ connections: LlmConnection[] }>(["llm", "connections"])?.connections ??
        connections.filter((connection) => connection.id !== deletedId);
      const next = remaining.find((connection) => connection.isActive) ?? remaining[0] ?? null;
      setDraft(next ? toDraft(next) : null);
    },
  });
  const testMutation = useMutation({
    mutationFn: () => testLlmConnection(buildPayload(draft)),
    onSuccess: refresh,
    onError: (error) => setFormError(error.message),
  });
  const modelsMutation = useMutation({
    mutationFn: () => discoverLlmConnectionModels(buildPayload(draft)),
    onSuccess: setDiscoveredModels,
    onError: (error) => setFormError(error.message),
  });

  useEffect(() => {
    if (draft || connections.length === 0) return;
    const initial = connections.find((connection) => connection.isActive) ?? connections[0]!;
    setDraft(toDraft(initial));
  }, [connections, draft]);

  const selectConnection = (connection: LlmConnection) => {
    setDraft(toDraft(connection));
    setDiscoveredModels([]);
    setFormError("");
    testMutation.reset();
    modelsMutation.reset();
  };

  const createFromPreset = (preset: LlmProviderPreset) => {
    setDraft(toDraftFromPreset(preset));
    setDiscoveredModels([]);
    setFormError("");
    testMutation.reset();
    modelsMutation.reset();
  };
  const patchConnection = (patch: Partial<LlmConnectionPayload>) => {
    setDraft((current) =>
      current ? { ...current, connection: { ...current.connection, ...patch } } : current,
    );
  };
  const insecureRemoteHttp =
    draft?.connection.baseUrl.startsWith("http://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(draft.connection.baseUrl);

  return (
    <section className="content-panel">
      <SectionHeader description={text.description} kicker={text.kicker} title={text.title} />
      {catalogQuery.isLoading || connectionsQuery.isLoading ? <LoadingBlock /> : null}
      {connectionsQuery.data?.environmentOverride ? (
        <p className="settings-warning" role="status">
          {text.environmentOverride}
        </p>
      ) : null}
      <div className="connection-manager">
        <aside className="connection-sidebar">
          <div className="connection-sidebar-heading">
            <strong>{text.connectionList}</strong>
            <select
              aria-label={text.newConnection}
              className="field-input compact-input"
              onChange={(event) => {
                const preset = catalogQuery.data?.find((item) => item.id === event.target.value);
                if (preset) createFromPreset(preset);
                event.target.value = "";
              }}
              value=""
            >
              <option value="">{text.newConnection}</option>
              {catalogQuery.data?.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
          <div className="connection-list">
            {connections.map((connection) => (
              <button
                className={`connection-list-item${selectedId === connection.id ? " active" : ""}`}
                key={connection.id}
                aria-pressed={selectedId === connection.id}
                onClick={() => selectConnection(connection)}
                type="button"
              >
                <span>
                  <strong>{connection.name}</strong>
                  <small>{connection.model}</small>
                </span>
                {connection.isActive ? <em>{text.active}</em> : null}
              </button>
            ))}
          </div>
        </aside>

        <div
          className="connection-editor"
          key={draft?.connection.id ?? `draft-${draft?.connection.presetId ?? "custom"}`}
        >
          {draft ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>{text.connectionName}</span>
                  <input
                    className="field-input"
                    onChange={(e) => patchConnection({ name: e.target.value })}
                    value={draft.connection.name}
                  />
                </label>
                <label className="field">
                  <span>{text.providerPreset}</span>
                  <select
                    className="field-input"
                    onChange={(event) => {
                      const preset = catalogQuery.data?.find((item) => item.id === event.target.value);
                      if (preset) createFromPreset(preset);
                    }}
                    value={draft.connection.presetId ?? "custom"}
                  >
                    {catalogQuery.data?.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>{text.apiKey}</span>
                <input
                  autoComplete="off"
                  className="field-input"
                  onChange={(e) => patchConnection({ apiKey: e.target.value, clearApiKey: false })}
                  placeholder={
                    selected?.hasApiKey && !draft.connection.clearApiKey ? text.keepKey : text.pasteKey
                  }
                  type="password"
                  value={draft.connection.apiKey ?? ""}
                />
              </label>

              <div className="form-grid">
                <label className="field">
                  <span>{text.baseUrl}</span>
                  <input
                    className="field-input"
                    onChange={(e) => patchConnection({ baseUrl: e.target.value })}
                    type="url"
                    value={draft.connection.baseUrl}
                  />
                </label>
                <label className="field">
                  <span>{text.model}</span>
                  <input
                    className="field-input"
                    list="llm-discovered-models"
                    onChange={(e) => patchConnection({ model: e.target.value })}
                    value={draft.connection.model}
                  />
                  <datalist id="llm-discovered-models">
                    {discoveredModels.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </label>
              </div>

              {insecureRemoteHttp ? <p className="settings-warning">{text.insecureHttp}</p> : null}
              {!draft.connection.models ? <p className="settings-note">{text.noModelDiscovery}</p> : null}

              <details className="connection-advanced">
                <summary>{text.advanced}</summary>
                <div className="settings-grid">
                  <div className="form-grid">
                    <label className="field">
                      <span>{text.protocol}</span>
                      <select
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({ protocol: e.target.value as LlmConnectionPayload["protocol"] })
                        }
                        value={draft.connection.protocol}
                      >
                        <option value="openai_chat">OpenAI Chat</option>
                        <option value="anthropic_messages">Anthropic Messages</option>
                        <option value="gemini_generate_content">Gemini GenerateContent</option>
                        <option value="custom_json">Custom JSON</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{text.authType}</span>
                      <select
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({
                            auth: { type: e.target.value as LlmConnectionPayload["auth"]["type"] },
                          })
                        }
                        value={draft.connection.auth.type}
                      >
                        <option value="bearer">Bearer</option>
                        <option value="header">Header</option>
                        <option value="query">Query</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                  </div>
                  {draft.connection.auth.type === "header" ? (
                    <label className="field">
                      <span>{text.authHeader}</span>
                      <input
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({ auth: { ...draft.connection.auth, headerName: e.target.value } })
                        }
                        value={draft.connection.auth.headerName ?? ""}
                      />
                    </label>
                  ) : null}
                  {draft.connection.auth.type === "query" ? (
                    <label className="field">
                      <span>{text.authQuery}</span>
                      <input
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({ auth: { ...draft.connection.auth, queryParam: e.target.value } })
                        }
                        value={draft.connection.auth.queryParam ?? ""}
                      />
                    </label>
                  ) : null}
                  <div className="form-grid">
                    <label className="field">
                      <span>{text.requestMethod}</span>
                      <select
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({
                            request: {
                              ...draft.connection.request,
                              method: e.target.value as "POST" | "PUT",
                            },
                          })
                        }
                        value={draft.connection.request.method}
                      >
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{text.requestPath}</span>
                      <input
                        className="field-input"
                        onChange={(e) =>
                          patchConnection({ request: { ...draft.connection.request, path: e.target.value } })
                        }
                        value={draft.connection.request.path}
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span>{text.requestHeaders}</span>
                    <textarea
                      className="field-input field-code"
                      onChange={(e) => setDraft({ ...draft, requestHeadersText: e.target.value })}
                      rows={4}
                      value={draft.requestHeadersText}
                    />
                  </label>
                  <label className="field">
                    <span>{text.requestBody}</span>
                    <textarea
                      className="field-input field-code"
                      onChange={(e) => setDraft({ ...draft, requestBodyText: e.target.value })}
                      rows={10}
                      value={draft.requestBodyText}
                    />
                  </label>
                  <label className="field">
                    <span>{text.responsePath}</span>
                    <input
                      className="field-input"
                      onChange={(e) =>
                        patchConnection({
                          request: { ...draft.connection.request, responsePath: e.target.value },
                        })
                      }
                      value={draft.connection.request.responsePath}
                    />
                  </label>
                  <label className="field">
                    <span>{text.modelsTemplate}</span>
                    <textarea
                      className="field-input field-code"
                      onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
                      rows={8}
                      value={draft.modelsText}
                    />
                  </label>
                </div>
              </details>

              {formError ? <p className="settings-error">{formError}</p> : null}
              {testMutation.data ? (
                <p className="settings-success" role="status">
                  {text.testSuccess} · {testMutation.data.latencyMs} ms · {testMutation.data.responsePreview}
                </p>
              ) : null}
              {selected?.lastTestStatus ? (
                <p className="settings-note">
                  {text.lastTest}: {selected.lastTestStatus} · {selected.lastTestMessage}
                </p>
              ) : null}

              <div className="toolbar-inline">
                <button
                  className="secondary-button"
                  disabled={!draft.connection.models || modelsMutation.isPending}
                  onClick={() => {
                    setFormError("");
                    modelsMutation.mutate();
                  }}
                  type="button"
                >
                  {modelsMutation.isPending ? "..." : text.discoverModels}
                </button>
                <button
                  className="secondary-button"
                  disabled={testMutation.isPending}
                  onClick={() => {
                    setFormError("");
                    testMutation.mutate();
                  }}
                  type="button"
                >
                  {testMutation.isPending ? "..." : text.test}
                </button>
                <button
                  className="secondary-button"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: false })}
                  type="button"
                >
                  {text.save}
                </button>
                <button
                  className="primary-button"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: true })}
                  type="button"
                >
                  {text.saveActivate}
                </button>
                {selected && !selected.isActive ? (
                  <button
                    className="secondary-button"
                    disabled={activateMutation.isPending}
                    onClick={() => activateMutation.mutate(selected.id)}
                    type="button"
                  >
                    {text.activate}
                  </button>
                ) : null}
                {selected?.hasApiKey ? (
                  <button
                    className="secondary-button"
                    onClick={() => patchConnection({ apiKey: "", clearApiKey: true })}
                    type="button"
                  >
                    {text.removeKey}
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  onClick={() => {
                    setDraft({
                      ...draft,
                      connection: {
                        ...draft.connection,
                        id: undefined,
                        name: `${draft.connection.name} Copy`,
                        apiKey: "",
                        clearApiKey: false,
                      },
                    });
                  }}
                  type="button"
                >
                  {text.duplicate}
                </button>
                {selected && !selected.isActive ? (
                  <button
                    className="inline-action danger-action"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`${text.delete}: ${selected.name}?`))
                        deleteMutation.mutate(selected.id);
                    }}
                    type="button"
                  >
                    {text.delete}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="settings-note">{text.newConnection}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function toDraft(connection: LlmConnection): DraftState {
  return {
    connection: {
      id: connection.id,
      name: connection.name,
      presetId: connection.presetId,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      model: connection.model,
      auth: structuredClone(connection.auth),
      request: structuredClone(connection.request),
      models: connection.models ? structuredClone(connection.models) : null,
    },
    requestHeadersText: JSON.stringify(connection.request.headers, null, 2),
    requestBodyText: JSON.stringify(connection.request.body, null, 2),
    modelsText: JSON.stringify(connection.models, null, 2),
  };
}

function toDraftFromPreset(preset: LlmProviderPreset): DraftState {
  return {
    connection: {
      name: preset.label,
      presetId: preset.id === "custom" ? null : preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
      auth: structuredClone(preset.auth),
      request: structuredClone(preset.request),
      models: preset.models ? structuredClone(preset.models) : null,
    },
    requestHeadersText: JSON.stringify(preset.request.headers, null, 2),
    requestBodyText: JSON.stringify(preset.request.body, null, 2),
    modelsText: JSON.stringify(preset.models, null, 2),
  };
}

function buildPayload(draft: DraftState | null): LlmConnectionPayload {
  if (!draft) throw new Error(text.structuralError);
  try {
    return {
      ...draft.connection,
      request: {
        ...draft.connection.request,
        headers: JSON.parse(draft.requestHeadersText) as Record<string, string>,
        body: JSON.parse(draft.requestBodyText) as unknown,
      },
      models: JSON.parse(draft.modelsText) as LlmConnectionPayload["models"],
    };
  } catch {
    throw new Error(text.structuralError);
  }
}
