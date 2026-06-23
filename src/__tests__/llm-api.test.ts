import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "@/api/server";
import { clearDbPath, closeDb, initDatabase, setDbPath } from "@/db/index";
import { safeUnlink, testPath } from "./test-utils";

const TEST_DB_PATH = testPath("paperhub-llm-api.db");
let server: Server;
let apiBase: string;

beforeAll(async () => {
  closeDb();
  safeUnlink(TEST_DB_PATH);
  setDbPath(TEST_DB_PATH);
  initDatabase();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  closeDb();
  clearDbPath();
  safeUnlink(TEST_DB_PATH);
});

describe("LLM connection API", () => {
  it("returns the provider catalog and safe connection state", async () => {
    const catalog = await apiGet<Array<{ id: string }>>("/api/llm/catalog");
    expect(catalog.some((item) => item.id === "gemini")).toBe(true);
    expect(catalog.some((item) => item.id === "siliconflow")).toBe(true);
    expect(catalog.some((item) => item.id === "stepfun")).toBe(true);

    const state = await apiGet<{ connections: unknown[]; activeConnectionId: string }>(
      "/api/llm/connections",
    );
    expect(state.connections).toHaveLength(1);
    expect(state.activeConnectionId).toBe("default-deepseek");
    expect(JSON.stringify(state)).not.toContain("api_key");
  });

  it("creates, activates, updates, and protects an active connection", async () => {
    const created = await apiRequest<{
      id: string;
      hasApiKey: boolean;
      isActive: boolean;
    }>("/api/llm/connections", {
      method: "POST",
      body: JSON.stringify({
        presetId: "openai",
        name: "Personal OpenAI",
        apiKey: "not-returned-secret",
      }),
    });
    expect(created.hasApiKey).toBe(true);
    expect(created.isActive).toBe(false);
    expect(JSON.stringify(created)).not.toContain("not-returned-secret");

    const active = await apiRequest<{ id: string; isActive: boolean }>(
      `/api/llm/connections/${created.id}/activate`,
      { method: "POST", body: "{}" },
    );
    expect(active.id).toBe(created.id);
    expect(active.isActive).toBe(true);

    const deleteResponse = await fetch(`${apiBase}/api/llm/connections/${created.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(409);
  });
});

async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "GET" });
}

async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const envelope = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new Error(envelope.error ?? `Request failed: ${response.status}`);
  }
  return envelope.data;
}
