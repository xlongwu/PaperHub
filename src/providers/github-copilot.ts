/**
 * GitHub Copilot provider — OpenAI-compatible endpoint via GitHub Models.
 *
 * Env vars:
 *   GITHUB_TOKEN           - GitHub token (PAT or GitHub Actions `GITHUB_TOKEN`)
 *   GITHUB_COPILOT_MODEL   - model name (default: gpt-4o)
 */

import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderOptions } from "./types";

const GITHUB_COPILOT_BASE_URL = "https://models.github.ai/inference";

export class GitHubCopilotProvider extends OpenAICompatibleProvider {
  readonly name = "github-copilot";

  constructor(opts?: ProviderOptions) {
    super({
      apiKey: opts?.apiKey ?? process.env["GITHUB_TOKEN"],
      baseURL: opts?.baseURL ?? GITHUB_COPILOT_BASE_URL,
      model: opts?.model ?? process.env["GITHUB_COPILOT_MODEL"] ?? "gpt-4o",
    });
  }
}
