import type { Document } from "@/types";

export type CanonicalTagCategory = "domain" | "model" | "method" | "task" | "source" | "type" | "year";

export interface CanonicalTagDefinition {
  id: string;
  displayName: string;
  category: CanonicalTagCategory;
  aliases: string[];
  chineseAliases?: string[];
}

export interface CanonicalDocumentTag {
  canonicalTag: string;
  rawTag: string;
  category: CanonicalTagCategory;
  confidence: number;
}

export const CANONICAL_TAGS: CanonicalTagDefinition[] = [
  {
    id: "llm",
    displayName: "LLM",
    category: "model",
    aliases: ["llm", "llms", "large language model", "large language models"],
    chineseAliases: ["大语言模型", "大模型", "语言模型"],
  },
  {
    id: "vlm",
    displayName: "VLM",
    category: "model",
    aliases: ["vlm", "vlms", "vision language model", "vision-language model", "visual language model"],
    chineseAliases: ["视觉语言模型", "多模态大模型"],
  },
  {
    id: "rag",
    displayName: "RAG",
    category: "method",
    aliases: ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
    chineseAliases: ["检索增强生成"],
  },
  {
    id: "cot",
    displayName: "Chain of Thought",
    category: "method",
    aliases: ["cot", "chain of thought", "chain-of-thought", "chain of thoughts"],
    chineseAliases: ["思维链", "思维链条"],
  },
  {
    id: "rlhf",
    displayName: "RLHF",
    category: "method",
    aliases: [
      "rlhf",
      "reinforcement learning from human feedback",
      "reinforcement learning with human feedback",
    ],
    chineseAliases: ["人类反馈强化学习"],
  },
  {
    id: "dpo",
    displayName: "DPO",
    category: "method",
    aliases: ["dpo", "direct preference optimization", "direct preference optimisation"],
    chineseAliases: ["直接偏好优化"],
  },
  {
    id: "moe",
    displayName: "Mixture of Experts",
    category: "method",
    aliases: ["moe", "mixture of experts", "mixture-of-experts"],
    chineseAliases: ["混合专家"],
  },
  {
    id: "sft",
    displayName: "SFT",
    category: "method",
    aliases: ["sft", "supervised fine tuning", "supervised fine-tuning"],
    chineseAliases: ["监督微调"],
  },
  {
    id: "tts",
    displayName: "Text to Speech",
    category: "task",
    aliases: ["tts", "text to speech", "text-to-speech", "speech synthesis"],
    chineseAliases: ["文本转语音", "语音合成"],
  },
  {
    id: "asr",
    displayName: "Speech Recognition",
    category: "task",
    aliases: ["asr", "automatic speech recognition", "speech recognition"],
    chineseAliases: ["语音识别"],
  },
  {
    id: "ai",
    displayName: "AI",
    category: "domain",
    aliases: ["ai", "artificial intelligence"],
    chineseAliases: ["人工智能"],
  },
  {
    id: "ml",
    displayName: "ML",
    category: "domain",
    aliases: ["ml", "machine learning"],
    chineseAliases: ["机器学习"],
  },
  {
    id: "nlp",
    displayName: "NLP",
    category: "domain",
    aliases: ["nlp", "natural language processing"],
    chineseAliases: ["自然语言处理"],
  },
  {
    id: "cv",
    displayName: "Computer Vision",
    category: "domain",
    aliases: ["cv", "computer vision"],
    chineseAliases: ["计算机视觉"],
  },
  {
    id: "gpt",
    displayName: "GPT-4",
    category: "model",
    aliases: [
      "gpt",
      "gpt-4",
      "gpt4",
      "gpt 4",
      "gpt-4o",
      "gpt4o",
      "gpt 4o",
      "gpt-3",
      "gpt-3.5",
      "gpt3",
      "gpt3.5",
    ],
  },
  {
    id: "transformer",
    displayName: "Transformer",
    category: "method",
    aliases: ["transformer", "transformers"],
  },
  {
    id: "diffusion",
    displayName: "Diffusion",
    category: "method",
    aliases: ["diffusion", "diffusion model", "diffusion models"],
    chineseAliases: ["扩散", "扩散模型"],
  },
  {
    id: "agent",
    displayName: "Agents",
    category: "domain",
    aliases: ["agent", "agents", "agentic", "agentic ai", "agentic-ai"],
    chineseAliases: ["智能体", "代理"],
  },
  {
    id: "embedding",
    displayName: "Embedding",
    category: "method",
    aliases: ["embedding", "embeddings"],
    chineseAliases: ["嵌入", "向量嵌入"],
  },
  {
    id: "fine-tuning",
    displayName: "Fine-tuning",
    category: "method",
    aliases: [
      "fine-tuning",
      "fine tuning",
      "finetuning",
      "fine-tune",
      "fine tune",
      "finetune",
      "fine-tuned",
      "fine tuned",
      "finetuned",
    ],
    chineseAliases: ["微调"],
  },
  {
    id: "alignment",
    displayName: "Alignment",
    category: "method",
    aliases: ["alignment", "align", "aligned"],
    chineseAliases: ["对齐"],
  },
  {
    id: "multi-agent",
    displayName: "Multi-agent",
    category: "domain",
    aliases: ["multi-agent", "multi agent", "multiagent", "multi agents", "multi-agents"],
    chineseAliases: ["多智能体", "多代理"],
  },
  {
    id: "multimodal",
    displayName: "Multimodal",
    category: "domain",
    aliases: ["multimodal", "multi-modal", "multi modal"],
    chineseAliases: ["多模态"],
  },
  {
    id: "medical-imaging",
    displayName: "Medical Imaging",
    category: "task",
    aliases: ["medical imaging", "medical image", "medical images"],
    chineseAliases: ["医学图像", "医学影像"],
  },
  {
    id: "evaluation",
    displayName: "Evaluation",
    category: "task",
    aliases: ["evaluation", "evaluate", "evaluating", "eval", "evals"],
    chineseAliases: ["评估", "评测"],
  },
  {
    id: "memory",
    displayName: "Memory",
    category: "task",
    aliases: ["memory", "memories", "context memory"],
    chineseAliases: ["记忆"],
  },
  {
    id: "image",
    displayName: "Image",
    category: "task",
    aliases: ["image", "images", "imaging"],
    chineseAliases: ["图像", "影像"],
  },
  {
    id: "synthetic-data",
    displayName: "Synthetic Data",
    category: "method",
    aliases: [
      "synthetic data",
      "synthetic dataset",
      "synthetic datasets",
      "data synthesis",
      "synthetic corpus",
      "synthetic corpora",
    ],
    chineseAliases: ["数据合成", "合成数据", "合成数据集", "合成语料"],
  },
  {
    id: "arxiv",
    displayName: "arXiv",
    category: "source",
    aliases: ["arxiv", "arXiv"],
  },
  {
    id: "gpt-blog",
    displayName: "GPT Blog",
    category: "source",
    aliases: ["gpt_blog", "gpt blog", "openai blog"],
  },
  {
    id: "claude-blog",
    displayName: "Claude Blog",
    category: "source",
    aliases: ["claude_blog", "claude blog", "codex blog", "anthropic blog"],
  },
  {
    id: "paper",
    displayName: "Paper",
    category: "type",
    aliases: ["paper", "papers"],
  },
  {
    id: "blog",
    displayName: "Blog",
    category: "type",
    aliases: ["blog", "blogs"],
  },
  {
    id: "tutorial",
    displayName: "Tutorial",
    category: "type",
    aliases: ["tutorial", "tutorials"],
  },
  {
    id: "review",
    displayName: "Review",
    category: "type",
    aliases: ["review", "reviews", "survey", "surveys"],
  },
];

const DEFINITION_BY_ID = new Map(CANONICAL_TAGS.map((definition) => [definition.id, definition]));
const CANONICAL_ID_BY_ALIAS = new Map<string, string>();
const CONTENT_DERIVED_CATEGORIES = new Set<CanonicalTagCategory>(["method"]);

for (const definition of CANONICAL_TAGS) {
  const values = [
    definition.id,
    definition.displayName,
    ...definition.aliases,
    ...(definition.chineseAliases ?? []),
  ];
  for (const value of values) {
    CANONICAL_ID_BY_ALIAS.set(normalizeCanonicalAlias(value), definition.id);
  }
}

export function normalizeCanonicalAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[-_\s]+/g, "");
}

export function slugifyCanonicalTag(value: string): string {
  const known = CANONICAL_ID_BY_ALIAS.get(normalizeCanonicalAlias(value));
  if (known) return known;
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function getCanonicalTagDefinition(value: string): CanonicalTagDefinition | undefined {
  const id = CANONICAL_ID_BY_ALIAS.get(normalizeCanonicalAlias(value)) ?? value;
  return DEFINITION_BY_ID.get(id);
}

export function getCanonicalTagId(value: string): string {
  return getCanonicalTagDefinition(value)?.id ?? slugifyCanonicalTag(value);
}

export function getCanonicalTagDisplayName(value: string): string {
  return getCanonicalTagDefinition(value)?.displayName ?? value;
}

export function getCanonicalTagAlternatives(value: string): string[] {
  const definition = getCanonicalTagDefinition(value);
  if (!definition) return [value];
  return [definition.id, definition.displayName, ...definition.aliases, ...(definition.chineseAliases ?? [])];
}

export function extractCanonicalContentTags(document: Document): CanonicalDocumentTag[] {
  const text = [document.title, document.abstract, document.summaryZh ?? "", document.summaryEn ?? ""]
    .filter(Boolean)
    .join("\n");
  const tags: CanonicalDocumentTag[] = [];

  for (const definition of CANONICAL_TAGS) {
    if (!CONTENT_DERIVED_CATEGORIES.has(definition.category)) continue;
    const aliases = [
      definition.displayName,
      ...definition.aliases,
      ...(definition.chineseAliases ?? []),
    ].sort((left, right) => right.length - left.length);
    const matchedAlias = aliases.find((alias) => containsCanonicalAlias(text, alias));
    if (!matchedAlias) continue;
    tags.push({
      canonicalTag: definition.id,
      rawTag: matchedAlias,
      category: definition.category,
      confidence: 0.85,
    });
  }

  return tags;
}

export function collectDocumentCanonicalTags(document: Document): CanonicalDocumentTag[] {
  const values: Array<{ rawTag: string; category: CanonicalTagCategory }> = [
    ...document.domainTags.map((rawTag) => ({ rawTag, category: "domain" as const })),
    ...document.modelTags.map((rawTag) => ({ rawTag, category: "model" as const })),
    { rawTag: document.sourceTag || document.source, category: "source" },
    { rawTag: document.source, category: "source" },
    { rawTag: document.typeTag, category: "type" },
    { rawTag: String(document.yearTag), category: "year" },
  ];

  const deduplicated = new Map<string, CanonicalDocumentTag>();
  for (const value of values) {
    const canonicalTag = getCanonicalTagId(value.rawTag);
    if (!canonicalTag) continue;
    const category = value.category;
    const key = `${canonicalTag}:${category}`;
    if (!deduplicated.has(key)) {
      deduplicated.set(key, {
        canonicalTag,
        rawTag: value.rawTag,
        category,
        confidence: 1,
      });
    }
  }
  for (const tag of extractCanonicalContentTags(document)) {
    const key = `${tag.canonicalTag}:${tag.category}`;
    if (!deduplicated.has(key)) {
      deduplicated.set(key, tag);
    }
  }
  return [...deduplicated.values()];
}

function containsCanonicalAlias(text: string, alias: string): boolean {
  const normalizedText = text.normalize("NFKC");
  const normalizedAlias = alias.normalize("NFKC").trim();
  if (!normalizedAlias) return false;
  if (/[\u3400-\u9fff]/u.test(normalizedAlias)) {
    return normalizedText.includes(normalizedAlias);
  }

  const pattern = normalizedAlias
    .split(/[-_\s]+/u)
    .map(escapeRegExp)
    .join("[-_\\s]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(normalizedText);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
