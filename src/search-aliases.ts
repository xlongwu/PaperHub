/**
 * Central search alias dictionary.
 *
 * All entries are normalized to lowercase. Chinese forms are also indexed so
 * a Chinese query can expand to the English terminology used by papers.
 */

export interface ConceptEntry {
  canonical: string;
  aliases: string[];
  chinese?: string[];
}

export const CONCEPT_ALIASES: ConceptEntry[] = [
  {
    canonical: "llm",
    aliases: ["llm", "llms", "large language model", "large language models"],
    chinese: ["大语言模型", "大模型", "语言模型"],
  },
  {
    canonical: "vlm",
    aliases: ["vlm", "vlms", "vision language model", "vision-language model", "visual language model"],
    chinese: ["视觉语言模型", "多模态大模型"],
  },
  {
    canonical: "rag",
    aliases: ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
    chinese: ["检索增强生成"],
  },
  {
    canonical: "cot",
    aliases: ["cot", "chain of thought", "chain-of-thought", "chain of thoughts"],
    chinese: ["思维链", "思维链条"],
  },
  {
    canonical: "rlhf",
    aliases: [
      "rlhf",
      "reinforcement learning from human feedback",
      "reinforcement learning with human feedback",
    ],
    chinese: ["人类反馈强化学习"],
  },
  {
    canonical: "dpo",
    aliases: ["dpo", "direct preference optimization", "direct preference optimisation"],
    chinese: ["直接偏好优化"],
  },
  {
    canonical: "moe",
    aliases: ["moe", "mixture of experts", "mixture-of-experts"],
    chinese: ["混合专家"],
  },
  {
    canonical: "sft",
    aliases: ["sft", "supervised fine tuning", "supervised fine-tuning"],
    chinese: ["监督微调"],
  },
  {
    canonical: "tts",
    aliases: ["tts", "text to speech", "text-to-speech", "speech synthesis"],
    chinese: ["文本转语音", "语音合成"],
  },
  {
    canonical: "asr",
    aliases: ["asr", "automatic speech recognition", "speech recognition"],
    chinese: ["语音识别"],
  },
  {
    canonical: "ai",
    aliases: ["ai", "artificial intelligence"],
    chinese: ["人工智能"],
  },
  {
    canonical: "nlp",
    aliases: ["nlp", "natural language processing"],
    chinese: ["自然语言处理"],
  },
  {
    canonical: "cv",
    aliases: ["cv", "computer vision"],
    chinese: ["计算机视觉"],
  },
  {
    canonical: "gpt",
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
    canonical: "transformer",
    aliases: ["transformer", "transformers"],
  },
  {
    canonical: "diffusion",
    aliases: ["diffusion", "diffusion model", "diffusion models"],
    chinese: ["扩散", "扩散模型"],
  },
  {
    canonical: "agent",
    aliases: ["agent", "agents", "agentic", "agentic ai", "agentic-ai"],
    chinese: ["智能体", "代理"],
  },
  {
    canonical: "embedding",
    aliases: ["embedding", "embeddings"],
    chinese: ["嵌入", "向量嵌入"],
  },
  {
    canonical: "fine-tuning",
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
    chinese: ["微调"],
  },
  {
    canonical: "alignment",
    aliases: ["alignment", "align", "aligned"],
    chinese: ["对齐"],
  },
  {
    canonical: "multi-agent",
    aliases: ["multi-agent", "multi agent", "multiagent", "multi agents", "multi-agents"],
    chinese: ["多智能体", "多代理"],
  },
  {
    canonical: "multimodal",
    aliases: ["multimodal", "multi-modal", "multi modal"],
    chinese: ["多模态"],
  },
  {
    canonical: "medical imaging",
    aliases: ["medical imaging", "medical image", "medical images"],
    chinese: ["医学图像", "医学影像"],
  },
  {
    canonical: "evaluation",
    aliases: ["evaluation", "evaluate", "evaluating", "eval", "evals"],
    chinese: ["评估", "评测"],
  },
  {
    canonical: "memory",
    aliases: ["memory", "memories", "context memory"],
    chinese: ["记忆"],
  },
  {
    canonical: "image",
    aliases: ["image", "images", "imaging"],
    chinese: ["图像", "影像"],
  },
  {
    canonical: "synthetic data",
    aliases: [
      "synthetic data",
      "synthetic dataset",
      "synthetic datasets",
      "data synthesis",
      "synthetic corpus",
      "synthetic corpora",
    ],
    chinese: ["数据合成", "合成数据", "合成数据集", "合成语料"],
  },
];

export interface PhraseConcept {
  tokens: string[][];
  canonical: string;
}

export const PHRASE_CONCEPTS: PhraseConcept[] = [
  { tokens: [["large"], ["language"], ["model", "models"]], canonical: "llm" },
  { tokens: [["vision", "visual"], ["language"], ["model", "models"]], canonical: "vlm" },
  { tokens: [["retrieval"], ["augmented"], ["generation"]], canonical: "rag" },
  { tokens: [["natural"], ["language"], ["processing"]], canonical: "nlp" },
  { tokens: [["computer"], ["vision"]], canonical: "cv" },
  { tokens: [["artificial"], ["intelligence"]], canonical: "ai" },
  { tokens: [["chain"], ["of"], ["thought", "thoughts"]], canonical: "cot" },
  {
    tokens: [["reinforcement"], ["learning"], ["from", "with"], ["human"], ["feedback"]],
    canonical: "rlhf",
  },
  { tokens: [["direct"], ["preference"], ["optimization", "optimisation"]], canonical: "dpo" },
  { tokens: [["mixture"], ["of"], ["experts"]], canonical: "moe" },
  { tokens: [["supervised"], ["fine"], ["tuning", "tune", "tuned"]], canonical: "sft" },
  { tokens: [["automatic"], ["speech"], ["recognition"]], canonical: "asr" },
  { tokens: [["text"], ["to"], ["speech"]], canonical: "tts" },
  { tokens: [["diffusion"], ["model", "models"]], canonical: "diffusion" },
  { tokens: [["multi"], ["agent", "agents", "agentic"]], canonical: "multi-agent" },
  { tokens: [["multi"], ["modal", "modality"]], canonical: "multimodal" },
  { tokens: [["medical"], ["image", "images", "imaging"]], canonical: "medical imaging" },
  {
    tokens: [["synthetic"], ["data", "dataset", "datasets", "corpus", "corpora"]],
    canonical: "synthetic data",
  },
  { tokens: [["data"], ["synthesis"]], canonical: "synthetic data" },
];

export const ALIAS_BY_CANONICAL = new Map(CONCEPT_ALIASES.map((entry) => [entry.canonical, entry]));

export const CANONICAL_BY_ALIAS = new Map<string, string>();
export const CANONICAL_BY_CHINESE = new Map<string, string>();

for (const entry of CONCEPT_ALIASES) {
  for (const alias of entry.aliases) {
    CANONICAL_BY_ALIAS.set(normalizeAlias(alias), entry.canonical);
  }
  for (const chinese of entry.chinese ?? []) {
    CANONICAL_BY_CHINESE.set(chinese, entry.canonical);
  }
}

export function allAlternatives(canonical: string): string[] {
  const entry = ALIAS_BY_CANONICAL.get(canonical);
  return entry ? [...entry.aliases, ...(entry.chinese ?? [])] : [canonical];
}

const PLURAL_TO_SINGULAR: Record<string, string> = {
  agents: "agent",
  models: "model",
  embeddings: "embedding",
  transformers: "transformer",
  thoughts: "thought",
  images: "image",
  memories: "memory",
  evals: "eval",
};

export function toSingular(word: string): string {
  return PLURAL_TO_SINGULAR[word] ?? word;
}

export function normaliseHyphens(word: string): string {
  return normalizeAlias(word);
}

export function mapChineseToken(token: string): string | null {
  return CANONICAL_BY_CHINESE.get(token) ?? null;
}

export function findChineseConcepts(text: string): string[] {
  const matches = [...CANONICAL_BY_CHINESE.entries()]
    .filter(([surface]) => text.includes(surface))
    .sort((a, b) => b[0].length - a[0].length);

  const selected: Array<{ surface: string; canonical: string }> = [];
  for (const [surface, canonical] of matches) {
    if (selected.some((item) => item.canonical === canonical || item.surface.includes(surface))) {
      continue;
    }
    selected.push({ surface, canonical });
  }
  return [...new Set(selected.map((item) => item.canonical))];
}

export function isCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/g, "");
}
