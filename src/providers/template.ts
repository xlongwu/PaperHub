import type { JsonTemplate } from "./types";

const PLACEHOLDER_RE = /\{\{(prompt|model|maxTokens)\}\}/g;
const EXACT_PLACEHOLDER_RE = /^\{\{(prompt|model|maxTokens)\}\}$/;

export interface TemplateVariables {
  prompt: string;
  model: string;
  maxTokens: number;
}

export function renderJsonTemplate(template: JsonTemplate, variables: TemplateVariables): JsonTemplate {
  if (typeof template === "string") {
    const exact = EXACT_PLACEHOLDER_RE.exec(template);
    if (exact) {
      return variables[exact[1] as keyof TemplateVariables];
    }
    return renderTemplateString(template, variables);
  }
  if (Array.isArray(template)) {
    return template.map((value) => renderJsonTemplate(value, variables));
  }
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        renderTemplateString(key, variables),
        renderJsonTemplate(value, variables),
      ]),
    );
  }
  return template;
}

export function renderTemplateString(value: string, variables: TemplateVariables): string {
  return value.replace(PLACEHOLDER_RE, (_match, key: keyof TemplateVariables) => String(variables[key]));
}

export function extractJsonPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  if (!path.startsWith("$.")) {
    throw new Error('JSON path must start with "$.".');
  }

  const tokens = tokenizePath(path.slice(2));
  let current: unknown[] = [value];
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const item of current) {
      if (token === "*") {
        if (Array.isArray(item)) next.push(...item);
        continue;
      }
      if (typeof token === "number") {
        if (Array.isArray(item) && token < item.length) next.push(item[token]);
        continue;
      }
      if (item && typeof item === "object" && token in item) {
        next.push((item as Record<string, unknown>)[token]);
      }
    }
    current = next;
  }

  if (current.length === 0) return undefined;
  return current.length === 1 ? current[0] : current;
}

export function validateJsonPath(path: string): void {
  extractJsonPath({}, path);
}

function tokenizePath(path: string): Array<string | number> {
  if (!path) return [];
  const tokens: Array<string | number> = [];
  const parts = path.split(".");
  for (const part of parts) {
    if (!part) throw new Error("JSON path contains an empty segment.");
    const property = /^([A-Za-z0-9_-]+)/.exec(part);
    let cursor = 0;
    if (property) {
      tokens.push(property[1]!);
      cursor = property[0].length;
    }
    while (cursor < part.length) {
      const bracket = /^\[(\d+|\*)\]/.exec(part.slice(cursor));
      if (!bracket) throw new Error(`Unsupported JSON path segment: ${part}`);
      tokens.push(bracket[1] === "*" ? "*" : Number(bracket[1]));
      cursor += bracket[0].length;
    }
  }
  return tokens;
}
