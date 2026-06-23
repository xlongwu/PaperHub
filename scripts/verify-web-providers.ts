import { initDatabase } from "../src/db/index";
import { arxivWebSearchProvider } from "../src/web-search/providers/arxiv";
import { braveWebSearchProvider } from "../src/web-search/providers/brave";
import { crossrefWebSearchProvider } from "../src/web-search/providers/crossref";
import { githubRepositorySearchProvider } from "../src/web-search/providers/github";
import { mcpWebSearchProvider } from "../src/web-search/providers/mcp";
import { openAlexWebSearchProvider } from "../src/web-search/providers/openalex";
import { tavilyWebSearchProvider } from "../src/web-search/providers/tavily";
import type { WebSearchProvider } from "../src/web-search/types";

const providers = new Map<string, WebSearchProvider>([
  ["arxiv", arxivWebSearchProvider],
  ["openalex", openAlexWebSearchProvider],
  ["crossref", crossrefWebSearchProvider],
  ["tavily", tavilyWebSearchProvider],
  ["brave", braveWebSearchProvider],
  ["github", githubRepositorySearchProvider],
  ["mcp", mcpWebSearchProvider],
]);

const requested = (process.env["PAPERHUB_VERIFY_PROVIDERS"] || "arxiv,crossref,github")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

initDatabase();

let failed = false;
for (const providerId of requested) {
  const provider = providers.get(providerId);
  if (!provider) {
    console.error(`[provider-verify] ${providerId}: unsupported provider`);
    failed = true;
    continue;
  }
  const configured = await provider.isConfigured();
  if (!configured) {
    console.error(`[provider-verify] ${providerId}: not configured`);
    failed = true;
    continue;
  }
  const health = await provider.healthCheck();
  console.log(
    `[provider-verify] ${providerId}: ${health.status}${health.message ? ` - ${health.message}` : ""}`,
  );
  if (health.status !== "healthy") failed = true;
}

if (failed) process.exitCode = 1;
