/**
 * Summarizer prompt builder.
 */

import type { Document } from "@/types";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function buildSummaryPrompt(doc: Document, lang: "zh" | "en" = "zh"): string {
  const typeLabel = doc.typeTag === "paper" ? "学术论文" : "技术博客";
  const typeLabelEn = doc.typeTag === "paper" ? "academic paper" : "technical blog post";

  const content = doc.abstract || "";
  const authors = doc.authors.join(", ") || "Unknown";

  if (lang === "zh") {
    return `请对以下${typeLabel}进行摘要总结：

标题：${doc.title}
作者：${authors}
来源：${doc.sourceTag}
发布时间：${doc.publishedAt}

原文内容：
${content}

要求：
1. 用中文输出，字数控制在 200-400 字
2. 包含：研究背景、核心方法、主要结论、创新点
3. 文末必须附带引用信息：**来源**: [${doc.title}](${doc.url})

摘要：`;
  }

  return `Please summarize the following ${typeLabelEn}:

Title: ${doc.title}
Authors: ${authors}
Source: ${doc.sourceTag}
Published: ${doc.publishedAt}

Content:
${content}

Requirements:
1. Output in English, 200-400 words
2. Include: research background, core methodology, main conclusions, innovations
3. End with citation: **Source**: [${doc.title}](${doc.url})

Summary:`;
}
