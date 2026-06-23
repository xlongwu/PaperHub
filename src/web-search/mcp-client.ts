import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSearchConnectionConfig } from "./types";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

export class McpStdioClient implements McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private stderr = "";

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  async connect(): Promise<void> {
    if (this.child) return;
    if (this.signal?.aborted) throw new Error("MCP connection was cancelled.");
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code) => {
      this.rejectAll(
        new Error(
          `MCP process exited before completing the request (code ${code ?? "unknown"}).${this.stderr ? ` ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
    this.signal?.addEventListener("abort", () => this.close(), { once: true });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "paperhub-search-provider", version: "0.1.1" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid schema.");
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
    if (!result || typeof result !== "object") {
      throw new Error("MCP tools/call returned an invalid schema.");
    }
    if (result.isError) {
      throw new Error(readToolText(result) || `MCP tool "${name}" failed.`);
    }
    return result;
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
    this.rejectAll(new Error("MCP connection closed."));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write(message);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private write(message: string): void {
    if (!this.child?.stdin.writable) throw new Error("MCP stdio process is not writable.");
    this.child.stdin.write(`${message}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.rejectAll(new Error("MCP response exceeded the maximum allowed size."));
      this.close();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.rejectAll(new Error("MCP server returned malformed JSON."));
      this.close();
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class McpHttpClient implements McpClient {
  private nextId = 1;
  private sessionId?: string;

  constructor(
    private readonly endpoint: string,
    private readonly authToken: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async connect(): Promise<void> {
    validateMcpHttpEndpoint(this.endpoint);
    if (!this.authToken.trim()) {
      throw new Error("HTTP Search MCP requires a local authentication token.");
    }
    if (this.signal?.aborted) throw new Error("MCP connection was cancelled.");
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "paperhub-search-provider", version: "0.1.1" },
    });
    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid schema.");
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
    if (!result || typeof result !== "object") {
      throw new Error("MCP tools/call returned an invalid schema.");
    }
    if (result.isError) {
      throw new Error(readToolText(result) || `MCP tool "${name}" failed.`);
    }
    return result;
  }

  close(): void {
    this.sessionId = undefined;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send({ jsonrpc: "2.0", id: this.nextId++, method, params });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  private async send(payload: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    this.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2024-11-05",
          Origin: "http://127.0.0.1",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      const body = await readMcpHttpResponse(response);
      if (!response.ok) {
        throw new Error(`MCP HTTP request failed (${response.status}): ${body.slice(0, 500)}`);
      }
      if (!("id" in payload)) return undefined;
      const parsed = parseJsonRpcHttpResponse(body);
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("MCP request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export async function withMcpClient<T>(
  connection: WebSearchConnectionConfig,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (client: McpClient) => Promise<T>,
): Promise<T> {
  const settings = connection.settings;
  const client =
    settings.mcpTransport === "streamable_http"
      ? createHttpClient(connection, timeoutMs, signal)
      : createStdioClient(connection, timeoutMs, signal);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}

export function readToolText(result: McpToolResult): string {
  return (
    result.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim() ?? ""
  );
}

export function validateMcpHttpEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("settings.mcpEndpoint must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("settings.mcpEndpoint must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("settings.mcpEndpoint must not include credentials.");
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]") {
    throw new Error("HTTP Search MCP must not target 0.0.0.0.");
  }
  if (isLoopbackHostname(hostname)) return parsed;
  if (!trustedMcpHttpHosts().has(hostname)) {
    throw new Error("HTTP Search MCP endpoint must be loopback or explicitly trusted.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Trusted non-loopback HTTP Search MCP endpoints must use HTTPS.");
  }
  return parsed;
}

function createStdioClient(
  connection: WebSearchConnectionConfig,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): McpStdioClient {
  const settings = connection.settings;
  if (!settings.mcpCommand || !settings.mcpToolName) {
    throw new Error("Search MCP command and tool name are required.");
  }
  return new McpStdioClient(settings.mcpCommand, settings.mcpArgs ?? [], timeoutMs, signal);
}

function createHttpClient(
  connection: WebSearchConnectionConfig,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): McpHttpClient {
  const endpoint = connection.settings.mcpEndpoint;
  if (!endpoint || !connection.settings.mcpToolName) {
    throw new Error("HTTP Search MCP endpoint and tool name are required.");
  }
  if (!connection.apiKey) {
    throw new Error("HTTP Search MCP requires a local authentication token.");
  }
  return new McpHttpClient(endpoint, connection.apiKey, timeoutMs, signal);
}

async function readMcpHttpResponse(response: Response): Promise<string> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return text;
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return dataLines.at(-1) ?? "";
}

function parseJsonRpcHttpResponse(text: string): JsonRpcResponse {
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse;
    if (!parsed || parsed.jsonrpc !== "2.0") {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("MCP HTTP server returned malformed JSON.");
  }
}

function trustedMcpHttpHosts(): Set<string> {
  return new Set(
    (process.env["PAPERHUB_TRUSTED_MCP_HTTP_HOSTS"] ?? "")
      .split(",")
      .map((value) => normalizeHostname(value.trim()))
      .filter(Boolean),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}
