/**
 * Model name extraction from text using regex patterns.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const MODEL_PATTERNS = [
  { pattern: /GPT-4[\w-]*/gi, name: "GPT-4" },
  { pattern: /Claude 3[\w.]*/gi, name: "Claude 3" },
  { pattern: /Llama 3[\w.]*/gi, name: "Llama 3" },
  { pattern: /Gemini[\w\s]*/gi, name: "Gemini" },
  { pattern: /Qwen[\w-]*/gi, name: "Qwen" },
  { pattern: /DeepSeek[\w-]*/gi, name: "DeepSeek" },
  { pattern: /Mistral[\w-]*/gi, name: "Mistral" },
  { pattern: /AutoGPT/gi, name: "AutoGPT" },
  { pattern: /LangChain/gi, name: "LangChain" },
  { pattern: /AutoGen/gi, name: "AutoGen" },
  { pattern: /GPT-3[\w-]*/gi, name: "GPT-3" },
  { pattern: /Claude 2[\w.]*/gi, name: "Claude 2" },
  { pattern: /Llama 2[\w.]*/gi, name: "Llama 2" },
  { pattern: /Stable Diffusion/gi, name: "Stable Diffusion" },
  { pattern: /DALL-E/gi, name: "DALL-E" },
  { pattern: /Whisper/gi, name: "Whisper" },
  { pattern: /BERT[\w-]*/gi, name: "BERT" },
  { pattern: /T5[\w-]*/gi, name: "T5" },
  { pattern: /LLaMA[\w-]*/gi, name: "LLaMA" },
];

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export function extractModelTags(text: string): string[] {
  const found = new Set<string>();

  for (const { pattern, name } of MODEL_PATTERNS) {
    if (pattern.test(text)) {
      found.add(name);
    }
  }

  return [...found];
}
