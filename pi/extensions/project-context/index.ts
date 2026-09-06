import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectInstructions } from "./context.ts";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const instructions = await projectInstructions(ctx.cwd);
    if (instructions) return { systemPrompt: `${event.systemPrompt}\n\n# Pi-specific project instructions (.pi/AGENTS.md)\n${instructions}` };
  });
}
