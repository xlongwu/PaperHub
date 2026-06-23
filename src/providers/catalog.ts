import type {
  JsonTemplate,
  LlmAuthConfig,
  LlmModelDiscoveryTemplate,
  LlmProviderPreset,
  LlmRequestTemplate,
} from "./types";

const OPENAI_BODY: JsonTemplate = {
  model: "{{model}}",
  max_tokens: "{{maxTokens}}",
  messages: [{ role: "user", content: "{{prompt}}" }],
};

const OPENAI_REQUEST: LlmRequestTemplate = {
  method: "POST",
  path: "/chat/completions",
  headers: {},
  body: OPENAI_BODY,
  responsePath: "$.choices[0].message.content",
};

const OPENAI_MODELS: LlmModelDiscoveryTemplate = {
  method: "GET",
  path: "/models",
  headers: {},
  listPath: "$.data",
  idPath: "$.id",
};

const BEARER_AUTH: LlmAuthConfig = { type: "bearer" };

function openAiPreset(
  id: string,
  label: string,
  baseUrl: string,
  defaultModel: string,
  options?: {
    models?: LlmModelDiscoveryTemplate | null;
    request?: LlmRequestTemplate;
    auth?: LlmAuthConfig;
  },
): LlmProviderPreset {
  return {
    id,
    label,
    protocol: "openai_chat",
    baseUrl,
    defaultModel,
    auth: options?.auth ?? BEARER_AUTH,
    request: options?.request ?? OPENAI_REQUEST,
    models: options?.models === undefined ? OPENAI_MODELS : options.models,
  };
}

export const LLM_PROVIDER_CATALOG: readonly LlmProviderPreset[] = [
  openAiPreset("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini", {
    request: {
      ...OPENAI_REQUEST,
      body: {
        model: "{{model}}",
        max_completion_tokens: "{{maxTokens}}",
        messages: [{ role: "user", content: "{{prompt}}" }],
      },
    },
  }),
  {
    id: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    auth: { type: "header", headerName: "x-api-key" },
    request: {
      method: "POST",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: "{{model}}",
        max_tokens: "{{maxTokens}}",
        messages: [{ role: "user", content: "{{prompt}}" }],
      },
      responsePath: "$.content[0].text",
    },
    models: {
      method: "GET",
      path: "/v1/models",
      headers: { "anthropic-version": "2023-06-01" },
      listPath: "$.data",
      idPath: "$.id",
    },
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini_generate_content",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    auth: { type: "query", queryParam: "key" },
    request: {
      method: "POST",
      path: "/v1beta/models/{{model}}:generateContent",
      headers: {},
      body: {
        contents: [{ parts: [{ text: "{{prompt}}" }] }],
        generationConfig: { maxOutputTokens: "{{maxTokens}}" },
      },
      responsePath: "$.candidates[0].content.parts[0].text",
    },
    models: {
      method: "GET",
      path: "/v1beta/models",
      headers: {},
      listPath: "$.models",
      idPath: "$.name",
    },
  },
  openAiPreset("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat"),
  openAiPreset("stepfun", "阶跃星辰 / StepFun", "https://api.stepfun.com/v1", "step-3.7-flash", {
    models: null,
  }),
  openAiPreset(
    "qwen",
    "阿里云百炼 / Qwen",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-plus",
    { models: null },
  ),
  openAiPreset("kimi", "Moonshot Kimi", "https://api.moonshot.cn/v1", "kimi-k2.5", {
    models: null,
  }),
  openAiPreset("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4.5", {
    models: null,
  }),
  openAiPreset("mistral", "Mistral AI", "https://api.mistral.ai/v1", "mistral-small-latest"),
  openAiPreset("xai", "xAI Grok", "https://api.x.ai/v1", "grok-3-mini"),
  openAiPreset("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", {
    request: {
      ...OPENAI_REQUEST,
      headers: { "X-OpenRouter-Title": "PaperHub" },
    },
  }),
  openAiPreset("github-models", "GitHub Models", "https://models.github.ai/inference", "openai/gpt-4o-mini"),
  openAiPreset("siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"),
  {
    id: "custom",
    label: "自定义 JSON API",
    protocol: "custom_json",
    baseUrl: "http://127.0.0.1:8000",
    defaultModel: "",
    auth: { type: "bearer" },
    request: OPENAI_REQUEST,
    models: null,
  },
] as const;

export function getLlmProviderPreset(id: string): LlmProviderPreset | undefined {
  const normalized = id === "github-copilot" ? "github-models" : id;
  return LLM_PROVIDER_CATALOG.find((preset) => preset.id === normalized);
}

export function clonePreset(preset: LlmProviderPreset): LlmProviderPreset {
  return JSON.parse(JSON.stringify(preset)) as LlmProviderPreset;
}
