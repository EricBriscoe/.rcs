import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getModels, openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  allExhaustedMessage, eligibleAccounts, isModelAccessError, isPoolAccountUnavailable, isQuotaExhaustion, loginAndAdd,
  loginAndReplace, markExhausted, noteForegroundAccount, quotaResetAt, readPoolState, shouldFailover, resolveAccount,
  statusSummary, updatePoolState,
} from "./pool.mjs";
import { compactQuota, formatQuota, normalizeQuotaPayload, mergeQuotaHeaders } from "./quota.mjs";
import { createBackgroundQuota } from "./background.mjs";
import { createFooterController } from "./footer.mjs";
import { openPoolMenu, POOL_HELP } from "./menu.mjs";

const PROVIDER_ID = "openai-codex";
const stockModels = getModels(PROVIDER_ID);
const stockAdapter = openAICodexResponsesApi();
const stockProvider = builtinProviders().find(provider => provider.id === PROVIDER_ID);
const officialOAuth = stockProvider?.auth.oauth;
const responseAccountKeys = new Map<string, string>();

type ResponseInfo = { status?: number; headers?: Record<string, string>; body?: string };
const backgroundRequests = new Map<string, any>();
let refreshFooter: (() => void) | undefined;

function accountKey(accountId: string) {
  return createHash("sha256").update(accountId).digest("hex");
}

function safeAuthenticationError() {
  // Installed OAuth errors can include whole token responses. Never surface them.
  return "Codex account authentication failed. Re-login this account with /codex-pool relogin NAME.";
}

function errorStream(model: Model<any>, message: string) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: message, timestamp: Date.now(),
  };
  queueMicrotask(() => { stream.push({ type: "error", reason: "error", error }); stream.end(); });
  return stream;
}

function scopedSessionId(sessionId: string | undefined, accountId: string, attempt: number) {
  if (!sessionId) return undefined;
  return `codex-pool-${createHash("sha256").update(`${sessionId}\0${accountId}\0${attempt}`).digest("hex").slice(0, 32)}`;
}

/** Strip account-bound response items while preserving readable transcript and tool/result pairing. */
export function contextForAccount(context: Context, targetAccountKey: string): Context {
  const remappedToolIds = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "assistant" || responseAccountKeys.get(message.responseId ?? "") === targetAccountKey) continue;
    for (const block of message.content) {
      if (block.type === "toolCall") remappedToolIds.set(block.id, block.id.split("|", 1)[0]);
    }
  }
  return {
    ...context,
    messages: context.messages.map(message => {
      if (message.role === "toolResult") {
        const toolCallId = remappedToolIds.get(message.toolCallId);
        return toolCallId ? { ...message, toolCallId } : message;
      }
      if (message.role !== "assistant" || responseAccountKeys.get(message.responseId ?? "") === targetAccountKey) return message;
      return {
        ...message,
        responseId: undefined,
        content: message.content.map(block => {
          if (block.type === "thinking") return { ...block, thinkingSignature: undefined };
          if (block.type === "text") return { ...block, textSignature: undefined };
          if (block.type === "toolCall") return { ...block, id: remappedToolIds.get(block.id) ?? block.id, namespace: undefined };
          return block;
        }),
      };
    }),
  };
}

function quotaEvidenceFetch(originalFetch: typeof globalThis.fetch, response: ResponseInfo, signal?: AbortSignal): typeof globalThis.fetch {
  return async (input, init) => {
    // Evidence belongs to this fetch only; never reuse a previous retry's 429.
    delete response.status; delete response.headers; delete response.body;
    if (signal?.aborted) throw new Error("Request was aborted");
    const result = await originalFetch(input, init);
    response.status = result.status;
    response.headers = Object.fromEntries(result.headers.entries());
    if (!result.ok) response.body = (await result.clone().text()).slice(0, 64 * 1024);
    return result;
  };
}

/** Only rotate an unstarted request after a structured Codex quota response. */
function pooledStream(model: Model<any>, context: Context, options: any = {}, simple = false) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const initial = await readPoolState();
    const background = backgroundRequests.get(options.sessionId);
    const defer = async (admission: any) => {
      background?.defer(admission);
      for await (const event of errorStream(model, "Background memory deferred.")) stream.push(event);
      stream.end();
    };
    if (background) {
      const admission = await background.check();
      if (!admission.allowed) { await defer(admission); return; }
    }
    const candidates = background ? eligibleAccounts(initial).filter(account => account.accountId === background.accountId).slice(0, 1) : eligibleAccounts(initial);
    if (candidates.length === 0) {
      if (background) { await defer({ allowed: false, mode: "quota", reason: "account unavailable" }); return; }
      for await (const event of errorStream(model, allExhaustedMessage(initial))) stream.push(event);
      stream.end();
      return;
    }

    let lastQuotaMessage: string | undefined;
    for (const [attempt, candidate] of candidates.entries()) {
      let account;
      try {
        if (!officialOAuth) throw new Error("Official Codex OAuth is unavailable in this Pi installation.");
        account = await resolveAccount(candidate.accountId, officialOAuth, options.signal);
      } catch (error) {
        if (background) { await defer({ allowed: false, mode: "quota", reason: "account unavailable" }); return; }
        if (isPoolAccountUnavailable(error)) continue;
        for await (const event of errorStream(model, safeAuthenticationError())) stream.push(event);
        stream.end();
        return;
      }
      if (background) {
        const admission = await background.check();
        if (!admission.allowed) { await defer(admission); return; }
      }
      let started = false;
      let failedOver = false;
      const response: ResponseInfo = {};
      const originalOnResponse = options.onResponse;
      const attemptOptions = {
        ...options,
        apiKey: account.access,
        sessionId: scopedSessionId(options.sessionId, account.accountId, attempt),
        // SSE exposes the pre-start HTTP response needed for safe structured quota classification.
        transport: "sse",
        // Do not let adapter retries obscure the terminal failure evidence.
        maxRetries: 0,
        fetch: quotaEvidenceFetch(async (input, init) => {
          if (background) {
            const admission = await background.check();
            if (!admission.allowed) { background.defer(admission); throw new Error("Background memory deferred."); }
            background.submitted = true;
          }
          const result = await (options.fetch ?? globalThis.fetch)(input, init);
          if (background && result.status === 429) {
            const body = (await result.clone().text()).slice(0, 65536);
            if (isQuotaExhaustion(body, result.status)) {
              const observedAt = Date.now();
              const resetAt = quotaResetAt(body, Object.fromEntries(result.headers.entries()), observedAt);
              // Publish synchronously before the state lock/write: cancellation must
              // preserve the owning batch even when it wins the completion race.
              background.defer({ allowed: false, mode: "quota", reason: "subscription reserve", nextAt: resetAt ?? observedAt + 60000 });
              await markExhausted(account.accountId, resetAt, undefined, true, observedAt);
              refreshFooter?.();
            }
          }
          try {
            const headers = Object.fromEntries(result.headers.entries());
            if (mergeQuotaHeaders(undefined, headers)) await updatePoolState(state => {
              const stored = state.accounts.find(candidate => candidate.accountId === account.accountId);
              if (stored) stored.quota = mergeQuotaHeaders(stored.quota, headers);
            });
          } catch { /* Passive quota capture must not break coding. */ }
          return result;
        }, response, options.signal),
        onResponse: async (info: { status: number; headers: Record<string, string> }, requestModel: Model<any>) => {
          response.status = info.status;
          response.headers = info.headers;
          await originalOnResponse?.(info, requestModel);
        },
      };
      try {
        const input = contextForAccount(context, accountKey(account.accountId));
        const inner = simple
          ? stockAdapter.streamSimple(model as any, input, attemptOptions)
          : stockAdapter.stream(model as any, input, attemptOptions);
        for await (const event of inner) {
          if (event.type === "start") {
            started = true;
            if (!background) { try { await noteForegroundAccount(account.accountId); } catch { /* A status hold cannot break coding. */ } }
          }
          if (event.type === "done" && event.message.responseId) responseAccountKeys.set(event.message.responseId, accountKey(account.accountId));
          if (event.type !== "error" || started) {
            stream.push(event);
            if (event.type === "error" || event.type === "done") { stream.end(); return; }
            continue;
          }
          if (background?.deferred) { await defer(background.deferred); return; }
          const message = event.error.errorMessage || "OpenAI Codex request failed";
          if (isModelAccessError(message)) {
            stream.push({ ...event, error: { ...event.error, errorMessage: `Codex account ${account.label} cannot use ${model.id}: ${message}` } });
            stream.end();
            return;
          }
          if (!shouldFailover({ started, aborted: options.signal?.aborted || event.error.stopReason === "aborted", message: response.body ?? "", status: response.status })) {
            stream.push(event);
            stream.end();
            return;
          }
          lastQuotaMessage = message;
          await markExhausted(account.accountId, quotaResetAt(response.body ?? "", response.headers), undefined, !!background);
          refreshFooter?.();
          if (background) {
            // The request was submitted and remains charged; never drain a backup.
            await defer({ allowed: false, mode: "quota", reason: "subscription reserve" });
            return;
          }
          failedOver = true;
          break;
        }
        if (failedOver) continue;
        for await (const event of errorStream(model, "Codex stream ended without a terminal event.")) stream.push(event);
        stream.end();
        return;
      } catch (error) {
        for await (const event of errorStream(model, error instanceof Error ? error.message : String(error))) stream.push(event);
        stream.end();
        return;
      }
    }
    const finalState = await readPoolState();
    for await (const event of errorStream(model, `${lastQuotaMessage ? `${lastQuotaMessage} ` : ""}${allExhaustedMessage(finalState)}`)) stream.push(event);
    stream.end();
  })().catch(async () => {
    for await (const event of errorStream(model, "Codex account pool request failed.")) stream.push(event);
    stream.end();
  });
  return stream;
}

function poolProvider(): Provider<any> {
  return {
    id: PROVIDER_ID,
    name: "OpenAI Codex (account pool)",
    baseUrl: "https://chatgpt.com/backend-api",
    // Stored subscription logins require an OAuth handler before pool routing.
    auth: { oauth: officialOAuth, apiKey: {
      name: "ChatGPT Codex account pool",
      // Registered only while enabled. Keep readiness synchronous: Pi startup
      // model selection can race filesystem-backed availability checks. Resolve
      // and the stream still re-read state before using any account.
      check() { return { type: "api_key", source: "Codex account pool" }; },
      async resolve() { return (await readPoolState()).enabled ? { auth: { apiKey: "codex-account-pool" }, source: "Codex account pool" } : undefined; },
    } },
    getModels: () => stockModels,
    stream: (model, context, options) => pooledStream(model, context, options, false),
    streamSimple: (model, context, options?: SimpleStreamOptions) => pooledStream(model, context, options, true),
  };
}

async function refreshQuota(accountId: string, signal?: AbortSignal) {
  if (!officialOAuth) throw new Error("Official Codex OAuth is unavailable in this Pi installation.");
  // This is the read-only endpoint used by OpenAI's official Codex app-server:
  // GET /backend-api/wham/usage with the account-scoped OAuth headers.
  const timeout = AbortSignal.timeout(10_000);
  const quotaSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const account = await resolveAccount(accountId, officialOAuth, quotaSignal, undefined, undefined, true);
  quotaSignal.throwIfAborted();
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: { Authorization: `Bearer ${account.access}`, "chatgpt-account-id": account.accountId, originator: "pi" },
    signal: quotaSignal,
  });
  if (!response.ok) throw new Error("Codex quota read was unavailable.");
  const quota = normalizeQuotaPayload(await response.json());
  await updatePoolState(state => {
    const stored = state.accounts.find(candidate => candidate.accountId === account.accountId);
    if (stored) stored.quota = quota;
  });
  return quota;
}

function poolStatusLine(state: Awaited<ReturnType<typeof readPoolState>>) {
  const active = eligibleAccounts(state)[0];
  return active ? `Codex pool: ${active.label} ${compactQuota(active.quota)}` : `Codex pool: ${allExhaustedMessage(state)}`;
}

function statusText(state: Awaited<ReturnType<typeof readPoolState>>) {
  const summary = statusSummary(state);
  const lines = [`Codex account pool: ${summary.enabled ? "enabled" : "disabled"}`];
  for (const account of summary.accounts) {
    const reset = account.resetAt ? ` reset ${new Date(account.resetAt).toISOString()}` : account.exhausted ? " reset unknown" : "";
    const stored = state.accounts.find(candidate => candidate.accountId === account.accountId);
    lines.push(`${account.enabled ? "on" : "off"} ${account.label} — ${account.ready ? "ready" : "exhausted"}${reset}; ${formatQuota(stored?.quota)}`);
  }
  if (summary.accounts.length === 0) lines.push("No accounts. Open /codex-pool to sign in.");
  return lines.join("\n");
}

async function loginAccount(label: string, method: string | undefined, ctx: any, replace = false) {
  if (!ctx.hasUI) throw new Error("Codex account login requires interactive Pi UI.");
  if (!officialOAuth) throw new Error("Official Codex OAuth is unavailable in this Pi installation.");
  const chosen = method || await ctx.ui.select("Codex account login", ["browser", "device"]);
  if (chosen !== "browser" && chosen !== "device") throw new Error("Login cancelled");
  const controller = new AbortController();
  try {
    await (replace ? loginAndReplace : loginAndAdd)(label, () => officialOAuth.login({
      signal: controller.signal,
      async prompt(prompt: any) {
        if (prompt.type === "select") return chosen === "device" ? "device_code" : "browser";
        const input = await ctx.ui.input("OpenAI Codex login", prompt.message, { signal: prompt.signal });
        if (input) return input;
        // Browser completion aborts only its manual-input dialog. Do not turn that into
        // a whole-flow cancellation; the official OAuth flow still owns its callback.
        if (prompt.signal?.aborted) throw new Error("Login prompt closed");
        controller.abort();
        throw new Error("Login cancelled");
      },
      notify(event: any) {
        if (event.type === "auth_url") {
          spawn("open", [event.url], { detached: true, stdio: "ignore" }).unref();
          ctx.ui.notify("Opened OpenAI Codex login in your browser.", "info");
        } else if (event.type === "device_code") {
          ctx.ui.notify(`Open ${event.verificationUri} and enter code ${event.userCode}.`, "info");
        } else if (event.type === "progress") ctx.ui.notify(event.message, "info");
      },
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "Login cancelled") throw error;
    throw new Error(safeAuthenticationError());
  }
}

export default async function (pi: ExtensionAPI) {
  const backgroundQuota = createBackgroundQuota({ refresh: refreshQuota });
  // Public event bus + public sessionId option: only this exact request is pinned.
  pi.events.on("rcs-memory:pool", (request: any) => {
    request.service = {
      prepare: backgroundQuota.prepare,
      register(sessionId: string, accountId: string, check: () => Promise<any>, onDeferred?: (admission: any, submitted: boolean) => void) {
        const entry: any = { accountId, check, submitted: false, deferred: undefined, defer(admission: any) {
          if (entry.deferred) return;
          entry.deferred = admission;
          onDeferred?.(admission, entry.submitted);
        } };
        backgroundRequests.set(sessionId, entry);
        return { entry, release() { backgroundRequests.delete(sessionId); } };
      },
    };
  });
  let installed = false;
  const install = () => { if (!installed) { pi.registerProvider(poolProvider()); installed = true; } };
  const uninstall = () => { if (installed) { pi.unregisterProvider(PROVIDER_ID); installed = false; } };
  const footer = createFooterController({
    readState: readPoolState,
    statusLine: poolStatusLine,
    disabledStatus: "Codex pool disabled",
    renderStatus(ctx: any, value: string | undefined) { ctx.ui.setStatus("codex-pool", value ? `${value} · /codex-pool` : value); },
  });
  const updateFooter = footer.update;
  refreshFooter = footer.refresh;
  if ((await readPoolState()).enabled) install();

  const handleAction = async (action: string, rest: string[], ctx: any) => {
    const label = rest[0];
    if (action === "status" || action === "list") {
      const state = await readPoolState();
      await updateFooter(ctx);
      ctx.ui.notify(statusText(state), "info");
      return;
    }
    if (action === "quota") {
      const before = await readPoolState();
      const targets = label ? before.accounts.filter(account => account.label === label) : before.accounts;
      if (targets.length === 0) throw new Error(label ? `No Codex account named ${label}.` : "No Codex accounts in the pool.");
      const lines: string[] = [];
      for (const target of targets) {
        try {
          const quota = await refreshQuota(target.accountId, ctx.signal);
          lines.push(`${target.label} — ${formatQuota(quota)}`);
        } catch {
          // A quota read never changes credentials, eligibility, or failover state.
          lines.push(`${target.label} — quota unavailable; ${formatQuota(target.quota)}`);
        }
      }
      await updateFooter(ctx);
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
    if (action === "add" || action === "login") {
      if (!label) throw new Error("Usage: /codex-pool add NAME [browser|device]");
      await loginAccount(label, rest[1], ctx);
      await updateFooter(ctx);
      ctx.ui.notify(`Added Codex account ${label}. Open /codex-pool to manage accounts and enable the pool.`, "info");
      return;
    }
    if (action === "relogin") {
      if (!label) throw new Error("Usage: /codex-pool relogin NAME [browser|device]");
      await loginAccount(label, rest[1], ctx, true);
      await updateFooter(ctx);
      ctx.ui.notify(`Refreshed credentials for Codex account ${label}.`, "info");
      return;
    }
    if (action === "import") throw new Error("Importing Pi's existing login is intentionally unavailable: this extension never reads existing credentials. Use /codex-pool add NAME instead.");
    if (action === "enable" || action === "disable") {
      if (!ctx.isIdle()) throw new Error("Change Codex pool enablement only while Pi is idle.");
      await updatePoolState(state => {
        if (label) {
          const account = state.accounts.find(candidate => candidate.label === label);
          if (!account) throw new Error(`No Codex account named ${label}.`);
          const previousRoute = state.accounts.find(account => account.enabled)?.accountId;
          account.enabled = action === "enable";
          if ((action === "disable" && state.backgroundHoldAccountId === account.accountId) || previousRoute !== state.accounts.find(account => account.enabled)?.accountId) delete state.backgroundHoldAccountId;
          if (action === "enable") { account.exhausted = false; delete account.resetAt; }
        } else state.enabled = action === "enable";
      });
      if ((await readPoolState()).enabled) {
        install();
        // First-time setup can start without a model. Finish activation here so
        // the next prompt works without a separate /model command or restart.
        if (!ctx.model || (ctx.model.provider === "unknown" && ctx.model.id === "unknown")) {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
          const available = ctx.modelRegistry.getAvailable().filter((model: Model<any>) => model.provider === PROVIDER_ID);
          const model = available.find((model: Model<any>) => model.id === settings.getDefaultModel()) ?? available[0];
          if (model && await pi.setModel(model)) pi.setThinkingLevel(settings.getDefaultThinkingLevel() ?? "off");
        }
      } else uninstall();
      await updateFooter(ctx);
      ctx.ui.notify(statusText(await readPoolState()), "info");
      return;
    }
    if (action === "priority") {
      const position = Number(rest[1]);
      if (!label || !Number.isInteger(position) || position < 1) throw new Error("Usage: /codex-pool priority NAME POSITION");
      await updatePoolState(state => {
        const index = state.accounts.findIndex(candidate => candidate.label === label);
        if (index < 0) throw new Error(`No Codex account named ${label}.`);
        const previousRoute = state.accounts.find(account => account.enabled)?.accountId;
        const [account] = state.accounts.splice(index, 1);
        state.accounts.splice(Math.min(position - 1, state.accounts.length), 0, account);
        if (previousRoute !== state.accounts.find(account => account.enabled)?.accountId) delete state.backgroundHoldAccountId;
      });
      await updateFooter(ctx);
      ctx.ui.notify(statusText(await readPoolState()), "info");
      return;
    }
    if (action === "remove") {
      if (!label) throw new Error("Usage: /codex-pool remove NAME");
      const ok = ctx.hasUI && await ctx.ui.confirm("Remove Codex account", `Remove ${label} from the account pool? This cannot be undone.`);
      if (!ok) { ctx.ui.notify("Removal cancelled.", "info"); return; }
      await updatePoolState(state => {
        const index = state.accounts.findIndex(candidate => candidate.label === label);
        if (index < 0) throw new Error(`No Codex account named ${label}.`);
        if (state.backgroundHoldAccountId === state.accounts[index].accountId) delete state.backgroundHoldAccountId;
        state.accounts.splice(index, 1);
      });
      await updateFooter(ctx);
      ctx.ui.notify(statusText(await readPoolState()), "info");
      return;
    }
    if (action === "help") { ctx.ui.notify(POOL_HELP, "info"); return; }
    throw new Error("Open /codex-pool for the interactive menu, or /codex-pool help for guidance.");
  };

  pi.registerCommand("codex-pool", {
    description: "Open Codex account settings: sign in, quota, priority, and remove logins",
    getArgumentCompletions: prefix => {
      const items = ["menu", "status", "quota", "add", "relogin", "enable", "disable", "priority", "remove", "help"]
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (raw, ctx) => {
      const [action = "menu", ...rest] = raw.trim().split(/\s+/).filter(Boolean);
      if (action === "menu") {
        await openPoolMenu(ctx, { readState: readPoolState, execute: (action: string, args: string[]) => handleAction(action, args, ctx) });
      } else await handleAction(action, rest, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "codex-pool-account") continue;
      const data = entry.data as { responseId?: unknown; accountKey?: unknown };
      if (typeof data.responseId === "string" && typeof data.accountKey === "string" && data.accountKey.length === 64) responseAccountKeys.set(data.responseId, data.accountKey);
    }
    await updateFooter(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    footer.shutdown(ctx);
    backgroundRequests.clear();
    if (refreshFooter) refreshFooter = undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== PROVIDER_ID || !event.message.responseId) return;
    const key = responseAccountKeys.get(event.message.responseId);
    if (key) pi.appendEntry("codex-pool-account", { responseId: event.message.responseId, accountKey: key });
  });
}
