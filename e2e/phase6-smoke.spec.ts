import { installMockPaperHub } from "./support/mockPaperHub";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installMockPaperHub(page);
});

test("home page surfaces the release candidate data set", async ({ page }) => {
  await page.goto("http://paperhub.test/");

  await expect(page.getByRole("heading", { name: "Hot board" })).toBeVisible();
  await expect(page.getByText("Agent Memory Systems in Production")).toBeVisible();
  await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New on the desk" })).toBeVisible();
});

test("search reaches document detail and profile reflects read and favorite actions", async ({ page }) => {
  await page.goto("http://paperhub.test/search");

  await page.getByLabel("Query").fill("agent memory");
  await page.getByLabel("Mode").selectOption("keyword");
  await page.getByRole("button", { name: "Run search" }).click();

  await expect(page.getByText("Agent Memory Systems in Production")).toBeVisible();
  await page.getByRole("link", { name: "Agent Memory Systems in Production" }).click();

  await expect(page.getByRole("heading", { name: "Agent Memory Systems in Production" })).toBeVisible();

  await page.getByRole("button", { name: "Save to favorites" }).click();
  await expect(page.getByRole("button", { name: "Remove favorite" })).toBeVisible();

  await page.getByRole("button", { name: "Mark as read" }).click();
  await expect(page.getByRole("button", { name: "Marked as read" })).toBeDisabled();

  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile settings" })).toBeVisible();

  await expect(page.getByRole("link", { name: "doc-e2e-agent-memory" })).toBeVisible();
  await expect(page.getByRole("link", { name: "doc-e2e-rag-systems" })).toBeVisible();

  const interestTags = page.getByLabel("Interest tags");
  await interestTags.fill("Agents, RAG, Planning");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(interestTags).toHaveValue("Agents, RAG, Planning");
});

test("search api respects the release-candidate date filter window", async ({ page }) => {
  await page.goto("http://paperhub.test/search");

  const payload = await page.evaluate(async () => {
    const response = await fetch(
      "/api/search?q=agent&mode=keyword&limit=20&offset=0&from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T23%3A59%3A59.999Z",
    );
    return (await response.json()) as {
      success: boolean;
      data?: {
        total: number;
        results: Array<{
          document: {
            id: string;
            publishedAt: string;
          };
        }>;
      };
    };
  });

  expect(payload.success).toBeTruthy();
  expect(payload.data?.total).toBeGreaterThan(0);

  const documentIds = payload.data?.results.map((item) => item.document.id) ?? [];
  expect(documentIds).toContain("doc-e2e-agent-memory");
  expect(documentIds).not.toContain("doc-e2e-year-2025");

  for (const result of payload.data?.results ?? []) {
    expect(result.document.publishedAt >= "2026-06-01T00:00:00.000Z").toBeTruthy();
    expect(result.document.publishedAt <= "2026-06-30T23:59:59.999Z").toBeTruthy();
  }
});

test("tags page supports category browsing, sorting, and pagination", async ({ page }) => {
  await page.goto("http://paperhub.test/tags");

  await expect(page.getByRole("heading", { name: "Tag atlas" })).toBeVisible();
  await page.getByRole("button", { name: "Domain" }).click();
  await page.getByRole("link", { name: /Agents/ }).click();

  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("Page 1 / 2")).toBeVisible();

  await page.getByLabel("Sort by").selectOption("relevance");
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page).toHaveURL(/sort=relevance/);
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("Page 2 / 2")).toBeVisible();
  await expect(page.getByText("Agent Archive Note 10")).toBeVisible();
});
