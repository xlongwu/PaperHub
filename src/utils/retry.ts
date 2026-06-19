/**
 * Retry utilities with exponential backoff.
 */

import { getLogsDir } from "@/config";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;

      const delayMs = baseDelayMs * 2 ** attempt;
      options.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }

  // Should never reach here
  throw new Error("Retry exhausted");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

export function logError(context: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : "";
  const logLine = `[${timestamp}] [${context}] ${message}\n${stack ? stack + "\n" : ""}`;

  console.error(logLine.trim());

  try {
    const dir = path.join(getLogsDir(), "errors");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, logLine, "utf-8");
  } catch {
    // Ignore logging failures
  }
}
