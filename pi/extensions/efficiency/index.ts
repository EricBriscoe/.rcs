import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { effectiveRtk } from "./runtime.mjs";
import { filterFor, groupedGrep, quietTests, runFilter, saveRaw, originalOutput, sessionKey } from "./output.ts";
import { privateDirectory, recordUsage, recordOutput, usageReport, formatReport } from "./usage.ts";

export default function (pi: ExtensionAPI) {
  const agent = getAgentDir(), abort = new AbortController(), pending = new Set<Promise<any>>();
  const owner = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  let enabled = process.env.RTK_DISABLED !== "1", binary: string | undefined;
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
            if (!binary) {
              const source = dirname(realpathSync(join(agent, "settings.json")));
              const pins = effectiveRtk(dirname(source), agent);
              if (!/^\d+\.\d+\.\d+$/.test(pins.version)) return;
              binary = join(agent, "tooling", "rtk", pins.version, "rtk");
            }
            compact = await runFilter(binary, chosen, original.raw, join(agent, "efficiency", "rtk-home"), abort.signal);
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
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role === "assistant") recordUsage(agent, owner(ctx), "foreground", `${message.provider}/${message.model}`, message.usage);
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
  pi.on("session_shutdown", async () => { abort.abort(); await Promise.allSettled([...pending]); });
}
