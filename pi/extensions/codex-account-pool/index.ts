import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getModels, openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  allExhaustedMessage, eligibleAccounts, isModelAccessError, isPoolAccountUnavailable, loginAndAdd,
  loginAndReplace, markExhausted, quotaResetAt, readPoolState, shouldFailover, resolveAccount,
  statusSummary, updatePoolState,
} from "./pool.mjs";
import { compactQuota, formatQuota, normalizeQuotaPayload, mergeQuotaHeaders } from "./quota.mjs";
import { createFooterController } from "./footer.mjs";
import { openPoolMenu, POOL_HELP } from "./menu.mjs";
import { completePoolArguments, loginWithRecovery } from "./auth-ui.mjs";

const PROVIDER_ID = "openai-codex";
const stockModels = getModels(PROVIDER_ID);
const stockAdapter = openAICodexResponsesApi();
const stockProvider = builtinProviders().find(provider => provider.id === PROVIDER_ID);
const officialOAuth = stockProvider?.auth.oauth;
const responseAccountKeys = new Map<string, string>();

type ResponseInfo = { status?: number; headers?: Record<string, string>; body?: string };
let refreshFooter: (() => void) | undefined;

function accountKey(accountId: string) {
  return createHash("sha256").update(accountId).digest("hex");
}

function safeAuthenticationError() {
  // Installed OAuth errors can include whole token responses. Never surface them.
  return "The saved Codex login could not be refreshed. Open /codex-pool, choose this account, then Sign in again. Browser and device-code login are available.";
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
    const candidates = eligibleAccounts(initial);
    if (candidates.length === 0) {
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
        if (isPoolAccountUnavailable(error)) continue;
        for await (const event of errorStream(model, safeAuthenticationError())) stream.push(event);
        stream.end();
        return;
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
          const result = await (options.fetch ?? globalThis.fetch)(input, init);
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
          if (event.type === "start") started = true;
          if (event.type === "done" && event.message.responseId) responseAccountKeys.set(event.message.responseId, accountKey(account.accountId));
          if (event.type !== "error" || started) {
            stream.push(event);
            if (event.type === "error" || event.type === "done") { stream.end(); return; }
            continue;
          }
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
          await markExhausted(account.accountId, quotaResetAt(response.body ?? "", response.headers));
          refreshFooter?.();
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
    lines.push(`${account.enabled ? "on" : "off"} ${account.label} — ${account.ready ? "login saved" : "quota cooldown"}${reset}; ${formatQuota(stored?.quota)}`);
  }
  if (summary.accounts.length === 0) lines.push("No accounts. Open /codex-pool to sign in.");
  return lines.join("\n");
}

async function loginAccount(label: string, method: string | undefined, ctx: any, replace = false) {
  if (!officialOAuth) throw new Error("OpenAI sign-in is unavailable in this Pi installation. Restart Pi and open /codex-pool.");
  return loginWithRecovery(ctx, { label, method, attempt: async (chosen: string) => {
    const controller = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    await (replace ? loginAndReplace : loginAndAdd)(label, () => officialOAuth.login({
      signal,
      async prompt(prompt: any) {
        if (prompt.type === "select") return chosen === "device" ? "device_code" : "browser";
        const input = await ctx.ui.input(prompt.message, prompt.placeholder ?? "Paste the complete redirect URL here if the browser does not finish automatically", { signal: prompt.signal ?? signal });
        if (input?.trim()) return input.trim();
        // Browser success closes only its fallback input; the OAuth callback owns completion.
        if (prompt.signal?.aborted) throw new Error("Login prompt closed");
        controller.abort();
        throw new Error("Login cancelled");
      },
      notify(event: any) {
        if (event.type === "auth_url") {
          const browser = spawn("open", [event.url], { detached: true, stdio: "ignore" });
          browser.once("error", () => ctx.ui.notify("Could not open your browser. Cancel this attempt and choose device-code login.", "warning"));
          browser.unref();
          ctx.ui.notify(`Finish signing into ${label} in the browser. Keep Pi open; it will continue automatically. If needed, paste the complete redirect URL into the login field.`, "info");
        } else if (event.type === "device_code") {
          ctx.ui.notify(`Open ${event.verificationUri} and enter code ${event.userCode}. Keep Pi open until sign-in completes.`, "info");
        } else if (event.type === "progress") ctx.ui.notify(event.message, "info");
      },
    }));
  } });
}

export default async function (pi: ExtensionAPI) {
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
    const completed = await completePoolArguments(action, rest, ctx, readPoolState);
    if (!completed) return false;
    rest = completed;
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
      if (!await loginAccount(label, rest[1], ctx)) return false;
      await updateFooter(ctx);
      ctx.ui.notify(`Added Codex account ${label}. Open /codex-pool to manage accounts and enable the pool.`, "info");
      return;
    }
    if (action === "relogin") {
      if (!label) throw new Error("Usage: /codex-pool relogin NAME [browser|device]");
      if (!await loginAccount(label, rest[1], ctx, true)) return false;
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
          account.enabled = action === "enable";
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
      ctx.ui.notify(label ? `${label} ${action === "enable" ? "enabled" : "disabled"}. Open /codex-pool to manage accounts.` : action === "enable"
        ? `Codex pool enabled${ctx.model?.provider === PROVIDER_ID ? ` · ${ctx.model.id}` : ""}. Open /codex-pool for accounts and quota.`
        : "Codex pool disabled. Ordinary Pi sign-in is now in use; saved pool accounts are kept.", "info");
      return;
    }
    if (action === "priority") {
      const position = Number(rest[1]);
      if (!label || !Number.isInteger(position) || position < 1) throw new Error("Usage: /codex-pool priority NAME POSITION");
      await updatePoolState(state => {
        const index = state.accounts.findIndex(candidate => candidate.label === label);
        if (index < 0) throw new Error(`No Codex account named ${label}.`);
        const [account] = state.accounts.splice(index, 1);
        state.accounts.splice(Math.min(position - 1, state.accounts.length), 0, account);
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
      try {
        if (action === "menu") {
          await openPoolMenu(ctx, { readState: readPoolState, execute: (action: string, args: string[]) => handleAction(action, args, ctx) });
        } else await handleAction(action, rest, ctx);
      } catch (error) {
        if (ctx.signal?.aborted) return;
        ctx.ui.notify(error instanceof Error ? error.message : "Could not update accounts. Open /codex-pool to try again.", "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "codex-pool-account") continue;
      const data = entry.data as { responseId?: unknown; accountKey?: unknown };
      if (typeof data.responseId === "string" && typeof data.accountKey === "string" && data.accountKey.length === 64) responseAccountKeys.set(data.responseId, data.accountKey);
    }
    await updateFooter(ctx);
    const state = await readPoolState();
    if ((!ctx.model || ctx.model.provider === "unknown") && !state.enabled && state.accounts.length) {
      ctx.ui.notify("Your Codex login is saved, but the pool is disabled. Open /codex-pool and choose Enable pool to use it; signing in again is not required just to enable it.", "info");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    footer.shutdown(ctx);
    if (refreshFooter) refreshFooter = undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== PROVIDER_ID || !event.message.responseId) return;
    const key = responseAccountKeys.get(event.message.responseId);
    if (key) pi.appendEntry("codex-pool-account", { responseId: event.message.responseId, accountKey: key });
  });
}
