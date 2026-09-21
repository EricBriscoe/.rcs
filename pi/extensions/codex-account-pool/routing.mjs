import { rankedAccounts } from "./pool.mjs";

const DEFAULT_CACHE_MINUTES = 10;

/**
 * How long the provider prompt cache is assumed warm. Reuses the efficiency
 * extension's idle-compaction threshold so the harness holds one assumption.
 */
export function cacheWindowMs(settings) {
  const minutes = settings?.efficiency?.idleCompactMinutes;
  const valid = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
  return Math.round((valid ? minutes : DEFAULT_CACHE_MINUTES) * 60_000);
}

/**
 * Cache-aware account choice. Subscription usage is almost entirely input
 * context, and every account switch re-reads the whole conversation on the new
 * account. So the account that served the last request stays first while the
 * cache is warm; stored primary/fallback priority decides at cold boundaries.
 * Once the fallback is idle, an eligible primary takes over again.
 */
export function createRouter({ cacheWindowMs: windowMs = cacheWindowMs(), keyOf = accountId => accountId } = {}) {
  let last;
  return {
    setWindow(ms) { windowMs = ms; },
    /** Candidate order for the next request; failover walks it in order. */
    order(state, now = Date.now()) {
      const ranked = rankedAccounts(state, now);
      if (last && now - last.at < windowMs) {
        const index = ranked.findIndex(account => keyOf(account.accountId) === last.key);
        if (index > 0) ranked.unshift(...ranked.splice(index, 1));
      }
      return ranked;
    },
    served(accountId, at = Date.now()) { last = { key: keyOf(accountId), at }; },
    /** Rebuild the sticky account from a resumed session's last assistant message. */
    restore(entries, accountKeys) {
      last = undefined;
      for (const entry of entries) {
        if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.responseId) continue;
        const key = accountKeys.get(entry.message.responseId);
        if (!key) continue;
        const at = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(entry.timestamp);
        if (Number.isFinite(at)) last = { key, at };
      }
      return last;
    },
    current() { return last; },
  };
}
