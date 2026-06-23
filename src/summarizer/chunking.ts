/**
 * Section-aware content chunking for long papers.
 *
 * Every source character is retained. Oversized sections fall back to
 * paragraph, sentence, and finally fixed-width splitting.
 */

export interface ContentChunk {
  sectionLabel: string;
  content: string;
}

interface Section {
  label: string;
  content: string;
}

const DEFAULT_SECTION_LABEL = "Unlabelled section";
const SECTION_HEADING =
  /^(?:#{1,6}\s+.+|(?:\d+(?:\.\d+)*[.)]?\s+)?(?:abstract|introduction|background|related work|method(?:ology)?|approach|model|experiments?|experimental setup|results?|discussion|analysis|ablation(?: study)?|limitations?|conclusion|references|摘要|引言|背景|相关工作|方法|模型|实验|结果|讨论|分析|消融实验|局限性|结论|参考文献)\b.*)$/i;

export function chunkPaperContent(rawContent: string, maxChunkChars = 12_000): ContentChunk[] {
  const content = rawContent.replace(/\r\n?/g, "\n").trim();
  if (!content) return [];
  if (content.length <= maxChunkChars) {
    return [{ sectionLabel: DEFAULT_SECTION_LABEL, content }];
  }

  const sections = splitIntoSections(content);
  const chunks: ContentChunk[] = [];
  let currentLabel = "";
  let currentContent = "";

  const flush = (): void => {
    if (!currentContent.trim()) return;
    chunks.push({
      sectionLabel: currentLabel || DEFAULT_SECTION_LABEL,
      content: currentContent.trim(),
    });
    currentLabel = "";
    currentContent = "";
  };

  for (const section of sections) {
    const pieces = splitOversizedText(section.content, maxChunkChars);
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      const label =
        pieces.length > 1 ? `${section.label} (part ${index + 1}/${pieces.length})` : section.label;
      const candidate = currentContent ? `${currentContent}\n\n${piece}` : piece;

      if (candidate.length > maxChunkChars && currentContent) {
        flush();
      }

      if (!currentContent) {
        currentLabel = label;
        currentContent = piece;
      } else {
        currentLabel = `${currentLabel}; ${label}`;
        currentContent = candidate;
      }
    }
  }
  flush();

  return chunks;
}

export function packEvidenceNotes(notes: string[], maxChars = 24_000): string[] {
  const blocks = notes.flatMap((note) => splitOversizedText(note, maxChars));
  const groups: string[] = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n---\n\n${block}` : block;
    if (candidate.length > maxChars && current) {
      groups.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);
  return groups;
}

function splitIntoSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let label = DEFAULT_SECTION_LABEL;
  let body: string[] = [];

  const flush = (): void => {
    const sectionContent = body.join("\n").trim();
    if (sectionContent) {
      sections.push({ label, content: sectionContent });
    }
    body = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && SECTION_HEADING.test(trimmed) && body.length > 0) {
      flush();
      label = trimmed.replace(/^#{1,6}\s+/, "");
      body.push(line);
    } else {
      if (trimmed && SECTION_HEADING.test(trimmed)) {
        label = trimmed.replace(/^#{1,6}\s+/, "");
      }
      body.push(line);
    }
  }
  flush();

  return sections.length > 0 ? sections : [{ label: DEFAULT_SECTION_LABEL, content }];
}

function splitOversizedText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let current = "";

  const append = (part: string): void => {
    const candidate = current ? `${current}\n\n${part}` : part;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    if (current) {
      pieces.push(current);
      current = "";
    }
    if (part.length <= maxChars) {
      current = part;
      return;
    }
    pieces.push(...splitBySentenceOrWidth(part, maxChars));
  };

  for (const paragraph of paragraphs) append(paragraph);
  if (current) pieces.push(current);
  return pieces.filter(Boolean);
}

function splitBySentenceOrWidth(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [text];
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current}${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      pieces.push(current);
      current = "";
    }
    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }
    pieces.push(...splitAtPreferredBoundaries(sentence, maxChars));
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitAtPreferredBoundaries(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const minimumBoundary = Math.floor(maxChars * 0.6);
    const window = remaining.slice(0, maxChars + 1);
    const whitespaceIndex = Math.max(
      window.lastIndexOf(" "),
      window.lastIndexOf("\n"),
      window.lastIndexOf("\t"),
    );
    const splitIndex = whitespaceIndex >= minimumBoundary ? whitespaceIndex : maxChars;
    pieces.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\s+/, "");
  }

  if (remaining) pieces.push(remaining);
  return pieces;
}
