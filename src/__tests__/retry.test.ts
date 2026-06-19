/**
 * Retry utility tests.
 */

import { describe, it, expect } from "vitest";
import { withRetry } from "@/utils/retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("retries on failure and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return Promise.resolve("success");
      },
      { maxRetries: 3, baseDelayMs: 10 },
    );

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("throws after max retries exceeded", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new Error("always fails");
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("always fails");

    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("calls onRetry callback", async () => {
    const retries: number[] = [];
    await withRetry(
      () => {
        throw new Error("fail");
      },
      {
        maxRetries: 2,
        baseDelayMs: 10,
        onRetry: (attempt) => retries.push(attempt),
      },
    ).catch(() => {});

    expect(retries).toEqual([1, 2]);
  });
});
