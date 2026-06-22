import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { WEB_SEARCH_CONNECTION_UI } from "@/i18n";
import type { WebSearchConnection, WebSearchConnectionTestDiagnostic } from "@/web-search/types";
import { LoadingBlock, SectionHeader } from "./components";
import {
  ApiRequestError,
  activateWebSearchConnection,
  getWebSearchConnections,
  saveWebSearchConnection,
  testWebSearchConnection,
} from "./lib/api";

const text = Object.fromEntries(
  Object.entries(WEB_SEARCH_CONNECTION_UI).map(([key, value]) => [key, value.zh]),
) as { [K in keyof typeof WEB_SEARCH_CONNECTION_UI]: string };

export function WebSearchConnectionsPanel(): JSX.Element {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({
    queryKey: ["web-search", "connections"],
    queryFn: getWebSearchConnections,
  });
  return (
    <section className="content-panel">
      <SectionHeader description={text.description} kicker={text.kicker} title={text.title} />
      {connectionsQuery.isLoading ? <LoadingBlock /> : null}
      <div className="stack-grid">
        {PROVIDERS.map((provider) => (
          <ConnectionEditor
            connection={connectionsQuery.data?.find((entry) => entry.provider === provider.id)}
            key={provider.id}
            onRefresh={() =>
              queryClient.invalidateQueries({ queryKey: ["web-search", "connections"] })
            }
            provider={provider}
          />
        ))}
        <McpConnectionEditor
          connection={connectionsQuery.data?.find((entry) => entry.provider === "mcp")}
          onRefresh={() =>
            queryClient.invalidateQueries({ queryKey: ["web-search", "connections"] })
          }
        />
      </div>
    </section>
  );
}

function McpConnectionEditor({
  connection,
  onRefresh,
}: {
  connection: Awaited<ReturnType<typeof getWebSearchConnections>>[number] | undefined;
  onRefresh: () => Promise<unknown>;
}): JSX.Element {
  const [name, setName] = useState("Search MCP");
  const [transport, setTransport] = useState<"stdio" | "streamable_http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:3000/mcp");
  const [apiKey, setApiKey] = useState("");
  const [toolName, setToolName] = useState("search");
  const [inputAdapterJson, setInputAdapterJson] = useState("");
  const [outputAdapterJson, setOutputAdapterJson] = useState("");
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ name: string; description?: string }>>([]);

  useEffect(() => {
    setName(connection?.name ?? "Search MCP");
    setTransport(connection?.settings.mcpTransport ?? "stdio");
    setCommand(connection?.settings.mcpCommand ?? "");
    setArgs((connection?.settings.mcpArgs ?? []).join("\n"));
    setEndpoint(connection?.settings.mcpEndpoint ?? "http://127.0.0.1:3000/mcp");
    setApiKey("");
    setToolName(connection?.settings.mcpToolName ?? "search");
    setInputAdapterJson(formatOptionalJson(connection?.settings.mcpInputAdapter));
    setOutputAdapterJson(formatOptionalJson(connection?.settings.mcpOutputAdapter));
    setDiscoveredTools([]);
  }, [connection]);

  const saveMutation = useMutation({
    mutationFn: (clearApiKey: boolean) => {
      const adapterSettings = parseMcpAdapterSettings(inputAdapterJson, outputAdapterJson);
      return saveWebSearchConnection({
        id: connection?.id,
        provider: "mcp",
        name,
        enabled: true,
        isPrimary: connection?.isPrimary ?? true,
        settings:
          transport === "streamable_http"
            ? {
                mcpTransport: "streamable_http",
                mcpEndpoint: endpoint,
                mcpToolName: toolName,
                ...adapterSettings,
              }
            : {
                mcpTransport: "stdio",
                mcpCommand: command,
                mcpArgs: args
                  .split(/\r?\n/)
                  .map((value) => value.trim())
                  .filter(Boolean),
                mcpToolName: toolName,
                ...adapterSettings,
              },
        apiKey: apiKey.trim() || undefined,
        clearApiKey,
      });
    },
    onSuccess: async () => {
      setApiKey("");
      await onRefresh();
    },
  });
  const activateMutation = useMutation({
    mutationFn: () => activateWebSearchConnection(connection!.id),
    onSuccess: onRefresh,
  });
  const testMutation = useMutation({
    mutationFn: () => testWebSearchConnection(connection!.id),
    onSuccess: async (result) => {
      setDiscoveredTools(result?.discoveredTools ?? []);
      await onRefresh();
    },
  });
  const diagnostic =
    testMutation.data?.diagnostic ?? readConnectionDiagnostic(testMutation.error);

  return (
    <div className="settings-grid empty-block">
      <p className="empty-title">Search MCP</p>
      <label className="field">
        <span>{`Search MCP ${text.name}`}</span>
        <input className="field-input" onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <label className="field">
        <span>{text.mcpTransport}</span>
        <select
          className="field-input"
          onChange={(event) => setTransport(event.target.value as "stdio" | "streamable_http")}
          value={transport}
        >
          <option value="stdio">stdio</option>
          <option value="streamable_http">streamable_http</option>
        </select>
      </label>
      {transport === "streamable_http" ? (
        <>
          <label className="field">
            <span>{text.mcpEndpoint}</span>
            <input
              className="field-input"
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="http://127.0.0.1:3000/mcp"
              type="url"
              value={endpoint}
            />
          </label>
          <label className="field">
            <span>{text.authToken}</span>
            <input
              autoComplete="off"
              className="field-input"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={connection?.hasApiKey ? text.keepKey : ""}
              type="password"
              value={apiKey}
            />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>{text.command}</span>
            <input
              className="field-input"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="node"
              value={command}
            />
          </label>
          <label className="field">
            <span>{text.arguments}</span>
            <textarea
              className="field-input"
              onChange={(event) => setArgs(event.target.value)}
              placeholder={"path/to/search-mcp.js\n--stdio"}
              rows={3}
              value={args}
            />
          </label>
        </>
      )}
      <label className="field">
        <span>{text.toolName}</span>
        <input
          className="field-input"
          onChange={(event) => setToolName(event.target.value)}
          value={toolName}
        />
      </label>
      <label className="field">
        <span>{text.inputAdapter}</span>
        <textarea
          className="field-input"
          onChange={(event) => setInputAdapterJson(event.target.value)}
          placeholder={'{"query":"query","limit":"limit"}'}
          rows={3}
          value={inputAdapterJson}
        />
      </label>
      <label className="field">
        <span>{text.outputAdapter}</span>
        <textarea
          className="field-input"
          onChange={(event) => setOutputAdapterJson(event.target.value)}
          placeholder={'{"itemsPath":"items","fields":{"title":"title","url":"url"}}'}
          rows={4}
          value={outputAdapterJson}
        />
      </label>
      <p className="settings-note">
        {connection
          ? `${connection.isPrimary ? text.active : "Enabled"}${
              connection.lastTestStatus ? ` · ${connection.lastTestStatus}` : ""
            }${connection.lastTestMessage ? ` · ${connection.lastTestMessage}` : ""}`
          : text.notConfigured}
      </p>
      {saveMutation.error || activateMutation.error || testMutation.error ? (
        <p className="settings-error">
          {(saveMutation.error || activateMutation.error || testMutation.error)?.message}
        </p>
      ) : null}
      {diagnostic ? (
        <p className="settings-note">
          <strong>{text.diagnostic}: </strong>
          {`${diagnostic.stage} / ${diagnostic.code} · ${
            diagnostic.retryable ? text.retryable : text.notRetryable
          }`}
        </p>
      ) : null}
      {discoveredTools.length > 0 ? (
        <div className="settings-note">
          <strong>{text.discoveredTools}: </strong>
          {discoveredTools.map((tool) => tool.name).join(", ")}
        </div>
      ) : null}
      <div className="toolbar-inline">
        <button className="primary-button" onClick={() => saveMutation.mutate(false)} type="button">
          {text.save}
        </button>
        {connection && !connection.isPrimary ? (
          <button className="secondary-button" onClick={() => activateMutation.mutate()} type="button">
            {text.activate}
          </button>
        ) : null}
        {connection ? (
          <button className="secondary-button" onClick={() => testMutation.mutate()} type="button">
            {text.test}
          </button>
        ) : null}
        {connection?.hasApiKey ? (
          <button className="secondary-button" onClick={() => saveMutation.mutate(true)} type="button">
            {text.removeKey}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatOptionalJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function parseMcpAdapterSettings(
  inputAdapterJson: string,
  outputAdapterJson: string,
): Pick<WebSearchConnection["settings"], "mcpInputAdapter" | "mcpOutputAdapter"> {
  return {
    mcpInputAdapter: parseOptionalJsonObject(inputAdapterJson) as WebSearchConnection["settings"]["mcpInputAdapter"],
    mcpOutputAdapter: parseOptionalJsonObject(outputAdapterJson) as WebSearchConnection["settings"]["mcpOutputAdapter"],
  };
}

function parseOptionalJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(text.invalidJson);
  }
}

function readConnectionDiagnostic(error: unknown): WebSearchConnectionTestDiagnostic | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const diagnostic = error.details?.diagnostic;
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return undefined;
  return diagnostic as WebSearchConnectionTestDiagnostic;
}

const PROVIDERS = [
  { id: "openalex" as const, name: "OpenAlex", baseUrl: "https://api.openalex.org" },
  { id: "tavily" as const, name: "Tavily", baseUrl: "https://api.tavily.com" },
  {
    id: "brave" as const,
    name: "Brave Search",
    baseUrl: "https://api.search.brave.com/res/v1",
  },
];

function ConnectionEditor({
  connection,
  onRefresh,
  provider,
}: {
  connection: Awaited<ReturnType<typeof getWebSearchConnections>>[number] | undefined;
  onRefresh: () => Promise<unknown>;
  provider: (typeof PROVIDERS)[number];
}): JSX.Element {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setName(connection?.name ?? provider.name);
    setBaseUrl(connection?.settings.baseUrl ?? provider.baseUrl);
    setApiKey("");
  }, [connection, provider.baseUrl, provider.name]);

  const saveMutation = useMutation({
    mutationFn: (clearApiKey: boolean) =>
      saveWebSearchConnection({
        id: connection?.id,
        provider: provider.id,
        name,
        enabled: true,
        isPrimary: connection?.isPrimary ?? true,
        settings: { baseUrl },
        apiKey: apiKey.trim() || undefined,
        clearApiKey,
      }),
    onSuccess: async () => {
      setApiKey("");
      await onRefresh();
    },
  });
  const activateMutation = useMutation({
    mutationFn: () => activateWebSearchConnection(connection!.id),
    onSuccess: onRefresh,
  });
  const testMutation = useMutation({
    mutationFn: () => testWebSearchConnection(connection!.id),
    onSuccess: onRefresh,
  });

  return (
    <div className="settings-grid empty-block">
      <p className="empty-title">{provider.name}</p>
        <label className="field">
          <span>{`${provider.name} ${text.name}`}</span>
          <input className="field-input" onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <label className="field">
          <span>{`${provider.name} ${text.baseUrl}`}</span>
          <input
            className="field-input"
            onChange={(event) => setBaseUrl(event.target.value)}
            type="url"
            value={baseUrl}
          />
        </label>
        <label className="field">
          <span>{`${provider.name} ${text.apiKey}`}</span>
          <input
            autoComplete="off"
            className="field-input"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={connection?.hasApiKey ? text.keepKey : ""}
            type="password"
            value={apiKey}
          />
        </label>
        <p className="settings-note">
          {connection
            ? `${connection.isPrimary ? text.active : connection.enabled ? "Enabled" : "Disabled"}${
                connection.lastTestStatus ? ` · ${connection.lastTestStatus}` : ""
              }${connection.lastTestMessage ? ` · ${connection.lastTestMessage}` : ""}`
            : text.notConfigured}
        </p>
        {saveMutation.error || activateMutation.error || testMutation.error ? (
          <p className="settings-error">
            {(saveMutation.error || activateMutation.error || testMutation.error)?.message}
          </p>
        ) : null}
        <div className="toolbar-inline">
          <button className="primary-button" onClick={() => saveMutation.mutate(false)} type="button">
            {text.save}
          </button>
          {connection && !connection.isPrimary ? (
            <button className="secondary-button" onClick={() => activateMutation.mutate()} type="button">
              {text.activate}
            </button>
          ) : null}
          {connection ? (
            <button className="secondary-button" onClick={() => testMutation.mutate()} type="button">
              {text.test}
            </button>
          ) : null}
          {connection?.hasApiKey ? (
            <button className="secondary-button" onClick={() => saveMutation.mutate(true)} type="button">
              {text.removeKey}
            </button>
          ) : null}
        </div>
    </div>
  );
}
