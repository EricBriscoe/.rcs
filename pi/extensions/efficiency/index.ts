import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { effectiveRtk } from "./runtime.mjs";
import { gainRecorder } from "./gain.ts";
import { filterFor, groupedGrep, quietTests, runFilter, saveRaw, originalOutput, sessionKey } from "./output.ts";
import { privateDirectory, recordUsage, recordOutput, usageReport, formatReport } from "./usage.ts";
import { fingerprintRequest, diagnoseCacheDrop, isCacheDrop, type RequestFingerprint } from "./cache.ts";
import { idleCompactionDecision, idleCompactionSettings } from "./idle.ts";
import { pinInstructions } from "./pin.ts";
import { externalUsageDelta, summarizerModel, nonNegativeTotal, type ExternalUsageTotals } from "./external.ts";
import { readFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const agent = getAgentDir(), abort = new AbortController(), pending = new Set<Promise<any>>();
  const owner = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  let enabled = process.env.RTK_DISABLED !== "1", binary: string | undefined, gainWarned = false;
  const rtkBinary = () => {
    if (!binary) {
      const checkout = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..");
      const pins = effectiveRtk(checkout, agent);
      if (!/^\d+\.\d+\.\d+$/.test(pins.version)) throw Error("Invalid RTK version");
      binary = join(agent, "tooling", "rtk", pins.version, "rtk");
    }
    return binary;
  };
  const recordGain = gainRecorder(rtkBinary);
  async function reduce(event: any, ctx: ExtensionContext): Promise<Pick<ToolResultEvent, "content" | "details"> | undefined> {
    const before = event.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    let shown = before, filter = "raw";
    try {
      if (!enabled || event.isError || event.content.some((p: any) => p.type !== "text") || abort.signal.aborted || !ctx.isProjectTrusted()) return;
      privateDirectory(join(agent, "efficiency"));
      const original = await originalOutput(event);
      if (!original || original.raw.length < 500) return;
      let compact: string | undefined;
      if (event.toolName === "grep") {
        if (event.input.context || event.details?.matchLimitReached || event.details?.linesTruncated || event.details?.truncation?.truncated) return;
        compact = groupedGrep(original.raw);
        filter = "grouped-grep";
      } else {
        const command = event.input.command;
        compact = quietTests(command, original.raw);
        if (compact) filter = "passing-tests";
        else {
          const chosen = filterFor(command, original.raw);
          if (!chosen) return;
          if (chosen === "grep") {
            compact = groupedGrep(original.raw);
            filter = "grouped-grep";
          } else {
            compact = await runFilter(rtkBinary(), chosen, original.raw, join(agent, "efficiency", "rtk-home"), abort.signal);
            filter = `rtk:${chosen}`;
          }
        }
      }
      // Include recovery metadata in the savings comparison, not just the compressed body.
      if (!compact?.trim() || Buffer.byteLength(compact) + 300 >= Buffer.byteLength(before)) { filter = "raw"; return; }
      abort.signal.throwIfAborted();
      const directory = join(agent, "efficiency", "output", sessionKey(owner(ctx)));
      privateDirectory(join(agent, "efficiency", "output"));
      const path = await saveRaw(directory, original.raw);
      shown = `${compact}\n[Reduced: ${filter}. Raw output: ${path}]`;
      if (Buffer.byteLength(shown) >= Buffer.byteLength(before) || abort.signal.aborted) { await rm(path).catch(() => {}); shown = before; filter = "raw"; return; }
      const tracked = await recordGain(filter, Buffer.byteLength(before), Buffer.byteLength(shown), ctx.cwd, abort.signal);
      if (!tracked && !gainWarned && !abort.signal.aborted) {
        gainWarned = true;
        try {
          pi.appendEntry("rtk-gain-unavailable", { filter });
          if (ctx.hasUI) ctx.ui.notify("RTK gain tracking unavailable; reductions still work. Check RTK config/database access, then /reload.", "warning");
        } catch { /* Diagnostics must not discard a successful reduction either. */ }
      }
      return { content: [{ type: "text", text: shown }], details: { ...event.details, fullOutputPath: path, reduction: filter } };
    } catch { shown = before; filter = "raw"; } // Never rerun the original command.
    finally { recordOutput(agent, owner(ctx), shown === before ? "raw" : filter, Buffer.byteLength(before), Buffer.byteLength(shown)); }
  }
  pi.on("session_start", () => { enabled = process.env.RTK_DISABLED !== "1"; });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "grep") return;
    const promise = reduce(event, ctx); pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  });
  // Cache diagnostics: explain a prompt-cache drop by what changed in the request that hit it.
  let lastFingerprint: RequestFingerprint | undefined, pendingFingerprint: RequestFingerprint | undefined, lastContext = 0, lastSentAt = 0, pendingSentAt = 0;
  // Prompt pinning (see pin.ts): a prompt produced by before_agent_start is the reference; a
  // mid-run prompt that is the reference minus its tail lost extension additions, so restore it.
  let referenceInstructions: string | undefined, promptFresh = false;
  pi.on("before_agent_start", () => { promptFresh = true; });
  pi.on("before_provider_request", (event) => {
    let payload = event.payload;
    try {
      if (typeof payload?.instructions === "string") {
        const pinned = pinInstructions({ fresh: promptFresh, reference: referenceInstructions, current: payload.instructions });
        promptFresh = false;
        referenceInstructions = pinned.instructions;
        if (pinned.restored) {
          payload = { ...payload, instructions: pinned.instructions };
          pi.appendEntry("cache-prompt-restored", { restoredChars: pinned.instructions.length - event.payload.instructions.length });
        }
      }
      pendingFingerprint = fingerprintRequest(payload); pendingSentAt = Date.now();
    } catch { pendingFingerprint = undefined; }
    return payload === event.payload ? undefined : payload;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    recordUsage(agent, owner(ctx), "foreground", `${message.provider}/${message.model}`, message.usage);
    const usage = message.usage ?? {}, cacheRead = usage.cacheRead ?? 0, context = (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
    if (pendingFingerprint && lastFingerprint && isCacheDrop({ previousContext: lastContext, cacheRead })) {
      const diagnosis = diagnoseCacheDrop(lastFingerprint, pendingFingerprint, { gapMs: Math.max(0, pendingSentAt - lastSentAt) });
      if (idleCompactedAt > lastSentAt) diagnosis.summary += " (expected: idle compaction ran while the cache was cold)";
      const rebilled = Math.max(0, (usage.input ?? 0) - Math.max(0, context - lastContext));
      pi.appendEntry("cache-diagnostic", { ...diagnosis, cacheRead, previousContext: lastContext, context, rebilledTokens: rebilled });
      if (ctx.hasUI) ctx.ui.notify(`Cache drop (~${Math.round(rebilled / 1000)}K tokens re-read): ${diagnosis.summary}`, "warning");
    }
    if (pendingFingerprint) { lastFingerprint = pendingFingerprint; lastSentAt = pendingSentAt; pendingFingerprint = undefined; }
    if (context > 0) lastContext = context;
  });
  // Idle compaction: when the provider cache has expired, run pi-condense chain compaction
  // so the unavoidable re-read, and every request after it, is smaller.
  let idleTimer: ReturnType<typeof setTimeout> | undefined, idleCompactedAt = 0;
  const idleSettings = () => { try { return idleCompactionSettings(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))); } catch { return idleCompactionSettings({}); } };
  const cancelIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
  pi.on("agent_start", cancelIdle);
  pi.on("agent_settled", (_event, ctx) => {
    cancelIdle();
    const settings = idleSettings();
    if (!settings.enabled || abort.signal.aborted) return;
    const settledAt = Date.now();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (abort.signal.aborted) return;
      const decision = idleCompactionDecision({
        idleMs: Date.now() - settledAt, thresholdMs: settings.thresholdMs, minTokens: settings.minTokens,
        tokens: ctx.getContextUsage()?.tokens, agentIdle: ctx.isIdle(), pendingMessages: ctx.hasPendingMessages(),
        prunerAvailable: pi.getCommands().some(command => command.name === "pruner"),
      });
      if (!decision.compact) return;
      idleCompactedAt = Date.now();
      pi.appendEntry("cache-idle-compact", { reason: decision.reason, tokens: ctx.getContextUsage()?.tokens ?? null });
      if (ctx.hasUI) ctx.ui.notify(`Idle compaction: ${decision.reason}`, "info");
      pi.sendUserMessage("/pruner compact", { expandPromptTemplates: true });
    }, settings.thresholdMs);
    idleTimer.unref?.();
  });
  pi.on("session_compact", (event, ctx) => recordUsage(agent, owner(ctx), "compaction", `${ctx.model?.provider}/${ctx.model?.id}`, event.compactionEntry.usage, `compact:${event.compactionEntry.id}`));
  pi.on("session_tree", (event, ctx) => {
    if (event.summaryEntry) recordUsage(agent, owner(ctx), "branch-summary", `${ctx.model?.provider}/${ctx.model?.id}`, event.summaryEntry.usage, `branch:${event.summaryEntry.id}`);
  });
  pi.registerCommand("tokens", {
    description: "Session token usage and output reductions; /tokens all for lifetime totals",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "all") { ctx.ui.notify("Use /tokens [all]", "warning"); return; }
      ctx.ui.notify(formatReport(usageReport(agent, args.trim() === "all" ? undefined : owner(ctx))), "info");
    },
  });
  pi.registerCommand("output", {
    description: "Bash/search output mode: /output auto or /output raw (this session)",
    handler: async (args, ctx) => {
      if (args.trim() === "auto") enabled = true;
      else if (args.trim() === "raw") enabled = false;
      else if (args.trim()) { ctx.ui.notify("Use /output [auto|raw]", "warning"); return; }
      ctx.ui.notify(`Bash/search output: ${enabled ? "auto (RTK/quiet tests/grouped grep, raw fallback)" : "raw"}.`, "info");
    },
  });
  // External usage (see external.ts): pi-condense publishes cumulative summarizer cost on the
  // extension event bus; persist per-flush deltas so transcript readers can count them.
  const externalTotals = new Map<string, ExternalUsageTotals>();
  let sessionModel: { provider?: string; id?: string } | undefined;
  pi.on("session_start", (_event, ctx) => { externalTotals.clear(); sessionModel = ctx.model ?? undefined; });
  pi.on("model_select", (event: any) => { if (event?.model) sessionModel = event.model; });
  pi.events.on("cost:external", (update: any) => {
    const source = typeof update?.source === "string" ? update.source : "unknown";
    const delta = externalUsageDelta(externalTotals.get(source), update ?? {});
    externalTotals.set(source, { input: nonNegativeTotal(update?.inputTokens), output: nonNegativeTotal(update?.outputTokens), cost: nonNegativeTotal(update?.totalCost) });
    if (delta.input + delta.output === 0) return;
    let settings: any = {};
    try { settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")); } catch { /* defaults */ }
    const { provider, model } = summarizerModel(settings, sessionModel);
    pi.appendEntry("external-usage", { source, provider, model, usage: { input: delta.input, output: delta.output, cacheRead: 0, cacheWrite: 0, cost: delta.cost } });
  });
  pi.on("session_shutdown", async () => { cancelIdle(); abort.abort(); await Promise.allSettled([...pending]); });
}
