import { eligibleAccounts, readPoolState, updatePoolState, poolStatePath } from "./pool.mjs";

export const MEMORY_QUOTA_MAX_AGE = 5 * 60_000;
export const MEMORY_REFRESH_COOLDOWN = 60_000;

/** All reported limits apply conservatively; credits never authorize subscription learning. */
export function memoryQuotaAdmission(account, policy, now = Date.now()) {
  const quota = account.quota;
  const limits = quota?.windows ?? [];
  const windows = limits.flatMap(limit => [limit.primary, limit.secondary].filter(Boolean).map(window => ({ ...window, fetchedAt: limit.fetchedAt ?? quota.fetchedAt })));
  if (account.exhausted && !Number.isFinite(account.exhaustedAt)) account.exhaustedAt = now;
  const denied = quota?.ordinaryUsageAllowed === false || limits.some(limit => limit.allowed === false || limit.limitReached === true);
  const low = windows.filter(window => 100 - window.usedPercent < policy.pause);
  const fresh = windows.length > 0 && windows.every(window => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
    window.fetchedAt <= now && now - window.fetchedAt < MEMORY_QUOTA_MAX_AGE && (!window.resetsAt || window.resetsAt * 1000 > now));
  const recovered = fresh && !denied && windows.every(window => 100 - window.usedPercent >= policy.resume);
  if (account.exhausted && recovered && windows.every(window => window.fetchedAt > account.exhaustedAt &&
      (!Number.isFinite(account.resetAt) || (now >= account.resetAt && window.fetchedAt >= account.resetAt)))) account.exhausted = false;
  const exhausted = !!account.exhausted;
  if (exhausted || denied || low.length) account.memoryReserve = true;
  if (recovered && !exhausted) account.memoryReserve = false;
  if (exhausted || denied || low.length || account.memoryReserve) {
    const resets = [...windows.filter(window => 100 - window.usedPercent < policy.resume).map(window => window.resetsAt * 1000), ...(exhausted ? [account.resetAt] : [])];
    const nextAt = resets.length && resets.every(reset => Number.isFinite(reset) && reset > now) ? Math.max(...resets) : undefined;
    return { allowed: false, mode: "quota", reason: "subscription reserve", nextAt: nextAt ?? now + MEMORY_REFRESH_COOLDOWN, accountId: account.accountId };
  }
  return { allowed: true, mode: fresh ? "quota" : "fallback", reason: fresh ? undefined : "quota unavailable", accountId: account.accountId };
}

export function backgroundAccount(state, now = Date.now()) {
  return state.backgroundHoldAccountId
    ? state.accounts.find(account => account.accountId === state.backgroundHoldAccountId && account.enabled)
    : eligibleAccounts(state, now)[0];
}

/** One shared current-account read per cooldown, even across Pi processes. */
export function createBackgroundQuota({ refresh, path = poolStatePath(), now = Date.now }) {
  async function evaluate(policy, expected) {
    return updatePoolState(state => {
      if (!state.enabled) return expected ? { allowed: false, mode: "quota", reason: "account changed" } : { allowed: true, mode: "fallback", reason: "quota unavailable" };
      const account = backgroundAccount(state, now());
      if (!account || (expected && expected !== account.accountId)) return { allowed: false, mode: "quota", reason: "account unavailable" };
      const admission = memoryQuotaAdmission(account, policy, now());
      if (admission.allowed && admission.mode === "quota" && state.backgroundHoldAccountId === account.accountId && eligibleAccounts(state, now())[0]?.accountId === account.accountId) delete state.backgroundHoldAccountId;
      return admission;
    }, path);
  }
  async function prepare(policy, signal, idle, expected, allowRefresh = true) {
    if (signal.aborted || !idle()) return { allowed: false, mode: "quota", reason: "working" };
    let admission = await evaluate(policy, expected);
    if (allowRefresh && admission.accountId) {
      const state = await readPoolState(path);
      const account = state.accounts.find(account => account.accountId === admission.accountId);
      const stale = (account?.exhausted && (!Number.isFinite(account.resetAt) || account.resetAt <= now())) || !account?.quota?.fetchedAt || now() - account.quota.fetchedAt >= MEMORY_QUOTA_MAX_AGE ||
        account.quota.windows.some(limit => now() - (limit.fetchedAt ?? account.quota.fetchedAt) >= MEMORY_QUOTA_MAX_AGE ||
          [limit.primary, limit.secondary].some(window => window?.resetsAt && window.resetsAt * 1000 <= now()));
      if (stale) {
        const reserved = await updatePoolState(state => {
          const current = backgroundAccount(state, now());
          if (signal.aborted || !idle() || current?.accountId !== admission.accountId || (current.memoryRefreshAt && now() - current.memoryRefreshAt < MEMORY_REFRESH_COOLDOWN)) return false;
          current.memoryRefreshAt = now();
          return true;
        }, path);
        if (reserved && !signal.aborted && idle()) {
          try { await refresh(admission.accountId, signal); } catch { /* Read failure changes no foreground eligibility. */ }
        }
        admission = await evaluate(policy, admission.accountId);
      }
    }
    return signal.aborted || !idle() ? { allowed: false, mode: admission.mode, reason: "working" } : admission;
  }
  return { prepare };
}
