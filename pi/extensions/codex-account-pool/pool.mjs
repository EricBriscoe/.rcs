export { quotaResetAt, isQuotaExhaustion, shouldFailover } from "../memory/codex-quota.mjs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

const STATE_VERSION = 1;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 5_000;

export function poolStatePath(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "codex-account-pool", "state.json");
}

export function emptyState() {
  return { version: STATE_VERSION, enabled: false, accounts: [] };
}

function validAccount(value) {
  return value && typeof value === "object" && typeof value.label === "string" &&
    typeof value.accountId === "string" && typeof value.access === "string" &&
    typeof value.refresh === "string" && typeof value.expires === "number" &&
    typeof value.enabled === "boolean";
}

export function normalizeState(value) {
  if (!value || typeof value !== "object" || value.version !== STATE_VERSION ||
      typeof value.enabled !== "boolean" || !Array.isArray(value.accounts) ||
      !value.accounts.every(validAccount)) {
    throw new Error("Codex account pool state is invalid; leave it unchanged and repair it manually.");
  }
  return value;
}

async function ensureDir(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await (await open(directory, "r")).close();
}

export async function readPoolState(path = poolStatePath()) {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeAtomic(path, value, assertOwnership = () => {}) {
  assertOwnership();
  await ensureDir(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    assertOwnership();
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // A lock can be compromised while the temporary file is being written.
    // Never publish it unless this owner still owns the critical section.
    assertOwnership();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Codex account pool lock wait cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Codex account pool lock wait cancelled.")); }, { once: true });
  });
}

/** Uses proper-lockfile's maintained atomic mkdir/stale-recovery protocol. */
async function withLock(path, operation, { timeoutMs = 90_000, signal } = {}) {
  await ensureDir(path);
  const directory = dirname(path);
  const deadline = Date.now() + timeoutMs;
  let release;
  let compromised;
  const ownershipController = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, ownershipController.signal]) : ownershipController.signal;
  const assertOwnership = () => {
    if (compromised) throw new Error("Codex account pool lock ownership was lost.");
  };
  while (!release) {
    if (signal?.aborted) throw new Error("Codex account pool lock wait cancelled.");
    try {
      release = await lockfile.lock(directory, {
        realpath: true,
        lockfilePath: `${path}.lock`,
        stale: LOCK_STALE_MS,
        update: 1_000,
        retries: 0,
        onCompromised(error) {
          compromised = error;
          ownershipController.abort();
        },
      });
    } catch (error) {
      if (error?.code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Codex account pool lock; another Pi process may still be refreshing an account.");
      await sleep(25, signal);
    }
  }
  try {
    assertOwnership();
    const result = await operation({ assertOwnership, signal: operationSignal });
    assertOwnership();
    return result;
  } finally {
    await release().catch(() => {});
  }
}

export async function updatePoolState(mutator, path = poolStatePath()) {
  return withLock(path, async ({ assertOwnership, signal }) => {
    const state = await readPoolState(path);
    assertOwnership();
    const result = await mutator(state, { assertOwnership, signal });
    assertOwnership();
    normalizeState(state);
    await writeAtomic(path, state, assertOwnership);
    return result;
  });
}

export function publicAccount(account, now = Date.now()) {
  const ready = account.enabled && (!account.exhausted || (typeof account.resetAt === "number" && account.resetAt <= now));
  return { label: account.label, accountId: account.accountId, enabled: account.enabled, exhausted: Boolean(account.exhausted), resetAt: account.resetAt, ready };
}

export function statusSummary(state, now = Date.now()) {
  return { enabled: state.enabled, accounts: state.accounts.map(account => publicAccount(account, now)) };
}

export function eligibleAccounts(state, now = Date.now()) {
  if (!state.enabled) return [];
  return state.accounts.filter(account => account.enabled && (!account.exhausted || (typeof account.resetAt === "number" && account.resetAt <= now)));
}

export function allExhaustedMessage(state, now = Date.now()) {
  const enabled = state.accounts.filter(account => account.enabled);
  if (enabled.length === 0) return "Codex account pool has no enabled accounts.";
  const resets = enabled.map(account => account.resetAt).filter(reset => typeof reset === "number" && reset > now);
  const nextReset = resets.length ? Math.min(...resets) : undefined;
  return nextReset ? `All enabled ChatGPT Codex accounts are exhausted until ${new Date(nextReset).toISOString()}.` : "All enabled ChatGPT Codex accounts are exhausted; no reset time was provided by the server.";
}

export function isModelAccessError(message) {
  return /\bmodel\b.*\b(not found|not available|not supported|access denied|permission)|\b(access denied|permission denied)\b.*\bmodel\b/i.test(message);
}

export async function markExhausted(accountId, resetAt, path = poolStatePath(), background = false, observedAt = Date.now()) {
  await updatePoolState(state => {
    const account = state.accounts.find(candidate => candidate.accountId === accountId);
    if (!account) return;
    account.exhausted = true;
    account.exhaustedAt = observedAt;
    if (background) { state.backgroundHoldAccountId = accountId; account.memoryReserve = true; }
    if (resetAt !== undefined) account.resetAt = resetAt;
    else delete account.resetAt;
  }, path);
}

class PoolAccountUnavailableError extends Error {
  code = "POOL_ACCOUNT_UNAVAILABLE";
}

export function isPoolAccountUnavailable(error) {
  return error instanceof PoolAccountUnavailableError;
}

export async function resolveAccount(accountId, oauth, signal, path = poolStatePath(), now = Date.now(), allowDisabled = false) {
  return withLock(path, async ({ assertOwnership, signal: operationSignal }) => {
    const state = await readPoolState(path);
    const account = state.accounts.find(candidate => candidate.accountId === accountId && (candidate.enabled || allowDisabled));
    if (!account || (!allowDisabled && (!state.enabled || !eligibleAccounts(state, now).some(candidate => candidate.accountId === accountId)))) {
      throw new PoolAccountUnavailableError("Codex account is no longer eligible.");
    }
    if (account.expires > now + REFRESH_SKEW_MS) return { ...account };
    const refreshed = await oauth.refresh({ type: "oauth", ...account }, operationSignal);
    assertOwnership();
    const refreshedId = typeof refreshed.accountId === "string" ? refreshed.accountId : account.accountId;
    if (refreshedId !== account.accountId) throw new Error("Refreshed Codex credentials belong to a different account.");
    if (typeof refreshed.access !== "string" || typeof refreshed.refresh !== "string" || typeof refreshed.expires !== "number") throw new Error("OpenAI Codex refresh returned incomplete credentials.");
    // Re-read eligibility after a possibly slow refresh so concurrent disable/cooldown wins.
    const latest = await readPoolState(path);
    const current = latest.accounts.find(candidate => candidate.accountId === accountId);
    if (!current || (!allowDisabled && (!latest.enabled || !eligibleAccounts(latest).some(candidate => candidate.accountId === accountId)))) {
      throw new PoolAccountUnavailableError("Codex account became ineligible while refreshing.");
    }
    assertOwnership();
    current.access = refreshed.access;
    current.refresh = refreshed.refresh;
    current.expires = refreshed.expires;
    await writeAtomic(path, latest, assertOwnership);
    return { ...current };
  }, { signal });
}

export async function addAccount(label, credential, path = poolStatePath()) {
  const accountId = credential.accountId;
  if (!label.trim()) throw new Error("Account name is required.");
  if (typeof accountId !== "string" || !accountId) throw new Error("OpenAI Codex login did not return an account identity.");
  await updatePoolState(state => {
    const name = label.trim();
    if (state.accounts.some(account => account.accountId === accountId)) throw new Error("This ChatGPT account is already in the pool. Use /codex-pool relogin NAME to replace its credentials.");
    if (state.accounts.some(account => account.label === name)) throw new Error("A Codex account already uses that name. Use /codex-pool relogin NAME to replace its credentials.");
    state.accounts.push({ label: name, accountId, access: credential.access, refresh: credential.refresh, expires: credential.expires, enabled: true });
  }, path);
}

export async function replaceAccountCredentials(label, credential, path = poolStatePath()) {
  if (!label.trim()) throw new Error("Account name is required.");
  if (typeof credential?.accountId !== "string" || !credential.accountId) throw new Error("OpenAI Codex login did not return an account identity.");
  await updatePoolState(state => {
    const account = state.accounts.find(candidate => candidate.label === label.trim());
    if (!account) throw new Error(`No Codex account named ${label.trim()}.`);
    if (account.accountId !== credential.accountId) throw new Error("Re-login must authenticate the same ChatGPT account; remove and add it explicitly to change account identity.");
    if (typeof credential.access !== "string" || typeof credential.refresh !== "string" || typeof credential.expires !== "number") throw new Error("OpenAI Codex login returned incomplete credentials.");
    account.access = credential.access;
    account.refresh = credential.refresh;
    account.expires = credential.expires;
  }, path);
}

export async function loginAndAdd(label, login, path = poolStatePath()) {
  const credential = await login();
  await addAccount(label, credential, path);
}

export async function loginAndReplace(label, login, path = poolStatePath()) {
  const credential = await login();
  await replaceAccountCredentials(label, credential, path);
}

/** Only observed foreground routing, not speculative preflight, releases a background hold. */
export async function noteForegroundAccount(accountId, path = poolStatePath()) {
  const before = await readPoolState(path);
  if (!before.backgroundHoldAccountId || before.backgroundHoldAccountId === accountId) return;
  await updatePoolState(state => {
    if (state.backgroundHoldAccountId !== accountId) delete state.backgroundHoldAccountId;
  }, path);
}
