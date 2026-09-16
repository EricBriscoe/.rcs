/**
 * Idle compaction: once the provider's prompt cache has almost certainly expired,
 * the next request re-reads the whole context anyway, so deep chain compression
 * (pi-condense `/pruner compact`) becomes free. Decide when that moment is.
 */
export interface IdleCompactionInput {
  idleMs: number;
  thresholdMs: number;
  tokens: number | null | undefined;
  minTokens: number;
  agentIdle: boolean;
  pendingMessages: boolean;
  prunerAvailable: boolean;
}

export interface IdleCompactionSettings { enabled: boolean; thresholdMs: number; minTokens: number }

const DEFAULT_MINUTES = 10, DEFAULT_MIN_TOKENS = 30_000;
const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

/** `efficiency.idleCompactMinutes` (0 disables) and `efficiency.idleCompactMinTokens` from settings.json. */
export function idleCompactionSettings(settings: any): IdleCompactionSettings {
  const minutes = number(settings?.efficiency?.idleCompactMinutes, DEFAULT_MINUTES);
  return { enabled: minutes > 0, thresholdMs: Math.round(minutes * 60_000), minTokens: number(settings?.efficiency?.idleCompactMinTokens, DEFAULT_MIN_TOKENS) };
}

export function idleCompactionDecision(input: IdleCompactionInput): { compact: boolean; reason: string } {
  const idle = `idle ${Math.round(input.idleMs / 60_000)}m`;
  if (!input.prunerAvailable) return { compact: false, reason: "pi-condense not loaded" };
  if (input.tokens == null) return { compact: false, reason: "unknown context size" };
  if (input.tokens < input.minTokens) return { compact: false, reason: `context ${input.tokens} below ${input.minTokens}` };
  if (!input.agentIdle) return { compact: false, reason: "agent busy" };
  if (input.pendingMessages) return { compact: false, reason: "queued messages" };
  if (input.idleMs < input.thresholdMs) return { compact: false, reason: `${idle}, cache still warm` };
  return { compact: true, reason: `${idle}: provider cache expired, compaction is free` };
}
