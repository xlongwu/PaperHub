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

        if (url.endsWith("/api/llm/settings") && method === "GET") {
          return jsonResponse({
            provider: "deepseek",
            model: "deepseek-chat",
            baseUrl: "https://api.deepseek.com",
            hasApiKey: false,
            apiKeySource: "missing",
            supportedProviders: ["anthropic", "openai", "github-copilot", "openrouter", "deepseek"],
          });
        }

        if (url.endsWith("/api/llm/settings") && method === "POST") {
          savedLlmBodies.push(String(init?.body ?? ""));
          return jsonResponse({
            provider: "deepseek",
            model: "deepseek-chat",
            baseUrl: "https://api.deepseek.com",
            hasApiKey: true,
            apiKeySource: "stored",
            supportedProviders: ["anthropic", "openai", "github-copilot", "openrouter", "deepseek"],
          });
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

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-ui-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save LLM settings" }));

    await waitFor(() => {
      expect(savedLlmBodies).toHaveLength(1);
    });
    expect(savedLlmBodies[0]).toContain("sk-ui-test");
  });
});

function getUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
