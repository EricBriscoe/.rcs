import { QUOTA_STALE_AFTER_MS } from "./quota.mjs";

export const MAX_TIMER_DELAY_MS = 0x7fffffff;

/** Return the next local status transition without performing any network work. */
export function nextFooterUpdateMs(state, now = Date.now()) {
  const deadlines = [];
  for (const account of state.accounts) {
    if (typeof account.resetAt === "number" && account.resetAt > now) deadlines.push(account.resetAt);
    const staleAt = account.quota?.fetchedAt;
    if (typeof staleAt === "number" && staleAt + QUOTA_STALE_AFTER_MS > now) deadlines.push(staleAt + QUOTA_STALE_AFTER_MS);
  }
  if (deadlines.length === 0) return undefined;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.min(...deadlines) - now));
}

/**
 * Invalidate stale Pi event contexts across asynchronous state reads. Every new
 * update and shutdown advances the generation, so an older read cannot touch UI
 * or schedule a timer after its context lifetime ends.
 */
export function createFooterController({ readState, renderStatus, statusLine, disabledStatus, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
  let footerContext;
  let footerTimer;
  let generation = 0;

  function clearFooterTimer() {
    if (footerTimer !== undefined) {
      clearTimer(footerTimer);
      footerTimer = undefined;
    }
  }

  async function update(ctx = footerContext) {
    if (!ctx) return;
    footerContext = ctx;
    const updateGeneration = ++generation;
    clearFooterTimer();
    const state = await readState();
    if (generation !== updateGeneration || footerContext !== ctx) return;
    if (!state.enabled) {
      renderStatus(ctx, disabledStatus);
      return;
    }
    renderStatus(ctx, statusLine(state));
    if (generation !== updateGeneration || footerContext !== ctx) return;
    const delay = nextFooterUpdateMs(state);
    if (delay !== undefined) {
      footerTimer = setTimer(() => { void update().catch(onError); }, delay);
    }
  }

  function refresh() {
    void update().catch(onError);
  }

  function shutdown(ctx) {
    ++generation;
    clearFooterTimer();
    // Event contexts are not identity-stable in Pi; always invalidate ours.
    footerContext = undefined;
    try { renderStatus(ctx, undefined); } catch (error) { onError(error); }
  }

  return { update, refresh, shutdown };
}
