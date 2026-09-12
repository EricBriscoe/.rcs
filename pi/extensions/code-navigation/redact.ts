// This is defense in depth, not a guarantee that arbitrary secrets can be detected.
export function redact(text: string): string {
  return text
    .replace(/<private\b[^>]*>[\s\S]*?(?:<\/private>|$)/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g, "[REDACTED]")
    .replace(/(?:sk-[\w-]{12,}|gh[pousr]_[\w]{15,}|github_pat_[\w]{15,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{10,})/g, "[REDACTED]")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[\w+/=.-]{8,}/gi, "$1 [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:[\w.-]*(?:password|passwd|secret|token|api[_-]?key|authorization)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]");
}
