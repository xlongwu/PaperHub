import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { WEB_SEARCH_CONNECTION_UI } from "@/i18n";
import { LoadingBlock, SectionHeader } from "./components";
import {
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
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [toolName, setToolName] = useState("search");

  useEffect(() => {
    setName(connection?.name ?? "Search MCP");
    setCommand(connection?.settings.mcpCommand ?? "");
    setArgs((connection?.settings.mcpArgs ?? []).join("\n"));
    setToolName(connection?.settings.mcpToolName ?? "search");
  }, [connection]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveWebSearchConnection({
        id: connection?.id,
        provider: "mcp",
        name,
        enabled: true,
        isPrimary: connection?.isPrimary ?? true,
        settings: {
          mcpTransport: "stdio",
          mcpCommand: command,
          mcpArgs: args
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          mcpToolName: toolName,
        },
      }),
    onSuccess: onRefresh,
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
      <p className="empty-title">Search MCP (stdio)</p>
      <label className="field">
        <span>{`Search MCP ${text.name}`}</span>
        <input className="field-input" onChange={(event) => setName(event.target.value)} value={name} />
      </label>
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
      <label className="field">
        <span>{text.toolName}</span>
        <input
          className="field-input"
          onChange={(event) => setToolName(event.target.value)}
          value={toolName}
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
      <div className="toolbar-inline">
        <button className="primary-button" onClick={() => saveMutation.mutate()} type="button">
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
      </div>
    </div>
  );
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
