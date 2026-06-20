// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { UserCenterPage } from "@/ui/pages/UserCenterPage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UserCenterPage", () => {
  it("renders memory terms and saves edited preferences", async () => {
    const savedBodies: string[] = [];
    const savedLlmBodies: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = getUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/user/preferences") && method === "GET") {
          return jsonResponse({
            interest_tags: JSON.stringify(["Agents"]),
            default_language: "zh",
            summary_length: "short",
            daily_recommend_count: "10",
          });
        }

        if (url.endsWith("/api/user/preferences") && method === "POST") {
          savedBodies.push(String(init?.body ?? ""));
          return jsonResponse({
            interest_tags: JSON.stringify(["Agents", "RAG"]),
            default_language: "zh",
            summary_length: "short",
            daily_recommend_count: "10",
          });
        }

        if (url.endsWith("/api/llm/catalog") && method === "GET") {
          return jsonResponse([deepseekPreset(), openrouterPreset()]);
        }

        if (url.endsWith("/api/llm/connections") && method === "GET") {
          return jsonResponse({
            connections: [deepseekConnection(), openrouterConnection()],
            activeConnectionId: "default-deepseek",
            runtimeConnectionId: "default-deepseek",
            runtimeSource: "stored",
            environmentOverride: false,
          });
        }

        if (url.endsWith("/api/llm/connections/default-deepseek") && method === "PUT") {
          savedLlmBodies.push(String(init?.body ?? ""));
          return jsonResponse({ ...deepseekConnection(), hasApiKey: true });
        }

        if (url.includes("/api/user/memory")) {
          return jsonResponse([{ category: "topic", term: "Agents", weight: 1.2, source: "digest" }]);
        }

        if (url.includes("/api/user/history")) {
          return jsonResponse([]);
        }

        if (url.includes("/api/user/favorites")) {
          return jsonResponse([]);
        }

        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <UserCenterPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Agents")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Interest tags"), { target: { value: "Agents, RAG" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      expect(savedBodies).toHaveLength(1);
    });
    expect(savedBodies[0]).toContain("RAG");

    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("连接名称")).toHaveValue("OpenRouter");
      expect(screen.getByLabelText("API 根地址")).toHaveValue("https://openrouter.ai/api/v1");
      expect(screen.getByLabelText("模型 ID")).toHaveValue("openai/gpt-oss-120b:free");
    });

    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("连接名称")).toHaveValue("DeepSeek");
    });

    fireEvent.change(await screen.findByLabelText("API 密钥"), {
      target: { value: "sk-ui-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    await waitFor(() => {
      expect(savedLlmBodies).toHaveLength(1);
    });
    expect(savedLlmBodies[0]).toContain("sk-ui-test");
  });
});

function getUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function deepseekPreset() {
  return {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai_chat",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    auth: { type: "bearer" },
    request: {
      method: "POST",
      path: "/chat/completions",
      headers: {},
      body: {
        model: "{{model}}",
        max_tokens: "{{maxTokens}}",
        messages: [{ role: "user", content: "{{prompt}}" }],
      },
      responsePath: "$.choices[0].message.content",
    },
    models: {
      method: "GET",
      path: "/models",
      headers: {},
      listPath: "$.data",
      idPath: "$.id",
    },
  };
}

function deepseekConnection() {
  const preset = deepseekPreset();
  return {
    id: "default-deepseek",
    name: preset.label,
    presetId: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    auth: preset.auth,
    request: preset.request,
    models: preset.models,
    hasApiKey: false,
    isActive: true,
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestAt: null,
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };
}

function openrouterPreset() {
  return {
    ...deepseekPreset(),
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    request: {
      ...deepseekPreset().request,
      headers: { "X-OpenRouter-Title": "PaperHub" },
    },
  };
}

function openrouterConnection() {
  const preset = openrouterPreset();
  return {
    id: "legacy-openrouter",
    name: preset.label,
    presetId: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: "openai/gpt-oss-120b:free",
    auth: preset.auth,
    request: preset.request,
    models: preset.models,
    hasApiKey: true,
    isActive: false,
    lastTestStatus: "failed",
    lastTestMessage: "fetch failed",
    lastTestAt: "2026-06-20T00:00:00Z",
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      meta: {
        total: Array.isArray(data) ? data.length : 1,
        limit: Array.isArray(data) ? data.length : 1,
        page: 1,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
