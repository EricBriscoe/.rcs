export function quotaResetAt(message, headers = {}, now = Date.now()) {
  try {
    const parsed = JSON.parse(message);
    const seconds = parsed?.error?.resets_at ?? parsed?.error?.reset_at;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 8_640_000_000_000) return Math.floor(seconds * 1000);
  } catch {}
  const retry = headers["retry-after-ms"] ?? headers["retry-after"];
  if (retry !== undefined) {
    const milliseconds = Number(retry) * (headers["retry-after-ms"] !== undefined ? 1 : 1000);
    if (Number.isFinite(milliseconds) && milliseconds >= 0 && now + milliseconds <= 8_640_000_000_000_000) return now + milliseconds;
  }
  return undefined;
}

const TERMINAL_QUOTA_CODES = new Set([
  "usage_limit_reached", "usage_not_included", "insufficient_quota", "gousagelimiterror", "freeusagelimiterror",
]);
const TERMINAL_UNSTRUCTURED_QUOTA = /\b(?:GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached)\b/i;

export function isQuotaExhaustion(message, status) {
  if (status !== 429) return false;
  try {
    const parsed = JSON.parse(message);
    const code = parsed?.error?.code ?? parsed?.error?.type;
    // A server-provided code is authoritative: rate_limit_exceeded never rotates,
    // even if the human message contains a broad quota word.
    return typeof code === "string" && TERMINAL_QUOTA_CODES.has(code.toLowerCase());
  } catch {
    return TERMINAL_UNSTRUCTURED_QUOTA.test(message);
  }
}

/** A stream that has started may have emitted text or a tool call and is never replayed. */
export function shouldFailover({ started, aborted, message, status }) {
  return !started && !aborted && isQuotaExhaustion(message, status);
}
