export const QUOTA_STALE_AFTER_MS = 15 * 60 * 1000;

function finitePercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function unixSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8_640_000_000_000 ? Math.floor(value) : undefined;
}

function quotaWindow(value) {
  if (!value || typeof value !== "object") return undefined;
  const usedPercent = finitePercent(value.used_percent ?? value.usedPercent);
  if (usedPercent === undefined) return undefined;
  const windowDurationMins = value.windowDurationMins ?? (typeof value.limit_window_seconds === "number" ? value.limit_window_seconds / 60 : undefined);
  return {
    usedPercent,
    windowDurationMins: typeof windowDurationMins === "number" && Number.isFinite(windowDurationMins) && windowDurationMins >= 0 ? windowDurationMins : undefined,
    resetsAt: unixSeconds(value.reset_at ?? value.resetsAt),
  };
}

function snapshot(limitId, value) {
  if (!value || typeof value !== "object") return undefined;
  const primary = quotaWindow(value.primary_window ?? value.primary);
  const secondary = quotaWindow(value.secondary_window ?? value.secondary);
  if (!primary && !secondary && typeof value.allowed !== "boolean" && typeof value.limit_reached !== "boolean") return undefined;
  return {
    limitId,
    allowed: typeof value.allowed === "boolean" ? value.allowed : undefined,
    limitReached: typeof value.limit_reached === "boolean" ? value.limit_reached : undefined,
    label: typeof value.limit_name === "string" ? value.limit_name : typeof value.limitName === "string" ? value.limitName : undefined,
    primary,
    secondary,
  };
}

/** Normalize the read-only official Codex usage response without retaining raw server data. */
export function normalizeQuotaPayload(payload, fetchedAt = Date.now()) {
  if (!payload || typeof payload !== "object") throw new Error("Codex quota response was not an object.");
  const windows = [];
  const primary = snapshot("codex", payload.rate_limit ?? payload.rateLimits);
  if (primary) windows.push(primary);
  const additional = payload.additional_rate_limits ?? payload.rateLimitsByLimitId;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const id = typeof entry?.metered_feature === "string" ? entry.metered_feature : typeof entry?.limit_name === "string" ? entry.limit_name : undefined;
      const entrySnapshot = snapshot(id ?? `additional-${windows.length + 1}`, entry?.rate_limit ?? entry);
      if (entrySnapshot) windows.push(entrySnapshot);
    }
  } else if (additional && typeof additional === "object") {
    for (const [id, value] of Object.entries(additional)) {
      const entrySnapshot = snapshot(id, value);
      if (entrySnapshot) windows.push(entrySnapshot);
    }
  }
  if (windows.length === 0) throw new Error("Codex quota response contained no rate-limit windows.");
  return {
    fetchedAt,
    ordinaryUsageAllowed: typeof payload.ordinaryUsageAllowed === "boolean" ? payload.ordinaryUsageAllowed : typeof payload.rate_limit?.allowed === "boolean" ? payload.rate_limit.allowed : undefined,
    windows,
  };
}

export function quotaFreshness(quota, now = Date.now()) {
  if (!quota?.fetchedAt || typeof quota.fetchedAt !== "number" || !Array.isArray(quota.windows)) return { state: "unknown" };
  const ageMs = Math.max(0, now - quota.fetchedAt);
  return { state: ageMs >= QUOTA_STALE_AFTER_MS ? "stale" : "current", ageMs };
}

function timestamp(seconds) {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : "reset unknown";
}

function formatWindow(name, window) {
  if (!window) return undefined;
  return `${name} ${Math.max(0, 100 - window.usedPercent)}% left, ${timestamp(window.resetsAt)}`;
}

export function formatQuota(quota, now = Date.now()) {
  const freshness = quotaFreshness(quota, now);
  if (freshness.state === "unknown") return "quota unknown";
  const age = freshness.state === "stale" ? `stale ${new Date(quota.fetchedAt).toISOString()}` : `updated ${new Date(quota.fetchedAt).toISOString()}`;
  const windows = quota.windows.flatMap(limit => [
    formatWindow(`${limit.label ?? limit.limitId} primary`, limit.primary),
    formatWindow(`${limit.label ?? limit.limitId} secondary`, limit.secondary),
  ]).filter(Boolean);
  return `${windows.join("; ")} (${age})`;
}

function windowName(limit, name, window) {
  const minutes = window?.windowDurationMins;
  if (typeof minutes === "number" && minutes > 0) {
    if (minutes < 60) return `${Math.round(minutes)}m`;
    return minutes >= 2880 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`;
  }
  return limit.limitId === "codex" ? name : `${limit.label ?? limit.limitId} ${name}`;
}

/** The plan's tightest limit: the window with the least remaining percentage. */
export function bindingWindow(quota) {
  if (!quota || !Array.isArray(quota.windows)) return undefined;
  let lowest;
  for (const limit of quota.windows) {
    if (limit.limitReached === true || limit.allowed === false) {
      return { percent: 0, name: `${limit.label ?? limit.limitId} limit reached`, resetsAt: limit.primary?.resetsAt ?? limit.secondary?.resetsAt };
    }
    for (const name of ["primary", "secondary"]) {
      const window = limit[name];
      if (!window || typeof window.usedPercent !== "number") continue;
      const percent = Math.max(0, 100 - window.usedPercent);
      if (!lowest || percent < lowest.percent) lowest = { percent, name: windowName(limit, name, window), resetsAt: window.resetsAt };
    }
  }
  return lowest;
}

/** Remaining percentage on the tightest window, or undefined when no usage is known. */
export function quotaHeadroom(quota) {
  return bindingWindow(quota)?.percent;
}

function resetCountdown(seconds, now) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?";
  const remaining = seconds * 1000 - now;
  if (remaining <= 0) return "0m";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
  if (hours) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${minutes}m`;
}

export function compactQuota(quota, now = Date.now()) {
  const binding = bindingWindow(quota);
  if (!binding) return "?% · ?";
  return `${binding.percent}% · ${resetCountdown(binding.resetsAt, now)}`;
}

/** Official codex-api rate_limits.rs header families; retain omitted windows and their age. */
export function mergeQuotaHeaders(previous, headers, fetchedAt = Date.now()) {
  const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const ids = new Set(["codex"]);
  for (const name of Object.keys(values)) {
    const match = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(name);
    if (match) ids.add(match[1]);
  }
  const limits = new Map((previous?.windows ?? []).map(limit => [limit.limitId, { ...limit, fetchedAt: limit.fetchedAt ?? previous.fetchedAt }]));
  let changed = false;
  for (const id of ids) {
    const limitId = id.replaceAll("-", "_");
    const old = limits.get(limitId);
    const limit = { ...old, limitId };
    let complete = true, found = false;
    for (const name of ["primary", "secondary"]) {
      const prefix = `x-${id}-${name}`;
      const raw = values[`${prefix}-used-percent`];
      if (raw === undefined || !String(raw).trim()) { if (old?.[name]) complete = false; continue; }
      const window = quotaWindow({ usedPercent: Number(raw), windowDurationMins: values[`${prefix}-window-minutes`] === undefined ? undefined : Number(values[`${prefix}-window-minutes`]), resetsAt: Number(values[`${prefix}-reset-at`]) });
      if (!window) { complete = false; continue; }
      limit[name] = window;
      found = true;
    }
    if (found) {
      changed = true;
      // A partial header response must not rejuvenate an omitted weekly limit.
      limit.fetchedAt = complete ? fetchedAt : old?.fetchedAt ?? previous?.fetchedAt;
      limits.set(limitId, limit);
    }
  }
  return changed ? { ...previous, fetchedAt, windows: [...limits.values()] } : undefined;
}
