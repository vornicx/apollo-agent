const SECRET_PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /gh[opurs]_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi,
];

const SECRET_KEY = /(api.?key|token|secret|password|authorization|credential)/i;

export function redactText(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), text);
}

/** Redact known credential shapes and values stored under credential-like keys. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T;
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY.test(key) && typeof entry === "string" ? "[REDACTED]" : redactSecrets(entry);
    }
    return redacted as T;
  }
  return value;
}
