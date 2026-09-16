import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";

/** Tool groups kept out of the prompt prefix until the model asks for them. */
export const GROUPS: Record<string, { tools: string[]; purpose: string }> = {
  delegation: {
    tools: ["subagent", "bg_wait", "subagent_supervisor"],
    purpose: "delegate work to subagents, wait on background runs, or answer a subagent supervisor request/notification",
  },
};

const RESTRICTION_FLAGS = ["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--exclude-tools", "-xt"];
/** Explicit CLI tool restrictions win; the loader then leaves the active set alone. */
export function restricted(args: string[]) {
  return args.some(arg => RESTRICTION_FLAGS.some(flag => arg === flag || arg.startsWith(flag + "=")));
}

export default function (pi: ExtensionAPI) {
  const names = Object.keys(GROUPS);
  const deferred = new Set(names.flatMap(name => GROUPS[name].tools));
  pi.registerTool({
    name: "load_tools", label: "Load tools", executionMode: "sequential",
    description: `Activate a deferred tool group for the rest of the session. Groups: ${names.map(name => `${name} (${GROUPS[name].tools.join(", ")}) to ${GROUPS[name].purpose}`).join("; ")}. Call it before using any of those tools; they stay unavailable until loaded.`,
    parameters: Type.Object({ group: StringEnum(names as [string, ...string[]]) }),
    async execute(_id, params) {
      const group = GROUPS[params.group];
      if (!group) throw new Error(`Unknown tool group "${params.group}". Known groups: ${names.join(", ")}.`);
      const active = pi.getActiveTools();
      const registered = new Set(pi.getAllTools().map(tool => tool.name));
      const loaded = group.tools.filter(name => !active.includes(name) && registered.has(name));
      if (loaded.length) pi.setActiveTools([...active, ...loaded]);
      const missing = group.tools.filter(name => !registered.has(name));
      const text = loaded.length
        ? `Activated ${loaded.join(", ")}; they are now callable.`
        : `Tools already active: ${group.tools.filter(name => registered.has(name)).join(", ") || "none"}.`;
      return { content: [{ type: "text", text: missing.length ? `${text} Not installed in this session: ${missing.join(", ")}.` : text }], details: { group: params.group, loaded, missing } };
    },
  });
  pi.on("session_start", () => {
    if (restricted(process.argv.slice(2))) return;
    const active = pi.getActiveTools();
    const next = [...new Set([...active.filter(name => !deferred.has(name)), "load_tools"])];
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
  });
}
