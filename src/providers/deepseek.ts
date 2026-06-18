/**
 * DeepSeek provider — OpenAI-compatible endpoint via api.deepseek.com.
 *
 * Env vars:
 *   DEEPSEEK_API_KEY  - API key
 *   DEEPSEEK_MODEL    - model name (default: deepseek-chat)
 */

import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderOptions } from "./types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly name = "deepseek";

  constructor(opts?: ProviderOptions) {
    super({
      apiKey: opts?.apiKey ?? process.env["DEEPSEEK_API_KEY"],
      baseURL: opts?.baseURL ?? DEEPSEEK_BASE_URL,
      model: opts?.model ?? process.env["DEEPSEEK_MODEL"] ?? "deepseek-chat",
    });
  }
}
