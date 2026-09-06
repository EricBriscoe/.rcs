import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";

export function inside(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
export function resolvedTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(resolvedTarget(parent), relative(parent, path));
}

export default function worker(pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_question", label: "Ask task owner",
    description: "Ask the user a necessary question through the orchestrator. Wait for their actual reply; do not guess approvals. Only this task waits.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const answer = await ctx.ui.input("Task needs your input", params.question, { signal });
      if (!answer?.trim()) throw new Error("No answer was supplied. Do not assume approval.");
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  });
  pi.on("tool_call", (event, ctx) => {
    if (process.env.PI_TASK_READ_ONLY === "true" && ["bash", "edit", "write"].includes(event.toolName)) return { block: true, reason: "Scouts cannot execute shell commands or modify files." };
    if (process.env.PI_TASK_READ_ONLY === "true" && event.toolName === "web_browse" && ["click", "fill", "press"].includes(event.input.action)) return { block: true, reason: "Scouts may inspect public pages, not interact with forms or accounts." };
    if (!["read", "edit", "write", "grep", "find", "ls"].includes(event.toolName)) return;
    try {
      const path = resolvedTarget(resolve(ctx.cwd, typeof event.input.path === "string" ? event.input.path : "."));
      const writing = ["edit", "write"].includes(event.toolName);
      const roots = [realpathSync(ctx.cwd), ...(!writing ? JSON.parse(process.env.PI_TASK_READ_ROOTS || "[]") : [])];
      if (!roots.some((root: string) => inside(path, root))) return { block: true, reason: "That path is outside this task's assigned workspace and approved read roots." };
      if (writing && path.split("/").includes(".git")) return { block: true, reason: "Direct writes to Git internals are not allowed." };
    } catch { return { block: true, reason: "Cannot establish a safe task file path." }; }
  });
}
