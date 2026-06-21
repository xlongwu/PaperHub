const SENSITIVE_KEY = /api[_-]?key|authorization|token|secret|password|credential/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/gi;

export function redactSensitiveText(value: string, knownSecrets: string[] = []): string {
  let result = value.replace(SECRET_VALUE, "[REDACTED]");
  for (const secret of knownSecrets.filter((item) => item.length >= 4)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function redactLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return new Error(redactSensitiveText(value.message));
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactLogValue(item),
      ]),
    );
  }
  return value;
}

export function formatRedactedLogArguments(args: unknown[]): string {
  return args
    .map((arg) => {
      const redacted = redactLogValue(arg);
      if (typeof redacted === "string") return redacted;
      if (redacted instanceof Error) return redacted.message;
      try {
        return JSON.stringify(redacted);
      } catch {
        return String(redacted);
      }
    })
    .join(" ");
}
