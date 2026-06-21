/**
 * Security middleware — CORS, rate limiting, request size limits.
 * No external dependencies required — these are thin, auditable wrappers.
 */

import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// CORS — restrict to localhost origins only
// ---------------------------------------------------------------------------

const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers["origin"] as string | undefined;

  if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // If no origin header or origin doesn't match, we set no CORS header.
  // The response is still served (same-origin requests work), but browsers
  // will block cross-origin access.

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600"); // 10 min preflight cache

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), notifications=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

interface RateLimitOptions {
  windowMs?: number; // default: 60_000 (1 min)
  max?: number; // default: 30
  message?: string;
}

const store = new Map<string, RateLimitEntry>();

export function createRateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 30;
  const message = options.message ?? "Too many requests, please try again later.";

  // Periodic cleanup every 5 minutes to prevent memory leak
  if (store.size === 0) {
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of store) {
        if (now > entry.resetAt) store.delete(key);
      }
    }, 300_000);
    // Allow Node to exit even with this interval running
    if (cleanup.unref) cleanup.unref();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const entry = store.get(key);

    if (entry && now < entry.resetAt) {
      entry.count++;
      if (entry.count > max) {
        res.status(429).json({
          success: false,
          error: message,
        });
        return;
      }
      next();
      return;
    }

    // New window
    store.set(key, { count: 1, resetAt: now + windowMs });
    next();
  };
}
