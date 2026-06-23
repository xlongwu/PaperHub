/**
 * Abstract LLM provider interface.
 *
 * All concrete providers must implement this contract so the rest of the
 * codebase can stay provider-agnostic.
 */

export interface LlmProvider {
  /** Human-readable provider identifier (e.g. "anthropic", "openai"). */
  readonly name: string;
  /** Send a prompt and return the model's text response. */
  call(prompt: string, maxTokens: number): Promise<string>;
}

/** Factory function that creates an LlmProvider instance. */
export interface ProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export type ProviderFactory = (options?: ProviderOptions) => LlmProvider;

export type LlmProtocol = "openai_chat" | "anthropic_messages" | "gemini_generate_content" | "custom_json";

export type LlmAuthType = "bearer" | "header" | "query" | "none";
export type LlmRequestMethod = "GET" | "POST" | "PUT";
export type JsonTemplate =
  | null
  | boolean
  | number
  | string
  | JsonTemplate[]
  | {
      [key: string]: JsonTemplate;
    };

export interface LlmAuthConfig {
  type: LlmAuthType;
  headerName?: string;
  queryParam?: string;
}

export interface LlmRequestTemplate {
  method: Extract<LlmRequestMethod, "POST" | "PUT">;
  path: string;
  headers: Record<string, string>;
  body: JsonTemplate;
  responsePath: string;
}

export interface LlmModelDiscoveryTemplate {
  method: LlmRequestMethod;
  path: string;
  headers: Record<string, string>;
  body?: JsonTemplate;
  listPath: string;
  idPath: string;
}

export interface LlmConnectionConfig {
  id: string;
  name: string;
  presetId: string | null;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
}

export interface LlmConnectionPublic extends Omit<LlmConnectionConfig, "apiKey"> {
  hasApiKey: boolean;
  isActive: boolean;
  lastTestStatus: "success" | "failed" | null;
  lastTestMessage: string | null;
  lastTestAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderPreset {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  defaultModel: string;
  auth: LlmAuthConfig;
  request: LlmRequestTemplate;
  models: LlmModelDiscoveryTemplate | null;
}
