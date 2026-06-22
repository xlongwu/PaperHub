import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 4;
const ROBOTS_MAX_BYTES = 128 * 1024;
const SAFE_FETCH_USER_AGENT = "PaperHub/0.1 safe-content-fetcher";
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/pdf",
]);

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: ReadonlySet<string>;
  respectRobotsTxt?: boolean;
  robotsUserAgent?: string;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
  fetchedAt: string;
  contentHash: string;
  redirectCount: number;
}

export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHostname = options.resolveHostname ?? resolvePublicAddresses;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowedContentTypes = options.allowedContentTypes ?? ALLOWED_CONTENT_TYPES;
  let current = parseSafeUrl(input);
  let redirectCount = 0;

  while (true) {
    await assertPublicTarget(current, resolveHostname);
    if (options.respectRobotsTxt) {
      await assertRobotsAllowed(
        current,
        fetchImpl,
        resolveHostname,
        timeoutMs,
        options.robotsUserAgent ?? SAFE_FETCH_USER_AGENT,
        options.signal,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8",
          "User-Agent": options.robotsUserAgent ?? SAFE_FETCH_USER_AGENT,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Safe Fetch timed out or was cancelled.");
      throw new Error(`Safe Fetch failed: ${error instanceof Error ? error.message : "network error"}`);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
    }

    if (isRedirect(response.status)) {
      if (redirectCount >= maxRedirects) throw new Error("Safe Fetch exceeded the redirect limit.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Safe Fetch received a redirect without a Location header.");
      current = parseSafeUrl(new URL(location, current).toString());
      redirectCount++;
      continue;
    }
    if (!response.ok) throw new Error(`Safe Fetch returned HTTP ${response.status}.`);

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!allowedContentTypes.has(contentType)) {
      throw new Error(`Safe Fetch rejected Content-Type ${contentType || "unknown"}.`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("Safe Fetch response exceeds the configured size limit.");
    }
    const headerBytes = [...response.headers].reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );
    if (headerBytes > 64 * 1024) throw new Error("Safe Fetch response headers are too large.");

    const body = await readBoundedBody(response, maxBytes, timeoutMs, options.signal);
    return {
      requestedUrl: input,
      finalUrl: current.toString(),
      contentType,
      body,
      fetchedAt: new Date().toISOString(),
      contentHash: createHash("sha256").update(body).digest("hex"),
      redirectCount,
    };
  }
}

async function assertRobotsAllowed(
  target: URL,
  fetchImpl: typeof fetch,
  resolveHostname: (hostname: string) => Promise<string[]>,
  timeoutMs: number,
  userAgent: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  const robotsUrl = new URL("/robots.txt", target);
  await assertPublicTarget(robotsUrl, resolveHostname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await fetchImpl(robotsUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": userAgent },
    });
    if (response.status === 404 || response.status === 410) return;
    if (!response.ok || !response.body) return;
    const body = await readBoundedBody(response, ROBOTS_MAX_BYTES, timeoutMs, parentSignal);
    const text = new TextDecoder().decode(body);
    if (!robotsAllows(text, userAgent, target.pathname || "/")) {
      throw new Error("Safe Fetch blocked by robots.txt.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("robots.txt")) throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function robotsAllows(robotsText: string, userAgent: string, path: string): boolean {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[] } | undefined;
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "disallow") current.disallow.push(value);
    if (key === "allow") current.allow.push(value);
  }
  const ua = userAgent.toLowerCase();
  const applicable = groups.filter((group) =>
    group.agents.some((agent) => agent === "*" || ua.includes(agent)),
  );
  const rules = applicable.length > 0 ? applicable : groups.filter((group) => group.agents.includes("*"));
  const longestAllow = longestMatchingRule(rules.flatMap((group) => group.allow), path);
  const longestDisallow = longestMatchingRule(rules.flatMap((group) => group.disallow), path);
  if (!longestDisallow) return true;
  if (!longestAllow) return false;
  return longestAllow.length >= longestDisallow.length;
}

function longestMatchingRule(rules: string[], path: string): string | undefined {
  return rules
    .filter((rule) => rule && path.startsWith(rule))
    .sort((a, b) => b.length - a.length)[0];
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
      return isBlockedIpAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return true;
}

async function assertPublicTarget(
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Safe Fetch blocked a local or metadata hostname.");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some(isBlockedIpAddress)) {
    throw new Error("Safe Fetch blocked a private, reserved, or unresolved address.");
  }
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(records.map((record) => record.address))];
}

function parseSafeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Safe Fetch requires a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Safe Fetch only allows HTTP and HTTPS URLs.");
  }
  if (url.username || url.password) throw new Error("Safe Fetch does not allow URL credentials.");
  return url;
}

function normalizeContentType(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (parentSignal?.aborted || Date.now() > deadline) {
        throw new Error("Safe Fetch timed out or was cancelled.");
      }
      const remaining = Math.max(1, deadline - Date.now());
      const part = await readWithTimeout(reader, remaining);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) throw new Error("Safe Fetch response exceeds the configured size limit.");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Safe Fetch download timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
